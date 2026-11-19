# stock-desk

A stock analysis engine for Claude Code, with a pane beside the chat.

## Analysis

For any US stock, ETF or index (SPX, NDX, RUT), the engine scores five modules from −100 (bearish) to +100 (bullish), each with a confidence, and weighs them into one bias for the horizon you pick (1 week to 3 months):

- **Trend**: the 5/10/20/50/200-day moving-average stack and slopes, ADX, swing structure (higher highs / lower lows), weekly confirmation, place in the 52-week range.
- **Volatility**: realized vol (10/20/60 days) and its percentile, ATR, Bollinger squeeze, implied vs realized.
- **Volume and flow**: OBV and its divergence from price, up/down volume, distribution and accumulation days.
- **Options** (CBOE delayed chain with greeks): put/call by volume and open interest, ATM term structure, 25-delta skew, dealer gamma and the gamma flip, call and put walls, max pain, straddle-implied moves, unusual volume; VIX / VIX9D / VIX3M / VVIX / SKEW.
- **Futures**: ES, NQ, YM and RTY with the cash level they imply (pre-market too), and CFTC COT positioning of leveraged funds, asset managers and dealers.

On top: key levels (swing points, averages, option walls), expected moves, bull/base/bear scenarios with lognormal odds, and a historical-analog study (the 40 past days most like today in ten years of prices, and what followed).

Claude gets the tools `analyze_ticker`, `market_overview`, `options_positioning`, `beta_map` ("SPX to 7500: where are SOXL and TQQQ?") and `probability` (odds of closing above or touching a level), and the `stock-desk:analyze` skill that says how to read them. The pane's Analysis tab shows the same report.

**Languages**: English and 简体中文 — the Language button in the pane's footer switches every pane, the analysis included; the tools answer Claude in English either way.

Data: Nasdaq (prices, ~15 min delayed), CBOE (options, VIX), CNBC (futures, cash indexes), CFTC (COT). No keys. This is analysis of market data, not investment advice.

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
