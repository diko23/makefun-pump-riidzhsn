import {
  BPS,
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type Curve,
  type OrderInput,
  type Pubkey,
  type SellInput,
  type TradeEventRecord,
} from './vendor/makefun-bot.ts';

type EntryTier = 'core' | 'breadth' | 'probe';

interface TradeSample {
  slot: number;
  isBuy: boolean;
  quoteLamports: bigint;
}

interface MintTracker {
  firstSlot: number;
  createdSlot: number | null;
  creator: Pubkey | null;
  creatorSold: boolean;
  totalBuys: number;
  totalBuyQuote: bigint;
  maxUserBuyQuote: bigint;
  userBuyQuote: Map<Pubkey, bigint>;
  recentTrades: TradeSample[];
  recentBuys: number;
  recentBuyQuote: bigint;
  recentSellQuote: bigint;
  lastSlotBuyQuote: bigint;
  lastTradeSlot: number;
  lastTradeIsBuy: boolean;
  peakRealQuote: bigint;
  peakPriceScaled: bigint;
}

interface PositionTracker {
  tier: EntryTier;
  entrySlot: number;
  peakReturnBps: number;
  sellRejects: number;
}

const PRICE_SCALE = 1_000_000_000_000n;
const RECENT_WINDOW_SLOTS = 40;
const MIN_BUY_AMOUNT_LAMPORTS = 12_000_000n; // Safely clears 0.01 SOL guardrail
const GUARDRAIL_TARGET_MINTS = 22;

// Core tier: creator clean + distributed buyers + healthy pullback + active buyer reclaim
const CORE_MIN_PEAK_REAL = 12n * LAMPORTS_PER_SOL;
const CORE_MIN_CURR_REAL = 6n * LAMPORTS_PER_SOL;
const CORE_MIN_BUYERS = 20;
const CORE_MAX_USER_SHARE_BPS = 2500n; // Max single buyer <= 25% of buy volume
const CORE_MAX_PEAK_PCT = 78n; // >= 22% pullback from peak
const CORE_MIN_PEAK_PCT = 58n; // <= 42% pullback from peak
const CORE_ALLOC_BPS = 800n; // 8% of free cash, capped by 1% reserve limit
const CORE_MAX_STAKE = 600_000_000n;

// Breadth tier: high retail buyer density per SOL of reserve during pullback reclaim
const BREADTH_MIN_PEAK_REAL = 10n * LAMPORTS_PER_SOL;
const BREADTH_MIN_CURR_REAL = 5n * LAMPORTS_PER_SOL;
const BREADTH_MIN_BUYERS = 20;
const BREADTH_MIN_BUYERS_PER_SOL_X10 = 22n; // >= 2.2 unique buyers per 1 SOL of real reserve
const BREADTH_MAX_PEAK_PCT = 78n;
const BREADTH_MIN_PEAK_PCT = 55n;
const BREADTH_ALLOC_BPS = 50n; // 0.5% of free cash
const BREADTH_MAX_STAKE = 20_000_000n;

// Emergency breadth safeguard only if filled distinct mints remain below target
const PROBE_MIN_PEAK_REAL = 7n * LAMPORTS_PER_SOL;
const PROBE_MIN_CURR_REAL = 3n * LAMPORTS_PER_SOL;
const PROBE_MIN_BUYERS = 15;
const PROBE_STAKE = 12_000_000n;

const ENTRY_SLIPPAGE_BPS = 600;
const TP_SLIPPAGE_BPS = 1000;
const STOP_SLIPPAGE_BPS = 3000;

class DipReclaimBot {
  readonly #mints = new Map<Pubkey, MintTracker>();
  readonly #positions = new Map<Pubkey, PositionTracker>();
  readonly #attemptedMints = new Set<Pubkey>();
  readonly #pendingEntryTier = new Map<Pubkey, EntryTier>();
  readonly #filledBuyMints = new Set<Pubkey>();
  readonly #cooldownUntilSlot = new Map<Pubkey, number>();
  #protocolFeeBps = 95n;
  #creatorFeeBps = 30n;
  #txFeeLamports = 105_000n;

