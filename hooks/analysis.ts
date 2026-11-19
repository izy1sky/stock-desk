import type { Bar, Range } from '../types'
import { tr } from './i18n'
import type { Lang } from './i18n'

export const RANGE_BARS: Record<Range, number> = { '1M': 21, '3M': 63, '6M': 126, '1Y': 252, '2Y': 504 }

export type Point = { price: number; date: string; index: number }
export type Tone = 'good' | 'info' | 'warn' | 'risk'
export type Insight = { tone: Tone; text: string }
export type Trend = { label: string; tone: Tone; detail: string }

export type Analysis = {
  last: Bar
  change: number
  changePct: number
  ma20: (number | null)[]
  ma50: (number | null)[]
  ma200: (number | null)[]
  rsi?: number
  atr?: number
  /** Highest high and lowest low inside the visible range (index into `bars`). */
  rangeHigh: Point
  rangeLow: Point
  high52: Point
  low52: Point
  /** Percent below the 52-week high, as a positive number. */
  drawdown: number
  /** Deepest peak-to-trough fall within the last year, as a positive percent. */
  maxDrawdown1y: number
  supports: Point[]
  resistances: Point[]
  trend: Trend
  downStreak: number
  volumeRatio?: number
  moveVsAtr?: number
  insights: Insight[]
}

export function sma(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!
    if (i >= n) sum -= values[i - n]!
    out.push(i >= n - 1 ? sum / n : null)
  }

  return out
}

/** Wilder's RSI of the last bar. */
export function rsi(closes: number[], n = 14): number | undefined {
  if (closes.length <= n) return undefined
  let gain = 0
  let loss = 0
  for (let i = 1; i <= n; i++) {
    const d = closes[i]! - closes[i - 1]!
    gain += Math.max(d, 0)
    loss += Math.max(-d, 0)
  }
  gain /= n
  loss /= n
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!
    gain = (gain * (n - 1) + Math.max(d, 0)) / n
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n
  }
  if (loss === 0) return 100

  return 100 - 100 / (1 + gain / loss)
}

/** Wilder's average true range of the last bar. */
export function atr(bars: Bar[], n = 14): number | undefined {
  if (bars.length <= n) return undefined
  const tr = bars.slice(1).map((b, i) => {
    const prev = bars[i]!.c

    return Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev))
  })
  let value = tr.slice(0, n).reduce((a, b) => a + b, 0) / n
  for (let i = n; i < tr.length; i++) value = (value * (n - 1) + tr[i]!) / n

  return value
}

/**
 * Swing points: a low (high) at or below (above) the `k` bars on each side.
 * Of several tied lows (a double bottom) the first counts.
 */
export function swings(bars: Bar[], k = 5): { lows: Point[]; highs: Point[] } {
  const lows: Point[] = []
  const highs: Point[] = []
  for (let i = k; i < bars.length - k; i++) {
    const b = bars[i]!
    let isLow = true
    let isHigh = true
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue
      const o = bars[j]!
      if (j < i ? o.l <= b.l : o.l < b.l) isLow = false
      if (j < i ? o.h >= b.h : o.h > b.h) isHigh = false
    }
    if (isLow) lows.push({ price: b.l, date: b.t, index: i })
    if (isHigh) highs.push({ price: b.h, date: b.t, index: i })
  }

  return { lows, highs }
}

function extreme(bars: Bar[], from: number, pick: 'high' | 'low'): Point {
  let best = from
  for (let i = from; i < bars.length; i++) {
    if (pick === 'high' ? bars[i]!.h > bars[best]!.h : bars[i]!.l < bars[best]!.l) best = i
  }
  const b = bars[best]!

  return { price: pick === 'high' ? b.h : b.l, date: b.t, index: best }
}

/** Keep levels at least `gap` (fraction) apart, nearest first. */
function spaced(points: Point[], gap: number): Point[] {
  const out: Point[] = []
  for (const p of points) if (out.every(q => Math.abs(q.price - p.price) / q.price > gap)) out.push(p)

  return out
}

const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
const money = (n: number) => n.toFixed(n >= 1000 ? 0 : 2)

