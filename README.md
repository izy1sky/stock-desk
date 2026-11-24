# stock-desk

A stock analysis engine for Claude Code, with a pane beside the chat.

## Analysis

For any US stock, ETF or index (SPX, NDX, RUT), the engine scores five modules from −100 (bearish) to +100 (bullish), each with a confidence, and weighs them into one bias for the horizon you pick (1 week to 3 months):

- **Trend**: the 5/10/20/50/200-day moving-average stack and slopes, ADX, swing structure (higher highs / lower lows), weekly confirmation, place in the 52-week range.
- **Volatility**: realized vol (10/20/60 days) and its percentile, ATR, Bollinger squeeze, implied vs realized.
- **Volume and flow**: OBV and its divergence from price, up/down volume, distribution and accumulation days.
- **Options** (CBOE's delayed chain, or Nasdaq's with vols and greeks solved from its quotes when CBOE does not answer): put/call by volume and open interest, ATM term structure, 25-delta skew, dealer gamma and the gamma flip, call and put walls, max pain, straddle-implied moves, unusual volume; VIX / VIX9D / VIX3M / VVIX / SKEW and VXN.
- **Futures**: ES, NQ, YM and RTY with the cash level they imply (pre-market too), and CFTC COT positioning of leveraged funds, asset managers and dealers.

On top: key levels (swing points, averages, option walls), expected moves, bull/base/bear scenarios with lognormal odds, and a historical-analog study (the 40 past days most like today in ten years of prices, and what followed).

Index funds score the futures of their own index: SPY, VOO and UPRO lead with ES; QQQ, TQQQ and SQQQ with NQ (its move and its COT); inverse funds read the signal the other way.

Claude gets the tools `analyze_ticker`, `market_overview`, `options_positioning`, `beta_map` ("SPX to 7500: where are SOXL and TQQQ?") and `probability` (odds of closing above or touching a level), and the `stock-desk:analyze` skill that says how to read them. The pane's Analysis tab shows the same report.

**The market is SPX and NDX**: `market_overview` analyses SPY and QQQ in full, with a side-by-side table (composite, every module, distance from the 20/50/200-day averages, ADX, realized vol, distribution days, analogs, nearest levels) and whether the two agree. `market_intraday` does the same for today's session (SPY and QQQ, or the ES and NQ futures before the open). Above the Analysis and Intraday tabs, a market strip shows both indexes' reads; press one to open it, or hide the strip.

**Intraday**: the Intraday (盘中) tab and the `intraday_read` tool read today's session in real time from 1-minute bars — the gap and pre-market range, the 5/15/30-minute opening ranges and the first-hour range (initial balance) with breakout status, VWAP and its bands, relative volume by time of day, the opening type (open-drive, test-drive, rejection-reverse, auction), sector breadth and equal- vs cap-weight, VIX, today's options levels, a first-hour timeline of how the read formed, and past sessions that looked like today at the same clock time. It refreshes every minute in the first hour (then every 3 minutes), keeps a summary of each session to grow its history, and can raise alerts at 10:30 and on breaks of the first-hour range, VWAP or the gamma flip (off by default).

**Languages**: English and 简体中文 — the Language button in the pane's footer switches every pane, the analysis included; the tools answer Claude in English either way.

**Option sources**: CBOE is asked first. If it refuses (a Cloudflare block or a rate limit), it is left alone for six hours and Nasdaq's chain is used; every options read says which one it is. Nasdaq has no SPX or RUT options, so those are SPY's and IWM's levels scaled to the index and marked so; NDX has its own chain, which stays at the last close before the open. Before the open, names with no posted quotes use the last session's trades, flagged and trusted less. Chains are kept ten minutes.

Data: Nasdaq (prices and options, ~15 min delayed), CBOE (options, VIX), CNBC (futures, cash indexes, VIX when CBOE does not answer), CFTC (COT). No keys. This is analysis of market data, not investment advice.

## Pane

- **Groups** in the top row (e.g. Tech, Chips, ETFs): each shows only its tickers; a stock can be in several, and All holds everything.
- **Daily candlestick (K-line) chart** for 1M / 3M / 6M / 1Y, with 20/50/200-day averages, volume, the range's high and low points marked, support and resistance lines, and a hover tooltip on every candle.
- **Key levels**: range and 52-week highs and lows, swing-based support and resistance, moving averages, RSI, ATR, volume versus average, market cap, analyst target, dividend.
- **Trend label** and a **price-drop check**: how far below the high, whether the last drop was unusually large, heavy or light selling, oversold readings, nearest support, and upcoming earnings.
- **News** per ticker, with possible incidents (lawsuits, probes, downgrades, guidance cuts) flagged.
- **Calendar**: your watchlist's next earnings, the biggest companies reporting this week, and the major US economic releases of the next five trading days.

Open it with `/stocks`, or add tickers with `/stocks TSLA AMD`. Data comes from Nasdaq's public API (no key, quotes delayed about 15 minutes). The signals come from price history only and are not investment advice.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install stock-desk --marketplace izy1sky/stock-desk
```

From a shell:

```bash
claude plugin install stock-desk --marketplace izy1sky/stock-desk
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `izy1sky/stock-desk`, then Add plugin.

Then run `/stocks` (or `/stocks TSLA AMD`), `/stock-calendar` and `/portfolio`.