  onHello(state: BotState): void {
    this.#protocolFeeBps = BigInt(state.hello.fees.protocol_bps_fallback);
    this.#creatorFeeBps = BigInt(state.hello.fees.creator_bps_fallback);
    this.#txFeeLamports = state.txFeeLamports();
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.#ingestFills(state, batch);
    this.#ingestEvents(batch);
    this.#pruneMints(state, batch.slot);

    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;

    const pendingSellMints = new Set<Pubkey>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') {
        pendingSellMints.add(pending.order.mint);
      }
    }

    // 1. Evaluate exits on open holdings first so stops and profit targets execute promptly.
    for (const [mint, holding] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (pendingSellMints.has(mint)) continue;

      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;

      const tracker = this.#positions.get(mint) ?? {
        tier: 'breadth' as EntryTier,
        entrySlot: batch.slot,
        peakReturnBps: 0,
        sellRejects: 0,
      };

      const estNet = this.#estimateSellNetLamports(curve, holding.token_amount);
      const returnBps = this.#computeReturnBps(estNet, holding.cost_lamports);
      if (returnBps > tracker.peakReturnBps) {
        tracker.peakReturnBps = returnBps;
      }
      this.#positions.set(mint, tracker);

      const exit = this.#evaluateExit(batch.slot, tracker, returnBps, holding.token_amount);
      if (exit !== null) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: exit.amount,
          max_slippage_bps: exit.slippageBps,
        } satisfies SellInput);
      }
    }

    // 2. Scan for qualifying dip-reclaim entries within position and reserve caps.
    let committedPositions = state.committedPositionCount();
    const maxPositions = state.hello.caps.max_open_positions;
    if (committedPositions < maxPositions && orders.length < maxOrders) {
      const candidates = this.#rankCandidates(state, batch.slot, committedPositions);
      let freeCash = state.freeCashLamports();

      for (const candidate of candidates) {
        if (committedPositions >= maxPositions || orders.length >= maxOrders) break;

        const maxAllowed = (state.maxBuyLamports(candidate.mint) * 98n) / 100n;
        if (maxAllowed < MIN_BUY_AMOUNT_LAMPORTS) continue;

        let desiredStake = this.#desiredStake(candidate.tier, freeCash);
        if (desiredStake < MIN_BUY_AMOUNT_LAMPORTS) desiredStake = MIN_BUY_AMOUNT_LAMPORTS;

        const orderLamports = desiredStake < maxAllowed ? desiredStake : maxAllowed;
        if (orderLamports < MIN_BUY_AMOUNT_LAMPORTS) continue;
        if (freeCash < orderLamports + this.#txFeeLamports) continue;

        orders.push({
          side: 'buy',
          mint: candidate.mint,
          quote_lamports: orderLamports,
          max_slippage_bps: ENTRY_SLIPPAGE_BPS,
        } satisfies BuyInput);

        this.#attemptedMints.add(candidate.mint);
        this.#pendingEntryTier.set(candidate.mint, candidate.tier);
        freeCash -= orderLamports + this.#txFeeLamports;
        committedPositions += 1;
      }
    }

    return orders;
  }

  #ingestFills(state: BotState, batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.side === 'buy') {
        const tier = this.#pendingEntryTier.get(fill.mint) ?? 'breadth';
        this.#pendingEntryTier.delete(fill.mint);
        if (fill.status === 'filled') {
          this.#filledBuyMints.add(fill.mint);
          if (!this.#positions.has(fill.mint)) {
            this.#positions.set(fill.mint, {
              tier,
              entrySlot: fill.slot,
              peakReturnBps: 0,
              sellRejects: 0,
            });
          }
        } else if (fill.status === 'failed') {
          this.#attemptedMints.delete(fill.mint);
          this.#cooldownUntilSlot.set(fill.mint, batch.slot + 8);
        }
      } else if (fill.side === 'sell' && fill.status === 'rejected') {
        const pos = this.#positions.get(fill.mint);
        if (pos !== undefined) {
          pos.sellRejects += 1;
        }
      }
    }

    for (const mint of this.#positions.keys()) {
      if (!state.positions.has(mint)) {
        this.#positions.delete(mint);
      }
    }
  }

  #ingestEvents(batch: Batch): void {
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        const initPrice = this.#scaledPrice(
          BigInt(event.virtual_quote_reserves),
          BigInt(event.virtual_token_reserves),
        );
        this.#mints.set(event.mint, {
          firstSlot: event.slot,
          createdSlot: event.slot,
          creator: event.creator,
          creatorSold: false,
          totalBuys: 0,
          totalBuyQuote: 0n,
          maxUserBuyQuote: 0n,
          userBuyQuote: new Map<Pubkey, bigint>(),
          recentTrades: [],
          recentBuys: 0,
          recentBuyQuote: 0n,
          recentSellQuote: 0n,
          lastSlotBuyQuote: 0n,
          lastTradeSlot: event.slot,
          lastTradeIsBuy: false,
          peakRealQuote: 0n,
          peakPriceScaled: initPrice,
        });
      } else if (event.event === 'TradeEvent') {
        this.#recordTrade(event, batch.slot);
      } else if (event.event === 'CompleteEvent') {
        this.#mints.delete(event.mint);
      }
    }
  }

  #recordTrade(event: TradeEventRecord, batchSlot: number): void {
    const vQuote = BigInt(event.virtual_quote_reserves);
    const vToken = BigInt(event.virtual_token_reserves);
    const rQuote = BigInt(event.real_quote_reserves);
    const priceScaled = this.#scaledPrice(vQuote, vToken);

    let tracker = this.#mints.get(event.mint);
    if (tracker === undefined) {
      tracker = {
        firstSlot: event.slot,
        createdSlot: null,
        creator: event.creator,
        creatorSold: false,
        totalBuys: 0,
        totalBuyQuote: 0n,
        maxUserBuyQuote: 0n,
        userBuyQuote: new Map<Pubkey, bigint>(),
        recentTrades: [],
        recentBuys: 0,
        recentBuyQuote: 0n,
        recentSellQuote: 0n,
        lastSlotBuyQuote: 0n,
        lastTradeSlot: event.slot,
        lastTradeIsBuy: event.is_buy,
        peakRealQuote: rQuote,
        peakPriceScaled: priceScaled,
      };
      this.#mints.set(event.mint, tracker);
    } else if (tracker.creator === null) {
      tracker.creator = event.creator;
    }

    if (rQuote > tracker.peakRealQuote) tracker.peakRealQuote = rQuote;
    if (priceScaled > tracker.peakPriceScaled) tracker.peakPriceScaled = priceScaled;

    const quoteAmt = BigInt(event.quote_amount);
    if (tracker.lastTradeSlot !== event.slot) {
      tracker.lastSlotBuyQuote = 0n;
      tracker.lastTradeSlot = event.slot;
    }
    tracker.lastTradeIsBuy = event.is_buy;

    if (event.is_buy) {
      tracker.totalBuys += 1;
      tracker.totalBuyQuote += quoteAmt;
      const prevUser = tracker.userBuyQuote.get(event.user) ?? 0n;
      const nextUser = prevUser + quoteAmt;
      if (tracker.userBuyQuote.has(event.user) || tracker.userBuyQuote.size < 256) {
        tracker.userBuyQuote.set(event.user, nextUser);
      }
      if (nextUser > tracker.maxUserBuyQuote) {
        tracker.maxUserBuyQuote = nextUser;
      }
      tracker.recentBuys += 1;
      tracker.recentBuyQuote += quoteAmt;
      tracker.lastSlotBuyQuote += quoteAmt;
    } else {
      if (tracker.creator !== null && event.user === tracker.creator) {
        tracker.creatorSold = true;
      }
      tracker.recentSellQuote += quoteAmt;
    }

    tracker.recentTrades.push({
      slot: event.slot,
      isBuy: event.is_buy,
      quoteLamports: quoteAmt,
    });

    const cutoff = batchSlot - RECENT_WINDOW_SLOTS;
    while (tracker.recentTrades.length > 0 && tracker.recentTrades[0].slot < cutoff) {
      const old = tracker.recentTrades.shift()!;
      if (old.isBuy) {
        tracker.recentBuys -= 1;
        tracker.recentBuyQuote -= old.quoteLamports;
      } else {
        tracker.recentSellQuote -= old.quoteLamports;
      }
    }
  }

  #pruneMints(state: BotState, slot: number): void {
    const cutoff = slot - RECENT_WINDOW_SLOTS;
    for (const [mint, tracker] of this.#mints) {
      while (tracker.recentTrades.length > 0 && tracker.recentTrades[0].slot < cutoff) {
        const old = tracker.recentTrades.shift()!;
        if (old.isBuy) {
          tracker.recentBuys -= 1;
          tracker.recentBuyQuote -= old.quoteLamports;
        } else {
          tracker.recentSellQuote -= old.quoteLamports;
        }
      }
      if (!state.positions.has(mint) && slot - tracker.lastTradeSlot > 2500) {
        this.#mints.delete(mint);
      }
    }
  }

  #rankCandidates(
    state: BotState,
    slot: number,
    committedPositions: number,
  ): Array<{ mint: Pubkey; tier: EntryTier; score: bigint }> {
    const pendingBuyMints = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuyMints.add(p.order.mint);
    }

    const needProbe =
      this.#filledBuyMints.size + pendingBuyMints.size < GUARDRAIL_TARGET_MINTS &&
      committedPositions < 2;

    const primary: Array<{ mint: Pubkey; tier: EntryTier; score: bigint }> = [];
    const probes: Array<{ mint: Pubkey; tier: EntryTier; score: bigint }> = [];

    for (const [mint, tracker] of this.#mints) {
      if (this.#attemptedMints.has(mint)) continue;
      if (state.positions.has(mint) || pendingBuyMints.has(mint)) continue;

      const cooldown = this.#cooldownUntilSlot.get(mint);
      if (cooldown !== undefined && slot < cooldown) continue;

      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (!tracker.lastTradeIsBuy) continue;

      const currPrice = this.#scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (currPrice <= 0n || tracker.peakPriceScaled <= 0n) continue;
      if (tracker.lastSlotBuyQuote * 4n > curve.real_quote_reserves && curve.real_quote_reserves > 0n) {
        continue;
      }

      const buyerCount = tracker.userBuyQuote.size;
      const hasActiveReclaim =
        tracker.recentBuys >= 3 && tracker.recentBuyQuote * 5n > tracker.recentSellQuote * 6n;

      // Tier 1: Core Dip Reclaim (creator clean + distributed buyers)
      if (
        !tracker.creatorSold &&
        tracker.peakRealQuote >= CORE_MIN_PEAK_REAL &&
        curve.real_quote_reserves >= CORE_MIN_CURR_REAL &&
        buyerCount >= CORE_MIN_BUYERS &&
        tracker.totalBuyQuote > 0n &&
        tracker.maxUserBuyQuote * BPS <= tracker.totalBuyQuote * CORE_MAX_USER_SHARE_BPS &&
        currPrice * 100n <= tracker.peakPriceScaled * CORE_MAX_PEAK_PCT &&
        currPrice * 100n >= tracker.peakPriceScaled * CORE_MIN_PEAK_PCT &&
        hasActiveReclaim
      ) {
        primary.push({
          mint,
          tier: 'core',
          score: 1_000_000_000_000n + curve.real_quote_reserves,
        });
        continue;
      }

      // Tier 2: Breadth Dip Reclaim (high retail buyer density per SOL)
      const buyersX10PerSol =
        curve.real_quote_reserves > 0n
          ? (BigInt(buyerCount) * 10n * LAMPORTS_PER_SOL) / curve.real_quote_reserves
          : 0n;
      if (
        tracker.peakRealQuote >= BREADTH_MIN_PEAK_REAL &&
        curve.real_quote_reserves >= BREADTH_MIN_CURR_REAL &&
        buyerCount >= BREADTH_MIN_BUYERS &&
        buyersX10PerSol >= BREADTH_MIN_BUYERS_PER_SOL_X10 &&
        currPrice * 100n <= tracker.peakPriceScaled * BREADTH_MAX_PEAK_PCT &&
        currPrice * 100n >= tracker.peakPriceScaled * BREADTH_MIN_PEAK_PCT &&
        hasActiveReclaim
      ) {
        primary.push({
          mint,
          tier: 'breadth',
          score: curve.real_quote_reserves,
        });
        continue;
      }

      // Tier 3: Guardrail probe fallback only while distinct mints are still low
      if (
        needProbe &&
        committedPositions === 0 &&
        tracker.peakRealQuote >= PROBE_MIN_PEAK_REAL &&
        curve.real_quote_reserves >= PROBE_MIN_CURR_REAL &&
        buyerCount >= PROBE_MIN_BUYERS &&
        currPrice * 100n <= tracker.peakPriceScaled * 75n &&
        currPrice * 100n >= tracker.peakPriceScaled * 55n &&
        hasActiveReclaim
      ) {
        probes.push({
          mint,
          tier: 'probe',
          score: tracker.recentBuyQuote - tracker.recentSellQuote,
        });
      }
    }

    primary.sort((a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : a.mint.localeCompare(b.mint)));
    if (primary.length > 0) return primary;

    probes.sort((a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : a.mint.localeCompare(b.mint)));
    return probes.slice(0, 1);
  }

  #desiredStake(tier: EntryTier, freeCash: bigint): bigint {
    if (tier === 'probe') return PROBE_STAKE;
    if (tier === 'core') {
      const raw = (freeCash * CORE_ALLOC_BPS) / BPS;
      return raw < CORE_MAX_STAKE ? raw : CORE_MAX_STAKE;
    }
    const raw = (freeCash * BREADTH_ALLOC_BPS) / BPS;
    return raw < BREADTH_MAX_STAKE ? raw : BREADTH_MAX_STAKE;
  }

  #evaluateExit(
    slot: number,
    tracker: PositionTracker,
    returnBps: number,
    tokenAmount: bigint,
  ): { amount: bigint; slippageBps: number } | null {
    if (tokenAmount <= 0n) return null;

    const urgentSlippage =
      tracker.sellRejects === 0
        ? STOP_SLIPPAGE_BPS
        : tracker.sellRejects === 1
          ? 6000
          : 10000;
    const normalSlippage = tracker.sellRejects > 0 ? urgentSlippage : TP_SLIPPAGE_BPS;

    if (returnBps <= -1350) {
      return { amount: tokenAmount, slippageBps: urgentSlippage };
    }

    if (tracker.tier === 'core') {
      if (returnBps >= 3600) {
        return { amount: tokenAmount, slippageBps: normalSlippage };
      }
      if (tracker.peakReturnBps >= 2600 && returnBps <= tracker.peakReturnBps - 1100) {
        return { amount: tokenAmount, slippageBps: urgentSlippage };
      }
      if (slot - tracker.entrySlot >= 950) {
        return { amount: tokenAmount, slippageBps: urgentSlippage };
      }
      return null;
    }

    if (returnBps >= 3400) {
      return { amount: tokenAmount, slippageBps: normalSlippage };
    }

    if (slot - tracker.entrySlot >= 950) {
      return { amount: tokenAmount, slippageBps: urgentSlippage };
    }

    return null;
  }

  #scaledPrice(virtualQuote: bigint, virtualToken: bigint): bigint {
    if (virtualQuote <= 0n || virtualToken <= 0n) return 0n;
    return (virtualQuote * PRICE_SCALE) / virtualToken;
  }

  #estimateSellNetLamports(curve: Curve, tokenAmount: bigint): bigint {
    if (tokenAmount <= 0n || curve.virtual_token_reserves <= 0n || curve.virtual_quote_reserves <= 0n) {
      return 0n;
    }
    const grossOut =
      (curve.virtual_quote_reserves * tokenAmount) / (curve.virtual_token_reserves + tokenAmount);
    const totalFeeBps = this.#protocolFeeBps + this.#creatorFeeBps;
    const afterCurveFee = (grossOut * (BPS - totalFeeBps)) / BPS;
    return afterCurveFee > this.#txFeeLamports ? afterCurveFee - this.#txFeeLamports : 0n;
  }

  #computeReturnBps(netValueLamports: bigint, costLamports: bigint): number {
    if (costLamports <= 0n) return 0;
    return Number(((netValueLamports - costLamports) * BPS) / costLamports);
  }
}

const strategy = new DipReclaimBot();

await runBot({
  onHello(state) {
    strategy.onHello(state);
  },
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
});