/** A YYYY-MM-DD date as written in the text: unchanged in English, "2026年3月4日" in Chinese. */
export function fullDate(lang: Lang, iso: string): string {
  if (lang !== 'zh') return iso
  const [y, m, d] = iso.split('-')

  return `${Number(y)}年${Number(m)}月${Number(d)}日`
}

function classifyTrend(close: number, m50: number | null, m200: number | null, slope50: number | null, lang: Lang): Trend {
  const t = (en: string, zh: string) => tr(lang, en, zh)
  if (m50 === null) return { label: t('Not enough history', '历史数据不足'), tone: 'info', detail: t('Fewer than 50 trading days of data.', '数据不足 50 个交易日。') }
  const rising = (slope50 ?? 0) > 0
  if (m200 === null) {
    const short = t('Short history: no 200-day average yet.', '历史较短：还没有 200 日均线。')

    return close > m50
      ? { label: t('Above 50-day average', '位于 50 日均线上方'), tone: 'good', detail: short }
      : { label: t('Below 50-day average', '位于 50 日均线下方'), tone: 'warn', detail: short }
  }
  if (close > m50 && m50 > m200 && rising)
    return { label: t('Uptrend', '上升趋势'), tone: 'good', detail: t('Price above a rising 50-day average, which is above the 200-day.', '股价位于上行的 50 日均线上方，50 日均线又在 200 日均线上方。') }
  if (close < m50 && m50 > m200 && close > m200)
    return { label: t('Pullback in an uptrend', '上升趋势中的回调'), tone: 'info', detail: t('Below the 50-day average but the long-term (200-day) trend is still up.', '跌破 50 日均线，但长期（200 日）趋势仍然向上。') }
  if (close < m50 && m50 < m200 && !rising)
    return { label: t('Downtrend', '下降趋势'), tone: 'risk', detail: t('Price below a falling 50-day average, which is below the 200-day.', '股价位于下行的 50 日均线下方，50 日均线又在 200 日均线下方。') }
  if (close > m50 && m50 < m200)
    return { label: t('Rebound in a downtrend', '下降趋势中的反弹'), tone: 'warn', detail: t('Back above the 50-day average, but still under the 200-day.', '重回 50 日均线上方，但仍在 200 日均线下方。') }
  if (close < m200)
    return { label: t('Below long-term trend', '低于长期趋势'), tone: 'warn', detail: t('Price is under its 200-day average.', '股价位于 200 日均线下方。') }

  return { label: t('Sideways', '横盘'), tone: 'info', detail: t('Averages are flat or crossing; no clear direction.', '均线走平或相互交叉，方向不明。') }
}

