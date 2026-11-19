// Languages of the pane: English and Simplified Chinese.
//
// Two ways text is written:
// - Text computed while drawing (pane chrome, level meanings, insights,
//   portfolio checks, calendar titles) takes the language: `tr(lang, en, zh)`.
// - Text computed once and kept (the analysis engine's verdicts, readings,
//   flags, scenario triggers) is written in both languages at once as a
//   `Text` pair, `bi(en, zh)`, so switching language is instant and the tools
//   can answer in English while the pane shows Chinese. `pick(lang, t)` reads
//   either kind.

export type Lang = 'en' | 'zh'

/** One message in both languages. */
export type Text = { en: string; zh: string }

export const LANGS: [Lang, string][] = [
  ['en', 'English'],
  ['zh', '中文'],
]

export const bi = (en: string, zh: string): Text => ({ en, zh })

export const tr = (lang: Lang, en: string, zh: string): string => (lang === 'zh' ? zh : en)

export function isText(x: unknown): x is Text {
  return typeof x === 'object' && x !== null && typeof (x as Text).en === 'string' && typeof (x as Text).zh === 'string'
}

/** A Text pair, a plain string (source data, numbers already formatted) or a number, in the language asked. */
export function pick(lang: Lang, t: Text | string | number | undefined | null): string {
  if (t === undefined || t === null) return ''
  if (typeof t === 'number') return String(t)
  if (typeof t === 'string') return t

  return lang === 'zh' ? t.zh : t.en
}

/** Joins Text pairs (or strings) language by language. */
export function joinText(parts: (Text | string)[], sepEn = ' ', sepZh = sepEn): Text {
  return {
    en: parts.map(p => pick('en', p)).join(sepEn),
    zh: parts.map(p => pick('zh', p)).join(sepZh),
  }
}

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** "Fri, Nov 20" / "11月20日 周五" for a YYYY-MM-DD date. */
export function dayLabel(lang: Lang, iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (lang === 'zh') return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEKDAY_ZH[d.getUTCDay()]}`

  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** "Nov 20" / "11月20日". */
export function shortDate(lang: Lang, iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (lang === 'zh') return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** "08:30" → "08:30 ET" / "美东 08:30". */
export const etTime = (lang: Lang, time: string): string => (lang === 'zh' ? `美东 ${time}` : `${time} ET`)

/** "today", "tomorrow", "in 3 days" / "今天", "明天", "3 天后". */
export function relativeDays(lang: Lang, days: number): string {
  if (days === 0) return tr(lang, 'today', '今天')
  if (days === 1) return tr(lang, 'tomorrow', '明天')
  if (days < 0) return tr(lang, `${-days} days ago`, `${-days} 天前`)

  return tr(lang, `in ${days} days`, `${days} 天后`)
}

/** "just now", "5 min ago", "2 h ago" / "刚刚", "5 分钟前", "2 小时前". */
export function agoText(lang: Lang, ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000)
  if (s < 60) return tr(lang, 'just now', '刚刚')
  if (s < 3600) return tr(lang, `${Math.round(s / 60)} min ago`, `${Math.round(s / 60)} 分钟前`)

  return tr(lang, `${Math.round(s / 3600)} h ago`, `${Math.round(s / 3600)} 小时前`)
}

/**
 * The one glossary every translated file follows, so a term reads the same
 * everywhere. Abbreviations (MA20, RSI, ATR, ADX, OBV, IV, RV, P/C, COT, GEX,
 * VIX, ES, NQ) stay as they are. Terms a Chinese reader may not know carry the
 * English in parentheses the first time a view shows them.
 */
export const GLOSSARY: Record<string, string> = {
  // trend
  'moving average': '均线',
  '20-day average': '20 日均线',
  '50-day average': '50 日均线',
  '200-day average': '200 日均线',
  'MA stack': '均线排列',
  'bullish stack': '多头排列',
  'bearish stack': '空头排列',
  uptrend: '上升趋势',
  downtrend: '下降趋势',
  'pullback in an uptrend': '上升趋势中的回调',
  'rebound in a downtrend': '下降趋势中的反弹',
  sideways: '横盘',
  'range-bound': '区间震荡',
  'higher highs, higher lows': '高点抬高、低点抬高',
  'lower highs, lower lows': '高点降低、低点降低',
  'swing high': '波段高点',
  'swing low': '波段低点',
  support: '支撑',
  resistance: '阻力',
  breakout: '突破',
  breakdown: '跌破',
  '52-week high': '52 周高点',
  '52-week low': '52 周低点',
  drawdown: '回撤',
  weekly: '周线',
  // volatility
  volatility: '波动率',
  'realized volatility': '已实现波动率',
  'implied volatility': '隐含波动率',
  squeeze: '收口（squeeze）',
  'Bollinger bandwidth': '布林带宽度',
  expanding: '放大',
  contracting: '收敛',
  stressed: '高压',
  calm: '平静',
  'expected move': '预期波幅',
  // volume and flow
  volume: '成交量',
  'heavy volume': '放量',
  'light volume': '缩量',
  'distribution day': '派发日',
  'accumulation day': '吸筹日',
  'up/down volume': '上涨/下跌成交量比',
  divergence: '背离',
  'bearish divergence': '顶背离',
  'bullish divergence': '底背离',
  // options
  'put/call ratio': '认沽/认购比（P/C）',
  'open interest': '未平仓量（OI）',
  'term structure': '期限结构',
  inverted: '倒挂',
  contango: '升水（contango）',
  backwardation: '贴水（backwardation）',
  skew: '偏斜',
  '25-delta skew': '25Δ 偏斜',
  'dealer gamma': '做市商伽马（GEX）',
  'long gamma': '正伽马',
  'short gamma': '负伽马',
  'gamma flip': '伽马翻转点（gamma flip）',
  'call wall': '看涨墙（call wall）',
  'put wall': '看跌墙（put wall）',
  'max pain': '最大痛点（max pain）',
  straddle: '跨式组合',
  expiry: '到期日',
  'monthly expiry': '月度到期',
  'unusual volume': '异常成交',
  // futures and positioning
  futures: '期货',
  'pre-market': '盘前',
  'after hours': '盘后',
  overnight: '隔夜',
  settlement: '结算价',
  basis: '基差',
  'leveraged funds': '杠杆基金',
  'asset managers': '资产管理机构',
  dealers: '交易商',
  'crowded long': '多头拥挤',
  'crowded short': '空头拥挤',
  // forecast
  bullish: '看多',
  'lean bullish': '偏多',
  neutral: '中性',
  'lean bearish': '偏空',
  bearish: '看空',
  confidence: '置信度',
  composite: '综合评分',
  scenario: '情景',
  bull: '乐观',
  base: '基准',
  bear: '悲观',
  trigger: '触发条件',
  invalidation: '失效条件',
  'historical analogs': '历史相似样本',
  'win rate': '胜率',
  baseline: '基准（全部交易日）',
  horizon: '周期',
  'trading days': '交易日',
  sessions: '交易日',
  // portfolio
  position: '持仓',
  stop: '止损',
  target: '目标价',
  'unrealized P/L': '浮动盈亏',
  'realized P/L': '已实现盈亏',
  'risk per trade': '单笔风险',
  earnings: '财报',
}

/** The words used for a composite bias. */
export function biasText(bias: 'bullish' | 'lean bullish' | 'neutral' | 'lean bearish' | 'bearish'): Text {
  return { en: bias, zh: GLOSSARY[bias] ?? bias }
}
