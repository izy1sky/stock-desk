---
name: analyze
description: Data-driven read on a US stock, ETF or index from the stock-desk engine — trend (moving-average stack, ADX, structure, weekly), volatility (realized vs implied, squeeze, expected move), volume and positioning (OBV, distribution days, COT), the options market (put/call, skew, term structure, dealer gamma, walls, max pain) and index futures (pre-market, basis), combined into a scored bias, scenarios with model probabilities and a historical-analog study. Use when the person asks where a ticker or the market is heading, whether a move is likely, what the options or futures market implies, how far something could move, or how a move in SPX/NDX maps onto another ticker (e.g. SOXL, TQQQ).
---

# stock-desk: analyze

The stock-desk mod computes the numbers; your job is to read them critically and turn them into an analysis the person can act on themselves. You are not a licensed adviser: give a data-backed view (bias, confidence, levels, what would prove it wrong, risks), never an order or a position size for their account.

## Tools

| Tool | Use it for |
| --- | --- |
| `mcp__stock-desk__analyze_ticker` `{ symbol, horizon? }` | The full read on one ticker: trend, volatility, volume, options (where listed), key levels, expected moves, scenarios, analogs and the composite score. Start here. |
| `mcp__stock-desk__market_overview` `{}` | Index futures (ES/NQ/YM) with the cash level they imply, the VIX term structure, COT positioning of leveraged funds and asset managers, and SPY options positioning. Use for "the market", pre-market questions, or as context before a single-stock read. |
| `mcp__stock-desk__options_positioning` `{ symbol }` | The options detail alone: P/C, ATM term structure, 25Δ skew, GEX and the gamma flip, call/put walls, max pain, expected move per expiry, unusual volume. |
| `mcp__stock-desk__beta_map` `{ base, targets, baseTarget? , baseMovePct?, lookback? }` | "If SPX goes to 7500, where are SOXL and TQQQ?" — regression beta with a ±1σ residual band per target. |
| `mcp__stock-desk__probability` `{ symbol, levels, days }` | Model probability of closing above / touching given levels within N trading days (lognormal on implied vol, or realized vol when no options). |
| `mcp__stock-desk__intraday_read` `{ symbol }` | Today's session in real time: gap and pre-market, 5/15/30-minute opening ranges and the first-hour range (initial balance) with breakout status, VWAP and bands, relative volume by time of day, the opening type, sector breadth and leadership, VIX, today's options levels, a lean for the rest of the day, and past sessions that looked like today at the same clock time. |

The tools also put the result in the stock-desk pane (Analysis tab), so the person can see it beside the chat.

## Workflow

1. **Pin down the question.** "Today", "this morning", "the open", "the first hour", "right now" or any question during market hours about where the day is going → **intraday**: call `intraday_read` (and `market_overview` for context; for a single stock also `intraday_read` on SPY or QQQ). Days to weeks → the daily read with `analyze_ticker`. A question that mixes both ("today and this week") gets both, the intraday read first.
1b. **For the daily read, pin down the horizon.** Ticker(s) and horizon: intraday/next session, swing (1–4 weeks) or position (months). Pass the horizon in trading days; the composite weights depend on it (short horizons lean on futures, options and volume; longer ones on trend).
2. **Get context first when it matters.** For an index, index ETF, leveraged ETF or a high-beta name, call `market_overview` as well: a stock's read means little against a market that is breaking down.
3. **Read every module, not just the composite.** For each one note its score, confidence and flags. Then check agreement:
   - modules that agree → higher conviction;
   - trend up but volume distribution, steep put skew or negative gamma → say the trend is at risk and why;
   - a module with confidence < 0.4 counts for little: say so rather than leaning on it.
4. **Use the forecast honestly.**
   - Expected moves and scenario probabilities come from a zero-drift lognormal model on implied (or realized) vol: they describe the size of moves the market prices, not direction.
   - Direction comes from the module scores and the analog study. Quote the analog sample size and compare its win rate with the baseline; with n < 20, or a win rate within ~5 points of the baseline, call the edge weak.
   - Never present a model probability as a prediction of what will happen.
5. **Check freshness.** Quotes are ~15 minutes delayed; options and vol indexes are CBOE delayed; COT is as of the prior Tuesday. If a source failed, the tool says so — say it too, and do not fill the gap with guesses.

## Reading the intraday tool

- **Phase first.** Before 09:30 it is a pre-market read (gap, futures, levels to watch at the bell). From 09:30 to 10:30 the opening ranges are still forming: say so and keep the confidence modest; the read firms up once the first-hour range (initial balance) completes at 10:30.
- **What usually decides the day:** where price sits against VWAP and the first-hour range, whether a gap is being followed through or filled, the opening type (an open-drive that holds is the strongest trend signal; rejection-reverse warns), and relative volume (a breakout on heavy volume counts, on light volume often fails).
- **Breadth:** a move carried by a few sectors (RSP lagging SPY, most sectors down while tech is up) is narrower and less reliable than a broad one. There is no NYSE TICK or advance/decline feed; breadth is the sector-ETF proxy.
- **Options:** above the gamma flip, dealer hedging tends to damp moves and pin toward big strikes (max pain, walls); below it, moves stretch. Today's straddle move is the range the market priced for the day.
- **The session study** compares today's state with ~70 past sessions (and the kept archive) at the same clock time. Quote n and the baseline; with n < 15 call it anecdotal.
- **Give levels, not timing.** Name the trigger levels for each scenario (e.g. "a 5-minute close above the first-hour high at …") and what invalidates it. Never say what the person should do with their positions.

## Answer format

Lead with the conclusion, then the evidence:

1. **Bias and confidence** — e.g. "lean bearish, medium confidence (composite −28, 3 of 5 modules agree)".
2. **Why** — the 3–5 readings that drive it, with numbers (MA stack, ADX, distribution days, P/C, skew, GEX vs flip, futures move, COT percentile).
3. **Key levels** — supports/resistances, call/put walls, gamma flip, max pain: the ones nearest price, with what happens on a break.
4. **Scenarios** — bull/base/bear with targets, model probabilities and triggers.
5. **What would change the view** — the specific level or reading that invalidates it.
6. **Risks and caveats** — event risk in the window (earnings, CPI, FOMC: check `mcp__stock-desk__calendar_list`), data gaps, leverage decay for leveraged ETFs.

Write in the person's language. Keep tables tight; explain a term the first time it appears (e.g. gamma flip). End with one line saying this is analysis, not investment advice.