export function analyze(bars: Bar[], range: Range, earningsInDays?: number, lang: Lang = 'en'): Analysis | undefined {
  const t = (en: string, zh: string) => tr(lang, en, zh)
  if (bars.length < 2) return undefined
  const closes = bars.map(b => b.c)
  const last = bars[bars.length - 1]!
  const prev = bars[bars.length - 2]!
  const change = last.c - prev.c
  const changePct = (change / prev.c) * 100
  const ma20 = sma(closes, 20)
  const ma50 = sma(closes, 50)
  const ma200 = sma(closes, 200)
  const lastIdx = bars.length - 1
  const m50 = ma50[lastIdx] ?? null
  const m200 = ma200[lastIdx] ?? null
  const m50Ago = ma50[lastIdx - 10] ?? null
  const slope50 = m50 !== null && m50Ago !== null ? (m50 - m50Ago) / m50Ago : null

  const visibleFrom = Math.max(0, bars.length - RANGE_BARS[range])
  const yearFrom = Math.max(0, bars.length - 252)
  const high52 = extreme(bars, yearFrom, 'high')
  const low52 = extreme(bars, yearFrom, 'low')
  const drawdown = ((high52.price - last.c) / high52.price) * 100

  let peak = bars[yearFrom]!.c
  let maxDrawdown1y = 0
  for (let i = yearFrom; i < bars.length; i++) {
    peak = Math.max(peak, bars[i]!.c)
    maxDrawdown1y = Math.max(maxDrawdown1y, ((peak - bars[i]!.c) / peak) * 100)
  }

  const { lows, highs } = swings(bars.slice(yearFrom))
  const shift = (p: Point) => ({ ...p, index: p.index + yearFrom })
  const supports = spaced(
    lows.map(shift).filter(p => p.price < last.c).sort((a, b) => b.price - a.price),
    0.015,
  ).slice(0, 3)
  const resistances = spaced(
    highs.map(shift).filter(p => p.price > last.c).sort((a, b) => a.price - b.price),
    0.015,
  ).slice(0, 2)
  if (resistances.length === 0 && high52.price > last.c) resistances.push(high52)
  if (supports.length === 0 && low52.price < last.c) supports.push(low52)

  let downStreak = 0
  for (let i = lastIdx; i > 0 && bars[i]!.c < bars[i - 1]!.c; i--) downStreak++

  const vols = bars.slice(-51, -1).map(b => b.v)
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0
  const volumeRatio = avgVol > 0 ? last.v / avgVol : undefined
  const atrValue = atr(bars)
  const moveVsAtr = atrValue ? Math.abs(change) / atrValue : undefined
  const rsiValue = rsi(closes)
  const trend = classifyTrend(last.c, m50, m200, slope50, lang)

  const insights: Insight[] = []
  const isDown = change < 0

  if (drawdown >= 1) {
    const tone: Tone = drawdown >= 20 ? 'risk' : drawdown >= 10 ? 'warn' : 'info'
    insights.push({
      tone,
      text: t(
        `${drawdown.toFixed(1)}% below its 52-week high of $${money(high52.price)} (${high52.date}).${drawdown >= 20 ? ' That is bear-market territory for this stock.' : ''} For scale, its deepest peak-to-trough fall in the past year (on closing prices) was ${maxDrawdown1y.toFixed(1)}%.`,
        `较 52 周高点 $${money(high52.price)}（${fullDate(lang, high52.date)}）低 ${drawdown.toFixed(1)}%。${drawdown >= 20 ? '对这只股票来说，已进入熊市区间。' : ''}作为参照，过去一年最深的一次高点到低点回撤（按收盘价）是 ${maxDrawdown1y.toFixed(1)}%。`,
      ),
    })
  } else {
    insights.push({ tone: 'good', text: t(`Within 1% of its 52-week high ($${money(high52.price)}).`, `距 52 周高点（$${money(high52.price)}）不到 1%。`) })
  }

  if (isDown && moveVsAtr !== undefined) {
    if (moveVsAtr >= 2)
      insights.push({
        tone: 'risk',
        text: t(
          `Last session's drop (${pct(changePct)}) was ${moveVsAtr.toFixed(1)}× a normal day's range. Moves this large are usually news-driven: check the News tab before reacting.`,
          `上一交易日的跌幅（${pct(changePct)}）是正常日波幅的 ${moveVsAtr.toFixed(1)}×。这么大的波动通常由消息驱动：先看看“新闻”标签页再做反应。`,
        ),
      })
    else if (moveVsAtr >= 1)
      insights.push({
        tone: 'warn',
        text: t(`Last session's drop (${pct(changePct)}) was bigger than a typical day (${moveVsAtr.toFixed(1)}× its average range).`, `上一交易日的跌幅（${pct(changePct)}）大于平常（是平均日波幅的 ${moveVsAtr.toFixed(1)}×）。`),
      })
    else
      insights.push({ tone: 'info', text: t(`Last session's move (${pct(changePct)}) is within its normal daily range (~$${money(atrValue!)}).`, `上一交易日的涨跌（${pct(changePct)}）在正常日波幅之内（约 $${money(atrValue!)}）。`) })
  }

  if (downStreak >= 3) insights.push({ tone: 'warn', text: t(`Down ${downStreak} sessions in a row.`, `连续 ${downStreak} 个交易日下跌。`) })

  if (isDown && volumeRatio !== undefined) {
    if (volumeRatio >= 1.5)
      insights.push({ tone: 'risk', text: t(`Fell on heavy volume (${volumeRatio.toFixed(1)}× the 50-day average): broad, determined selling.`, `放量下跌（成交量是 50 日均量的 ${volumeRatio.toFixed(1)}×）：抛售广泛而坚决。`) })
    else if (volumeRatio < 0.8)
      insights.push({ tone: 'info', text: t(`Fell on light volume (${volumeRatio.toFixed(1)}× average): selling pressure looks limited.`, `缩量下跌（成交量是均量的 ${volumeRatio.toFixed(1)}×）：抛压看起来有限。`) })
  }

  if (rsiValue !== undefined) {
    if (rsiValue <= 30)
      insights.push({
        tone: 'warn',
        text: t(
          `RSI ${rsiValue.toFixed(0)}: oversold. Bounces are common from here, but in a downtrend a stock can stay oversold for weeks.`,
          `RSI ${rsiValue.toFixed(0)}：超卖。从这里反弹很常见，但在下降趋势中，股票可能连续数周处于超卖状态。`,
        ),
      })
    else if (rsiValue >= 70)
      insights.push({ tone: 'warn', text: t(`RSI ${rsiValue.toFixed(0)}: overbought. Short pullbacks are common after readings this high.`, `RSI ${rsiValue.toFixed(0)}：超买。读数这么高之后，短暂回调很常见。`) })
  }

  if (m200 !== null && last.c < m200)
    insights.push({
      tone: 'risk',
      text: t(
        `Below its 200-day average ($${money(m200)}). Buying dips below the long-term trend line is generally riskier than buying dips above it.`,
        `位于 200 日均线（$${money(m200)}）下方。在长期趋势线下方逢低买入，通常比在其上方逢低买入风险更大。`,
      ),
    })
  else if (m50 !== null && last.c < m50 && trend.tone !== 'risk')
    insights.push({ tone: 'info', text: t(`Below its 50-day average ($${money(m50)}) but above the 200-day: a pullback, not (yet) a broken trend.`, `位于 50 日均线（$${money(m50)}）下方，但仍在 200 日均线上方：属于回调，趋势（暂时）没有被破坏。`) })

  const s1 = supports[0]
  if (s1) {
    const gap = ((last.c - s1.price) / last.c) * 100
    const kind = s1 === low52 ? '52-week low' : 'swing low'
    const kindZh = s1 === low52 ? '52 周低点' : '波段低点'
    insights.push({
      tone: 'info',
      text: t(
        `Nearest support: $${money(s1.price)} (${kind} on ${s1.date}), ${gap.toFixed(1)}% below. A close under it would open the way to ${supports[1] ? `$${money(supports[1].price)}` : `the 52-week low ($${money(low52.price)})`}.`,
        `最近的支撑：$${money(s1.price)}（${fullDate(lang, s1.date)}的${kindZh}），在现价下方 ${gap.toFixed(1)}%。收盘跌破它，下一个看点是 ${supports[1] ? `$${money(supports[1].price)}` : `52 周低点（$${money(low52.price)}）`}。`,
      ),
    })
  } else {
    insights.push({ tone: 'risk', text: t(`No support below: price is at a new 52-week low ($${money(low52.price)}), with no recent level to lean on.`, `下方没有支撑：股价处于 52 周新低（$${money(low52.price)}），近期没有可依托的价位。`) })
  }

  if (earningsInDays !== undefined && earningsInDays <= 10)
    insights.push({
      tone: 'warn',
      text:
        earningsInDays <= 0
          ? t('Earnings are out today: expect a large gap either way.', '今天发布财报：预计会大幅跳空，方向不定。')
          : t(`Earnings in ${earningsInDays} day${earningsInDays === 1 ? '' : 's'}: price can gap past any support level.`, `${earningsInDays} 天后发布财报：股价可能跳空越过任何支撑位。`),
    })

  return {
    last,
    change,
    changePct,
    ma20,
    ma50,
    ma200,
    rsi: rsiValue,
    atr: atrValue,
    rangeHigh: extreme(bars, visibleFrom, 'high'),
    rangeLow: extreme(bars, visibleFrom, 'low'),
    high52,
    low52,
    drawdown,
    maxDrawdown1y,
    supports,
    resistances,
    trend,
    downStreak,
    volumeRatio,
    moveVsAtr,
    insights,
  }
}
