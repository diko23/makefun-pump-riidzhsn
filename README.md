# makefun-pump-riidzhsn

[![make.fun competition](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/diko23/makefun-pump-riidzhsn/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/diko23/makefun-pump-riidzhsn/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Deterministic `agent-fun/replay/v2` paper-trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) competition on make.fun.

## Strategy

`main.ts` implements `DipReclaimBot`, a deterministic multi-tier pullback-reclaim strategy built on `./vendor/makefun-bot.ts`:

- **Core Tier (Creator-Clean Distributed Dip Reclaim)**: Enters coins whose bonding curves reached at least 12 SOL real quote reserves and still hold at least 6 SOL, with `>= 20` unique buyers, no single buyer exceeding 25% of buy volume, no creator sell observed, a 22%–42% pullback from peak price, and positive net buy flow over the trailing 40 slots (`>= 3` buys, buy volume `> 1.2x` sell volume). Sized up to 8% of free cash (capped at 0.60 SOL and 98% of the 100 bps real-reserve limit).
- **Breadth Tier (Retail-Density Dip Reclaim)**: Enters pullbacks (22%–45% off peak, `>= 10` SOL peak, `>= 5` SOL current) with `>= 20` unique buyers and retail density `>= 2.2` unique buyers per SOL of real reserve, sized conservatively (up to 0.02 SOL) to maintain wide coin coverage above the 20-mint guardrail with low fee drag.
- **Breadth Safeguard Probe**: Only activates with `0.012 SOL` micro-entries when fewer than 22 distinct mints have been traded and no open positions are held.
- **Risk & Exit Management**: Enforces a `-13.5%` net-of-fee stop-loss, `+36%` (`core`) / `+34%` (`breadth`/`probe`) net take-profit, `+26%` peak trailing stop (`11%` trail drop) on `core` holdings, `950`-slot time-stop, and progressive slippage escalation on rejected sells so exits never stall.
- **Determinism**: Uses only `hello` and `batch` stream state (`slot`, `events`, `marks`, `fills`, `account`) with zero clock, environment, or `Math.random` usage.

## Run it

Zero dependencies, erasable TypeScript only (Node 22.18+ / 24+):

```bash
node main.ts
```

The bot reads `agent-fun/replay/v2` NDJSON messages (`hello`, `batch`, `done`) on `stdin` and writes replies to `stdout`.
