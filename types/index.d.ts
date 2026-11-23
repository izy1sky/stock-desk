export type Range = '1M' | '3M' | '6M' | '1Y' | '2Y'
export type Tab = 'analysis' | 'intraday' | 'overview' | 'news' | 'calendar'
export type ColorMode = 'green-up' | 'red-up'
export type AssetClass = 'stocks' | 'etf'
export type CalCategory = 'watchlist' | 'big-earnings' | 'economy' | 'fed' | 'politics' | 'market' | 'mine'
export type Horizon = 14 | 30 | 90

/** A named set of tickers; a ticker can be in several groups. */
export type Group = { name: string; symbols: string[] }

export type Prefs = {
  /** Every ticker the person follows: the "All" group. */
  watchlist: string[]
  groups: Group[]
  /** The group the top row shows; '' for All. */
  group: string
  /** Whether the group tools (create, rename, delete, membership) show. */
  manageGroups?: boolean
  selected: string
  range: Range
  /** The expanded chart's range. */
  bigRange: Range
  tab: Tab
  colors: ColorMode
  /** The calendar pane: how many days ahead, and which kinds of events. */
  calHorizon: Horizon
  calCategories: CalCategory[]
  /** The portfolio pane: the position being edited, and whether the rules show. */
  editing?: string
  showRules?: boolean
  /** Hover tooltips on the expanded chart's candles; off by default, as they hold the scroll wheel. */
  hoverCandles?: boolean
  /** Intraday tab: draw the pre-market on the chart (default on). */
  showPremarket?: boolean
  /** Intraday alerts (first-hour summary, range and VWAP breaks) as toasts; off by default. */
  intradayAlerts?: boolean
  /** The market strip (SPY and QQQ side by side) above the Analysis and Intraday tabs; on by default. */
  showMarket?: boolean
  /** The language the panes are written in (default English). */
  lang?: 'en' | 'zh'
  /** The analysis horizon, in trading days. */
  horizon?: number
  /** Set once the Analysis tab has been opened for the person on first load. */
  seenAnalysis?: boolean
}

/** One holding, as the person entered it. */
export type Position = {
  symbol: string
  shares: number
  /** Average price paid per share. */
  cost: number
  stop?: number
  target?: number
  note?: string
  opened?: string
}

export type Trade = { date: string; symbol: string; side: 'buy' | 'sell'; shares: number; price: number; realized?: number }

/** Thresholds the person sets; the portfolio checks measure against them. */
export type Rules = {
  maxWeightPct: number
  maxLossPct: number
  stopNearPct: number
  riskPerTradePct: number
  maxSectorPct: number
  earningsDays: number
}

export type Portfolio = { positions: Position[]; cash: number; trades: Trade[]; rules: Rules }

/** One daily candle, oldest first; `t` is YYYY-MM-DD. */
export type Bar = { t: string; o: number; h: number; l: number; c: number; v: number }

export type Quote = {
  price: number
  change: number
  changePct: number
  volume: number
  asOf: string
  marketStatus: string
  /** After-hours or pre-market print, when Nasdaq has one. */
  extended?: { label: string; price: number; changePct: number }
}

export type Summary = {
  sector?: string
  industry?: string
  marketCap?: number
  avgVolume?: number
  target1y?: number
  dividendYield?: string
  /** YYYY-MM-DD */
  exDividend?: string
  /** YYYY-MM-DD */
  dividendPay?: string
}

export type NewsItem = { title: string; publisher: string; ago: string; url: string }

export type TickerData = {
  symbol: string
  name: string
  assetClass: AssetClass
  quote?: Quote
  bars: Bar[]
  summary: Summary
  news: NewsItem[]
  fetchedAt: number
  error?: string
}

export type EarningsRow = {
  date: string
  symbol: string
  name: string
  /** pre-market, after-hours or not-supplied */
  time: string
  epsForecast: string
  lastYearEPS: string
  quarter: string
  marketCap: number
}

export type EconEvent = {
  date: string
  time: string
  name: string
  consensus: string
  previous: string
  actual: string
  /** 3: moves the whole market (CPI, payrolls, Fed); 2: notable; 0: minor. */
  tier: 0 | 2 | 3
}

export type Calendar = {
  /** Every company reporting, per US trading day, for the next four weeks. */
  earnings: Record<string, EarningsRow[]>
  econ: EconEvent[]
  fetchedAt: number
  error?: string
}

/** An event the person or Claude put on the calendar. */
export type MyEvent = {
  id: string
  date: string
  title: string
  detail?: string
  category: CalCategory
  importance: 1 | 2 | 3
  addedBy: 'you' | 'claude'
}

/**
 * An analysis report as kept in state: the full type is `Report` in
 * hooks/engine/report.ts (the contract must not import it).
 */
export type StoredReport = { symbol: string; horizonDays: number; fetchedAt: number; [field: string]: unknown }

/** The intraday read of a ticker with its minute bars, as kept in state (`IntradayRead` in hooks/engine/intraday.ts). */
export type StoredIntraday = { symbol: string; fetchedAt: number; [field: string]: unknown }

declare module 'claude-code' {
  interface PluginState {
    'stock-desk': {
      prefs: Shaped<Prefs>
      tickers: Shaped<Record<string, TickerData>>
      calendar: Shaped<Calendar>
      myEvents: Shaped<MyEvent[]>
      portfolio: Shaped<Portfolio>
      /** The position-size calculator's last answer. */
      sizer: string
      /** The latest analysis report per ticker. */
      reports: Shaped<Record<string, StoredReport>>
      /** The latest intraday read per ticker, with today's minute bars. */
      intraday: Shaped<Record<string, StoredIntraday>>
      /** Why the last intraday read of a ticker failed, until one succeeds. */
      intradayErrors: Record<string, string>
      /** Why the last analysis of a ticker failed, until one succeeds. */
      reportErrors: Record<string, string>
      busy: string[]
    }
  }
}
