# stock-desk

A Claude Code pane for watching US stocks and ETFs beside the chat.

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
