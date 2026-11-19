// Technical modules: trend, volatility, volume, and key price levels.
// Each module scores directional bias from -100 to +100 (see ModuleResult).

import { atr, sma, swings } from '../analysis'
import {
  adx,
  bandwidthSeries,
  obv,
  percentileRank,
  realizedVol,
  realizedVolSeries,
  slope,
  slopePct,
  weekly,
} from './indicators'
import { bi, biasText, joinText } from '../i18n'
import { biasOf, clampScore, type Bar, type Levels, type ModuleResult, type Reading, type Text } from './types'

const YEAR = 252

const last = <T>(a: T[]): T | undefined => a[a.length - 1]
const fin = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)
const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0)
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const pct = (n: number, d = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`
const pct0 = (n: number) => `${n.toFixed(0)}%`
const ord = (n: number) => {
  const r = Math.round(n)
  const s = r % 100 >= 11 && r % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][r % 10] ?? 'th')

  return `${r}${s}`
}
/** "第 85 百分位" — the zh side of `ord(n) pct`. */
const pctileZh = (n: number) => `第 ${Math.round(n)} 百分位`
const rising = (up: boolean) => (up ? bi('rising', '上行') : bi('falling', '下行'))

export function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return '-'
  if (Math.abs(n) < 1000) return n.toFixed(2)
  const [int, dec] = n.toFixed(Math.abs(n) >= 10000 ? 0 : 2).split('.')
  const withCommas = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  return dec ? `${withCommas}.${dec}` : withCommas
}

/** Weighted mean of the components that exist, plus how much they agree (0..1). */
function combine(parts: { w: number; s: number | undefined }[]): { score: number; agreement: number; weight: number } {
  let sum = 0
  let abs = 0
  let weight = 0
  for (const p of parts) {
    if (!fin(p.s)) continue
    sum += p.w * p.s
    abs += p.w * Math.abs(p.s)
    weight += p.w
  }
  if (weight === 0) return { score: 0, agreement: 0, weight: 0 }

  return { score: sum / weight, agreement: abs > 0 ? Math.abs(sum) / abs : 0, weight }
}

/* ------------------------------------------------------------------ trend */

export type TrendStats = {
  close: number
  ma: { ma5?: number; ma10?: number; ma20?: number; ma50?: number; ma200?: number }
  /** Adjacent MA pairs (5/10, 10/20, 20/50, 50/200) in bullish / bearish order, of `pairs` available. */
  bullPairs: number
  bearPairs: number
  pairs: number
  /** How many of the available MAs the close is above, of `maCount`. */
  aboveCount: number
  maCount: number
  /** Least-squares slope over 10 bars, % of the MA per bar. */
  slope20?: number
  slope50?: number
  adx?: number
  plusDI?: number
  minusDI?: number
  rangeBound: boolean
  structure: 'higher highs, higher lows' | 'lower highs, lower lows' | 'mixed' | 'unknown'
  structureScore?: number
  weekly: { close?: number; ma10?: number; ma40?: number; slope10?: number }
  high52: number
  low52: number
  /** 0 = at the 52-week low, 1 = at the high. */
  rangePos: number
  /** Each component's sub-score, -1..1, before weighting. */
  components: Record<string, number | undefined>
}

export type TrendResult = ModuleResult & { stats: TrendStats }

const STRUCTURE_ZH: Record<TrendStats['structure'], string> = {
  'higher highs, higher lows': '高点抬高、低点抬高',
  'lower highs, lower lows': '高点降低、低点降低',
  mixed: '高低点交错',
  unknown: '未知',
}

/** The swing structure in both languages. */
export const structureText = (s: TrendStats['structure']): Text => bi(s, STRUCTURE_ZH[s])

/**
 * Score weights (renormalized over the components that exist):
 *   MA stack order 20, price vs MAs 10, MA20/MA50 slope 15, swing structure 20,
 *   +DI vs −DI 10, weekly confirmation 15, 52-week range position 10.
 * ADX < 20 (range-bound) multiplies the score by 0.75 and lowers confidence.
 */
export const TREND_WEIGHTS = { stack: 20, priceVsMa: 10, slopes: 15, structure: 20, di: 10, weekly: 15, range: 10 }

function structureOf(bars: Bar[]): { label: TrendStats['structure']; score?: number } {
  const win = bars.slice(-70)
  if (win.length < 20) return { label: 'unknown' }
  const sw = swings(win, 3)
  // A run past the last confirmed swing (not yet confirmed itself) counts as a new high / low.
  const after = (i: number) => win.slice(i + 1)
  const highs = sw.highs.map(p => p.price)
  const lows = sw.lows.map(p => p.price)
  const lastHigh = last(sw.highs)
  const lastLow = last(sw.lows)
  if (lastHigh) {
    const m = Math.max(...after(lastHigh.index).map(b => b.h))
    if (m > lastHigh.price) highs.push(m)
  }
  if (lastLow) {
    const m = Math.min(...after(lastLow.index).map(b => b.l))
    if (m < lastLow.price) lows.push(m)
  }
  let s: number
  if (highs.length >= 2 && lows.length >= 2) {
    // 65%: the last two comparisons of each (current structure); 35%: every comparison in the window
    const cmp = (pts: number[]) => pts.slice(1).map((p, i) => sign(p - pts[i]!))
    const all = [...cmp(highs), ...cmp(lows)]
    const recent = [...cmp(highs).slice(-2), ...cmp(lows).slice(-2)]
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    s = 0.65 * avg(recent) + 0.35 * avg(all)
  } else {
    // smooth trends leave few swing points: compare halves of the window
    const half = Math.floor(win.length / 2)
    const a = win.slice(0, half)
    const b = win.slice(half)
    const hh = sign(Math.max(...b.map(x => x.h)) - Math.max(...a.map(x => x.h)))
    const hl = sign(Math.min(...b.map(x => x.l)) - Math.min(...a.map(x => x.l)))
    s = (hh + hl) / 2
  }
  const label = s >= 0.34 ? 'higher highs, higher lows' : s <= -0.34 ? 'lower highs, lower lows' : 'mixed'

  return { label, score: clamp(s, -1, 1) }
}

export function trendModule(bars: Bar[]): TrendResult {
  const closes = bars.map(b => b.c)
  const close = last(closes) ?? NaN
  const maOf = (n: number) => {
    const v = last(sma(closes, n))

    return fin(v) ? v : undefined
  }
  const ma = { ma5: maOf(5), ma10: maOf(10), ma20: maOf(20), ma50: maOf(50), ma200: maOf(200) }
  const chain = [ma.ma5, ma.ma10, ma.ma20, ma.ma50, ma.ma200]
  let bullPairs = 0
  let bearPairs = 0
  let pairs = 0
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i]
    const b = chain[i + 1]
    if (!fin(a) || !fin(b)) continue
    pairs++
    if (a > b) bullPairs++
    else if (a < b) bearPairs++
  }
  const mas = chain.filter(fin)
  const aboveCount = mas.filter(m => close > m).length
  const maCount = mas.length

  const ma20s = sma(closes, 20)
  const ma50s = sma(closes, 50)
  const slope20 = slopePct(ma20s, 10)
  const slope50 = slopePct(ma50s, 10)
  const a = adx(bars, 14)
  const rangeBound = a ? a.adx < 20 : false
  const struct = structureOf(bars)

  const wk = weekly(bars)
  const wc = wk.map(b => b.c)
  const w10s = sma(wc, 10)
  const w10 = last(w10s) ?? undefined
  const w40 = last(sma(wc, 40)) ?? undefined
  const wSlope = slopePct(w10s, 4)
  const weeklyStats = { close: last(wc), ma10: fin(w10) ? w10 : undefined, ma40: fin(w40) ? w40 : undefined, slope10: wSlope }

  const year = bars.slice(-YEAR)
  const high52 = year.length ? Math.max(...year.map(b => b.h)) : NaN
  const low52 = year.length ? Math.min(...year.map(b => b.l)) : NaN
  const rangePos = high52 > low52 ? (close - low52) / (high52 - low52) : 0.5

  // Sub-scores, each -1..1. Slopes: 0.1%/bar on the MA (about 2% a month) is a clear trend.
  const comp: Record<string, number | undefined> = {
    stack: pairs ? (bullPairs - bearPairs) / pairs : undefined,
    priceVsMa: maCount ? (2 * aboveCount - maCount) / maCount : undefined,
    slopes:
      fin(slope20) || fin(slope50)
        ? ((fin(slope20) ? Math.tanh(slope20 / 0.1) : 0) + (fin(slope50) ? Math.tanh(slope50 / 0.1) : 0)) /
          ((fin(slope20) ? 1 : 0) + (fin(slope50) ? 1 : 0))
        : undefined,
    structure: struct.score,
    di: a && a.plusDI + a.minusDI > 0 ? (a.plusDI - a.minusDI) / (a.plusDI + a.minusDI) : undefined,
    weekly: (() => {
      const xs: number[] = []
      const c = weeklyStats.close
      if (fin(c) && fin(weeklyStats.ma10)) xs.push(sign(c - weeklyStats.ma10))
      if (fin(c) && fin(weeklyStats.ma40)) xs.push(sign(c - weeklyStats.ma40))
      if (fin(wSlope)) xs.push(Math.tanh(wSlope / 0.5))

      return xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : undefined
    })(),
    range: year.length >= 60 ? clamp((rangePos - 0.5) * 2, -1, 1) : undefined,
  }
  const W = TREND_WEIGHTS
  const { score: raw, agreement, weight } = combine(Object.entries(comp).map(([k, s]) => ({ w: W[k as keyof typeof W], s })))
  const damp = rangeBound ? 0.75 : 1
  const score = clampScore(raw * 100 * damp)

  let confidence = 0.35 + 0.4 * agreement
  if (a) confidence += a.adx >= 25 ? 0.15 : a.adx < 20 ? -0.15 : 0
  if (bars.length < 200) confidence -= 0.2
  if (weight < 50) confidence -= 0.15
  confidence = bars.length < 20 ? 0 : clamp(confidence, 0.05, 0.95)

  const stats: TrendStats = {
    close,
    ma,
    bullPairs,
    bearPairs,
    pairs,
    aboveCount,
    maCount,
    slope20,
    slope50,
    adx: a?.adx,
    plusDI: a?.plusDI,
    minusDI: a?.minusDI,
    rangeBound,
    structure: struct.label,
    structureScore: struct.score,
    weekly: weeklyStats,
    high52,
    low52,
    rangePos,
    components: comp,
  }

  const readings: Reading[] = []
  if (pairs)
    readings.push({
      name: bi('MA stack', '均线排列'),
      value: bi(`${bullPairs}/${pairs} bullish`, `${bullPairs}/${pairs} 组多头`),
      note:
        bullPairs === pairs
          ? bi('fully bullish order', '完全多头排列')
          : bearPairs === pairs
            ? bi('fully bearish order', '完全空头排列')
            : bi(`${bearPairs} bearish`, `${bearPairs} 组空头`),
    })
  if (maCount) readings.push({ name: bi('Price vs MAs', '价格与均线'), value: bi(`above ${aboveCount}/${maCount}`, `站上 ${aboveCount}/${maCount} 条`) })
  for (const [name, v] of [['MA20', ma.ma20], ['MA50', ma.ma50], ['MA200', ma.ma200]] as const)
    if (fin(v)) readings.push({ name: bi(name, `${name} 均线`), value: Number(v.toFixed(2)), note: bi(`price ${pct(((close - v) / v) * 100)}`, `现价偏离 ${pct(((close - v) / v) * 100)}`) })
  if (fin(slope20)) readings.push({ name: bi('MA20 slope', 'MA20 斜率'), value: bi(`${pct(slope20, 2)}/day`, `${pct(slope20, 2)}/日`), note: rising(slope20 > 0) })
  if (fin(slope50)) readings.push({ name: bi('MA50 slope', 'MA50 斜率'), value: bi(`${pct(slope50, 2)}/day`, `${pct(slope50, 2)}/日`), note: rising(slope50 > 0) })
  if (a) {
    const state = a.adx < 20 ? bi('range-bound', '区间震荡') : a.adx >= 25 ? bi('trending', '趋势明确') : bi('weak trend', '趋势偏弱')
    const di = `+DI ${a.plusDI.toFixed(0)} / −DI ${a.minusDI.toFixed(0)}`
    readings.push({
      name: bi('ADX(14)', 'ADX(14) 趋势强度'),
      value: Number(a.adx.toFixed(1)),
      note: bi(`${state.en}; ${di}`, `${state.zh}；${di}`),
    })
  }
  readings.push({ name: bi('Structure (3m)', '波段结构（3 个月）'), value: structureText(struct.label) })
  if (fin(weeklyStats.ma10) && fin(weeklyStats.close)) {
    const up10 = weeklyStats.close > weeklyStats.ma10
    const up40 = fin(weeklyStats.ma40) ? weeklyStats.close > weeklyStats.ma40 : undefined
    readings.push({
      name: bi('Weekly', '周线'),
      value: bi(
        `${up10 ? 'above' : 'below'} 10w${up40 !== undefined ? `, ${up40 ? 'above' : 'below'} 40w` : ''}`,
        `${up10 ? '高于' : '低于'} 10 周线${up40 !== undefined ? `，${up40 ? '高于' : '低于'} 40 周线` : ''}`,
      ),
      note: fin(wSlope) ? bi(`10w MA ${wSlope > 0 ? 'rising' : 'falling'}`, `10 周均线${wSlope > 0 ? '上行' : '下行'}`) : undefined,
    })
  }
  if (year.length)
    readings.push({
      name: bi('52w range position', '52 周区间位置'),
      value: pct0(rangePos * 100),
      note: bi(`${fmtPrice(low52)} – ${fmtPrice(high52)}`, `区间 ${fmtPrice(low52)} – ${fmtPrice(high52)}`),
    })

  const flags: Text[] = []
  if (rangeBound) flags.push(bi(`Range-bound: ADX ${a!.adx.toFixed(0)} < 20`, `区间震荡：ADX ${a!.adx.toFixed(0)} < 20`))
  else if (a && a.adx >= 40) flags.push(bi(`Very strong trend: ADX ${a.adx.toFixed(0)}`, `趋势极强：ADX ${a.adx.toFixed(0)}`))
  const m50 = ma50s
  const m200 = sma(closes, 200)
  for (let i = closes.length - 1; i >= Math.max(1, closes.length - 10); i--) {
    const x0 = m50[i - 1], y0 = m200[i - 1], x1 = m50[i], y1 = m200[i]
    if (!fin(x0) || !fin(y0) || !fin(x1) || !fin(y1)) break
    if (x0 <= y0 && x1 > y1) { flags.push(bi('Golden cross (MA50 over MA200) in the last 10 sessions', '近 10 个交易日出现金叉（MA50 上穿 MA200）')); break }
    if (x0 >= y0 && x1 < y1) { flags.push(bi('Death cross (MA50 under MA200) in the last 10 sessions', '近 10 个交易日出现死叉（MA50 下穿 MA200）')); break }
  }
  if (fin(ma.ma200) && close < ma.ma200 && score > 0) flags.push(bi('Below the 200-day MA despite a positive score', '评分为正，但价格仍在 200 日均线下方'))
  if (year.length >= 60 && close >= high52 * 0.99) flags.push(bi('At or near the 52-week high', '处于或接近 52 周高点'))
  if (year.length >= 60 && close <= low52 * 1.01) flags.push(bi('At or near the 52-week low', '处于或接近 52 周低点'))
  if (fin(comp.weekly) && Math.abs(comp.weekly) >= 0.5 && sign(comp.weekly) !== sign(score) && Math.abs(score) >= 15)
    flags.push(bi('Weekly trend disagrees with the daily picture', '周线趋势与日线方向不一致'))
  const atr14 = atr(bars)
  if (fin(ma.ma20) && atr14 && Math.abs(close - ma.ma20) > 3 * atr14) {
    const x = ((close - ma.ma20) / atr14).toFixed(1)
    flags.push(bi(`Extended: ${x} ATR from MA20`, `乖离过大：距 MA20 ${x} 个 ATR`))
  }

  const bias = biasOf(score)
  const label =
    bars.length < 20
      ? bi('Not enough history for a trend read', '历史数据不足，无法判断趋势')
      : score >= 40
        ? bi('Uptrend', '上升趋势')
        : score >= 15
          ? bi('Leaning up', '偏向上行')
          : score > -15
            ? bi('No clear trend', '无明确趋势')
            : score > -40
              ? bi('Leaning down', '偏向下行')
              : bi('Downtrend', '下降趋势')
  const why = [
    pairs ? bi(`${bullPairs}/${pairs} MA pairs bullish`, `${bullPairs}/${pairs} 组均线多头`) : undefined,
    struct.label !== 'unknown' ? structureText(struct.label) : undefined,
    a ? bi(`ADX ${a.adx.toFixed(0)}${rangeBound ? ' (range-bound)' : ''}`, `ADX ${a.adx.toFixed(0)}${rangeBound ? '（区间震荡）' : ''}`) : undefined,
  ].filter((x): x is Text => x !== undefined)
  const whyText = joinText(why, ', ', '，')
  const verdict =
    bars.length < 20
      ? bi(`${label.en}.`, `${label.zh}。`)
      : bi(`${label.en} (${bias}): ${whyText.en}.`, `${label.zh}（${biasText(bias).zh}）：${whyText.zh}。`)

  return { key: 'trend', score, confidence, verdict, readings, flags, stats }
}

/* ------------------------------------------------------------- volatility */

export type VolatilityStats = {
  /** Annualized realized vol, decimals (0.18 = 18%). */
  rv10?: number
  rv20?: number
  rv60?: number
  /** Percentile (0..100) of today's RV20 among the past year's RV20. */
  rvPct1y?: number
  /** ATR(14) as % of price. */
  atrPct?: number
  /** Bollinger(20, 2) bandwidth, (upper − lower) / mid. */
  bandwidth?: number
  /** Percentile (0..100) of today's bandwidth over the past year. */
  bandwidthPct?: number
  /** Bandwidth at or below its 10th percentile of the past year. */
  squeeze: boolean
  /** RV10 / RV60. */
  volRatio?: number
  volTrend: 'expanding' | 'contracting' | 'stable' | 'unknown'
  iv?: number
  /** IV − RV20 (decimal). */
  ivRvSpread?: number
  ivRich?: 'rich' | 'cheap' | 'fair'
  /**
   * Annualized vol the forecast should use: the implied vol when given,
   * else max(RV20, 0.5·RV20 + 0.5·RV60). Realized vol mean-reverts, so after a
   * calm month the blend lifts RV20 toward RV60; taking the max keeps a fresh
   * spike in RV20 from being averaged away.
   */
  sigma?: number
  sigmaSource: 'iv' | 'realized' | 'none'
  components: Record<string, number | undefined>
}

export type VolatilityResult = ModuleResult & { stats: VolatilityStats }

const VOL_TREND_ZH: Record<VolatilityStats['volTrend'], string> = { expanding: '放大', contracting: '收敛', stable: '平稳', unknown: '未知' }
const IV_RICH_ZH: Record<NonNullable<VolatilityStats['ivRich']>, string> = { rich: '偏贵', cheap: '偏便宜', fair: '合理' }
const SIGMA_SOURCE_ZH: Record<VolatilityStats['sigmaSource'], string> = { iv: '隐含波动率', realized: '已实现波动率', none: '无' }

/** Realized-vol trend (RV10 vs RV60) in both languages. */
export const volTrendText = (t: VolatilityStats['volTrend']): Text => bi(t, VOL_TREND_ZH[t])
/** Options priced rich / cheap / fair against realized vol. */
export const ivRichText = (r: NonNullable<VolatilityStats['ivRich']>): Text => bi(r, IV_RICH_ZH[r])
/** Where the forecast sigma came from ('iv' / 'realized' / 'none' stay the English words). */
export const sigmaSourceText = (s: VolatilityStats['sigmaSource']): Text => bi(s, SIGMA_SOURCE_ZH[s])

/**
 * Score weights (renormalized): RV20 level vs its year 40, vol trend
 * (RV10 vs RV60) 35, bandwidth percentile 15, IV vs RV20 10 (only with iv).
 * Calm / compressing scores positive; stressed / expanding scores negative.
 */
export const VOL_WEIGHTS = { level: 40, trend: 35, bandwidth: 15, iv: 10 }

export function volatilityModule(bars: Bar[], opts?: { iv?: number }): VolatilityResult {
  const closes = bars.map(b => b.c)
  const close = last(closes) ?? NaN
  const rv10 = realizedVol(closes, 10)
  const rv20 = realizedVol(closes, 20)
  const rv60 = realizedVol(closes, 60)
  const rvSeries = realizedVolSeries(closes, 20).slice(-YEAR)
  const rvPct1y = fin(rv20) && rvSeries.filter(fin).length >= 60 ? percentileRank(rvSeries, rv20) : undefined
  const atr14 = atr(bars)
  const atrPct = atr14 && close > 0 ? (atr14 / close) * 100 : undefined
  const bw = bandwidthSeries(closes, 20, 2)
  const bandwidth = last(bw) ?? undefined
  const bwYear = bw.slice(-YEAR)
  const bandwidthPct = fin(bandwidth) && bwYear.filter(fin).length >= 60 ? percentileRank(bwYear, bandwidth) : undefined
  const squeeze = fin(bandwidthPct) && bandwidthPct <= 10
  const volRatio = fin(rv10) && fin(rv60) && rv60 > 0 ? rv10 / rv60 : undefined
  const volTrend: VolatilityStats['volTrend'] = !fin(volRatio)
    ? 'unknown'
    : volRatio >= 1.25
      ? 'expanding'
      : volRatio <= 0.8
        ? 'contracting'
        : 'stable'
  const iv = opts?.iv !== undefined && fin(opts.iv) && opts.iv > 0 ? opts.iv : undefined
  const ivRvSpread = fin(iv) && fin(rv20) ? iv - rv20 : undefined
  const ivRatio = fin(iv) && fin(rv20) && rv20 > 0 ? iv / rv20 : undefined
  const ivRich: VolatilityStats['ivRich'] = !fin(ivRatio) ? undefined : ivRatio >= 1.25 ? 'rich' : ivRatio <= 0.9 ? 'cheap' : 'fair'

  let sigma: number | undefined
  let sigmaSource: VolatilityStats['sigmaSource'] = 'none'
  if (fin(iv)) {
    sigma = iv
    sigmaSource = 'iv'
  } else if (fin(rv20)) {
    sigma = fin(rv60) ? Math.max(rv20, 0.5 * rv20 + 0.5 * rv60) : rv20
    sigmaSource = 'realized'
  }

  const comp: Record<string, number | undefined> = {
    level: fin(rvPct1y) ? (50 - rvPct1y) / 50 : undefined,
    trend: fin(volRatio) ? -Math.tanh(Math.log(volRatio) / 0.4) : undefined,
    bandwidth: fin(bandwidthPct) ? (50 - bandwidthPct) / 50 : undefined,
    // some premium of IV over RV is normal; only the excess over 10% reads as fear
    iv: fin(ivRatio) ? -Math.tanh((ivRatio - 1.1) / 0.3) : undefined,
  }
  const { score: raw, agreement, weight } = combine(Object.entries(comp).map(([k, s]) => ({ w: VOL_WEIGHTS[k as keyof typeof VOL_WEIGHTS], s })))
  const score = clampScore(raw * 100)
  let confidence = 0.4 + 0.35 * agreement
  if (bars.length < YEAR) confidence -= 0.2
  if (fin(iv)) confidence += 0.1
  if (weight < 40) confidence -= 0.2
  confidence = fin(rv20) ? clamp(confidence, 0.05, 0.95) : 0

  const readings: Reading[] = []
  const vp = (x: number | undefined) => (fin(x) ? `${(x * 100).toFixed(1)}%` : '-')
  if (fin(rv20))
    readings.push({ name: bi('RV10 / RV20 / RV60', '已实现波动率 RV10 / RV20 / RV60'), value: `${vp(rv10)} / ${vp(rv20)} / ${vp(rv60)}`, note: bi('annualized', '年化') })
  if (fin(rvPct1y))
    readings.push({
      name: bi('RV20 percentile (1y)', 'RV20 一年分位'),
      value: Math.round(rvPct1y),
      note: rvPct1y >= 80 ? bi('stressed', '高压') : rvPct1y <= 20 ? bi('calm', '平静') : bi('normal', '正常'),
    })
  if (fin(atrPct)) readings.push({ name: bi('ATR(14) % of price', 'ATR(14) 占价格比例'), value: `${atrPct.toFixed(2)}%` })
  if (fin(bandwidth))
    readings.push({
      name: bi('Bollinger bandwidth', '布林带宽度'),
      value: `${(bandwidth * 100).toFixed(1)}%`,
      note: fin(bandwidthPct) ? bi(`${ord(bandwidthPct)} pct of 1y`, `一年内${pctileZh(bandwidthPct)}`) : undefined,
    })
  if (fin(volRatio)) readings.push({ name: bi('RV10 / RV60', 'RV10 / RV60 比值'), value: Number(volRatio.toFixed(2)), note: volTrendText(volTrend) })
  if (fin(iv)) {
    const pts = ((ivRvSpread ?? 0) * 100).toFixed(1)
    readings.push({
      name: bi('IV − RV20', 'IV − RV20 差值'),
      value: bi(`${pts} pts`, `${pts} 个百分点`),
      note: bi(`IV ${vp(iv)}, options ${ivRich}`, `IV ${vp(iv)}，期权${ivRich ? IV_RICH_ZH[ivRich] : '未知'}`),
    })
  }
  if (fin(sigma))
    readings.push({
      name: bi('Forecast sigma', '预测用波动率（σ）'),
      value: vp(sigma),
      note: sigmaSource === 'iv' ? bi('implied vol', '隐含波动率') : bi('max(RV20, avg of RV20 and RV60)', '取 RV20 与（RV20、RV60 均值）中的较大者'),
    })

  const flags: Text[] = []
  if (squeeze)
    flags.push(
      bi(
        `Bollinger squeeze: bandwidth at ${ord(bandwidthPct!)} pct of 1y, breakout risk either way`,
        `布林带收口（squeeze）：带宽处于一年内${pctileZh(bandwidthPct!)}，双向均有突破风险`,
      ),
    )
  if (volTrend === 'expanding') flags.push(bi(`Volatility expanding: RV10 ${volRatio!.toFixed(2)}× RV60`, `波动率放大：RV10 为 RV60 的 ${volRatio!.toFixed(2)} 倍`))
  if (fin(rvPct1y) && rvPct1y >= 90) flags.push(bi(`RV20 at ${ord(rvPct1y)} pct of the past year: stressed`, `RV20 处于过去一年${pctileZh(rvPct1y)}：高压`))
  if (ivRich === 'rich') flags.push(bi(`Options rich: IV ${vp(iv)} vs RV20 ${vp(rv20)}`, `期权偏贵：IV ${vp(iv)}，RV20 ${vp(rv20)}`))
  if (ivRich === 'cheap') flags.push(bi(`Options cheap: IV ${vp(iv)} vs RV20 ${vp(rv20)}`, `期权偏便宜：IV ${vp(iv)}，RV20 ${vp(rv20)}`))
  if (volTrend === 'contracting' && !squeeze) flags.push(bi('Volatility contracting', '波动率收敛'))

  const state = !fin(rv20)
    ? bi('Not enough history for a volatility read', '历史数据不足，无法判断波动率')
    : score >= 40
      ? bi('Calm, compressing volatility', '波动平静且在收敛')
      : score >= 15
        ? bi('Volatility on the calm side', '波动率偏低')
        : score > -15
          ? bi('Normal volatility', '波动率正常')
          : score > -40
            ? bi('Volatility elevated', '波动率偏高')
            : bi('Stressed, expanding volatility', '波动高压且在放大')
  const verdict = fin(rv20)
    ? bi(
        `${state.en}: RV20 ${vp(rv20)}${fin(rvPct1y) ? ` (${ord(rvPct1y)} pct of 1y)` : ''}, ${volTrend}${squeeze ? ', squeeze on' : ''}.`,
        `${state.zh}：RV20 ${vp(rv20)}${fin(rvPct1y) ? `（一年内${pctileZh(rvPct1y)}）` : ''}，${VOL_TREND_ZH[volTrend]}${squeeze ? '，布林带收口' : ''}。`,
      )
    : bi(`${state.en}.`, `${state.zh}。`)

  return {
    key: 'volatility',
    score,
    confidence,
    verdict,
    readings,
    flags,
    stats: { rv10, rv20, rv60, rvPct1y, atrPct, bandwidth, bandwidthPct, squeeze, volRatio, volTrend, iv, ivRvSpread, ivRich, sigma, sigmaSource, components: comp },
  }
}

/* ----------------------------------------------------------------- volume */

export type VolumeStats = {
  /** Last session's volume / average of the 50 sessions before it. */
  volVs50?: number
  avgVol50?: number
  /** Price least-squares slope over 20 bars, % per bar. */
  priceSlope20?: number
  /** OBV slope over 20 bars, in multiples of the 20-day average volume per bar (-1..1 range in practice). */
  obvSlope20?: number
  divergence: 'bearish' | 'bullish' | 'none'
  /** Volume on up closes / volume on down closes, last 20 sessions. */
  upDownRatio20?: number
  /** IBD-style counts over the last 25 sessions. */
  distributionDays: number
  accumulationDays: number
  lastSession: {
    changePct?: number
    /** High − low as a multiple of ATR(14). */
    rangeVsAtr?: number
    volVs50?: number
    /** Close location in the day's range, 0 = low, 1 = high. */
    closeLocation?: number
    /** e.g. "up day on heavy volume" / "放量上涨日". */
    character: Text
  }
  components: Record<string, number | undefined>
}

export type VolumeResult = ModuleResult & { stats: VolumeStats }

const DIVERGENCE_ZH: Record<VolumeStats['divergence'], string> = { bearish: '顶背离', bullish: '底背离', none: '无背离' }

/** Price/OBV divergence in both languages. */
export const divergenceText = (d: VolumeStats['divergence']): Text => bi(d, DIVERGENCE_ZH[d])

/**
 * Score weights (renormalized): up/down volume ratio 30, OBV slope 25,
 * accumulation minus distribution days 25, price/OBV divergence 10,
 * last session's character 10.
 */
export const VOLUME_WEIGHTS = { upDown: 30, obv: 25, accDist: 25, divergence: 10, lastSession: 10 }

export function volumeModule(bars: Bar[]): VolumeResult {
  const n = bars.length
  const hasVolume = bars.slice(-60).some(b => b.v > 0)
  const lastBar = last(bars)
  const prev = bars[n - 2]
  const prior50 = bars.slice(-51, -1).map(b => b.v)
  const avgVol50 = prior50.length >= 20 ? prior50.reduce((a, b) => a + b, 0) / prior50.length : undefined
  const volVs50 = lastBar && avgVol50 && avgVol50 > 0 ? lastBar.v / avgVol50 : undefined

  const closes = bars.map(b => b.c)
  const priceSlope20 = slopePct(closes, 20)
  const ob = obv(bars)
  const avgVol20 = n >= 20 ? bars.slice(-20).reduce((a, b) => a + b.v, 0) / 20 : undefined
  const rawObvSlope = slope(ob, 20)
  const obvSlope20 = fin(rawObvSlope) && avgVol20 && avgVol20 > 0 ? rawObvSlope / avgVol20 : undefined
  // price up 1% over 20 bars (0.05%/bar) with OBV losing 10% of a day's volume per bar, or the reverse
  let divergence: VolumeStats['divergence'] = 'none'
  if (fin(priceSlope20) && fin(obvSlope20)) {
    if (priceSlope20 > 0.05 && obvSlope20 < -0.1) divergence = 'bearish'
    else if (priceSlope20 < -0.05 && obvSlope20 > 0.1) divergence = 'bullish'
  }

  let upVol = 0
  let downVol = 0
  for (let i = Math.max(1, n - 20); i < n; i++) {
    const d = bars[i]!.c - bars[i - 1]!.c
    if (d > 0) upVol += bars[i]!.v
    else if (d < 0) downVol += bars[i]!.v
  }
  const upDownRatio20 = n > 20 && upVol + downVol > 0 ? (upVol + 1) / (downVol + 1) : undefined

  let distributionDays = 0
  let accumulationDays = 0
  for (let i = Math.max(1, n - 25); i < n; i++) {
    const b = bars[i]!
    const p = bars[i - 1]!
    const ch = (b.c - p.c) / p.c
    if (b.v > p.v) {
      if (ch <= -0.002) distributionDays++
      else if (ch >= 0.002) accumulationDays++
    }
  }

  const atr14 = atr(bars)
  const changePct = lastBar && prev ? ((lastBar.c - prev.c) / prev.c) * 100 : undefined
  const range = lastBar ? lastBar.h - lastBar.l : undefined
  const rangeVsAtr = fin(range) && atr14 ? range / atr14 : undefined
  const closeLocation = lastBar && range && range > 0 ? (lastBar.c - lastBar.l) / range : undefined
  let character = bi('ordinary session', '普通交易日')
  let lastScore: number | undefined
  if (fin(changePct) && fin(volVs50)) {
    const heavy = volVs50 >= 1.5
    const wide = fin(rangeVsAtr) && rangeVsAtr >= 1.5
    const moveAtr = atr14 && lastBar && prev ? Math.abs(lastBar.c - prev.c) / atr14 : 0
    const up = changePct >= 0
    const ud = up ? 'up' : 'down'
    if (heavy && wide) character = bi(`wide-range ${ud} day on heavy volume`, `放量宽幅${up ? '上涨' : '下跌'}日`)
    else if (heavy && moveAtr < 0.3) character = bi('churn: heavy volume, little progress', '放量滞涨：成交放大但价格几乎未动')
    else if (heavy) character = bi(`${ud} day on heavy volume`, `放量${up ? '上涨' : '下跌'}日`)
    else if (volVs50 < 0.7) character = bi(`quiet ${ud} day on light volume`, `缩量${up ? '小涨' : '小跌'}日`)
    else character = bi(`${ud} day on normal volume`, `量能正常的${up ? '上涨' : '下跌'}日`)
    // heavier volume makes the day count more; closing near the high (low) adds to an up (down) read
    const weightByVol = clamp(volVs50 - 0.7, 0, 1)
    const loc = fin(closeLocation) ? (closeLocation - 0.5) * 2 : 0
    lastScore = clamp((sign(changePct) * 0.7 + loc * 0.3) * weightByVol, -1, 1)
    if (heavy && moveAtr < 0.3) lastScore = clamp(lastScore - 0.3, -1, 1)
  }

  const comp: Record<string, number | undefined> = {
    upDown: fin(upDownRatio20) ? Math.tanh(Math.log(upDownRatio20) / 0.5) : undefined,
    obv: fin(obvSlope20) ? Math.tanh(obvSlope20 / 0.3) : undefined,
    accDist: n > 25 ? Math.tanh((accumulationDays - distributionDays) / 4) : undefined,
    divergence: fin(obvSlope20) && fin(priceSlope20) ? (divergence === 'bearish' ? -1 : divergence === 'bullish' ? 1 : 0) : undefined,
    lastSession: lastScore,
  }
  const { score: raw, agreement } = combine(Object.entries(comp).map(([k, s]) => ({ w: VOLUME_WEIGHTS[k as keyof typeof VOLUME_WEIGHTS], s })))
  const score = hasVolume ? clampScore(raw * 100) : 0
  let confidence = 0.35 + 0.4 * agreement
  if (n < 60) confidence -= 0.2
  confidence = hasVolume && n > 20 ? clamp(confidence, 0.05, 0.9) : 0

  const readings: Reading[] = []
  if (fin(volVs50)) readings.push({ name: bi('Volume vs 50d avg', '成交量 / 50 日均量'), value: `${volVs50.toFixed(2)}×` })
  if (fin(upDownRatio20))
    readings.push({
      name: bi('Up/down volume (20d)', '上涨/下跌成交量比（20 日）'),
      value: Number(upDownRatio20.toFixed(2)),
      note: upDownRatio20 >= 1.2 ? bi('buyers heavier', '买盘更重') : upDownRatio20 <= 0.83 ? bi('sellers heavier', '卖盘更重') : bi('balanced', '买卖均衡'),
    })
  if (fin(obvSlope20))
    readings.push({ name: bi('OBV slope (20d)', 'OBV 斜率（20 日）'), value: Number(obvSlope20.toFixed(2)), note: bi(`price ${pct(priceSlope20 ?? 0, 2)}/day`, `价格 ${pct(priceSlope20 ?? 0, 2)}/日`) })
  readings.push({ name: bi('Distribution / accumulation (25d)', '派发日 / 吸筹日（25 日）'), value: `${distributionDays} / ${accumulationDays}` })
  readings.push({
    name: bi('Last session', '最近交易日'),
    value: character,
    note: joinText(
      [
        fin(changePct) ? pct(changePct, 2) : '',
        fin(rangeVsAtr) ? bi(`range ${rangeVsAtr.toFixed(1)}× ATR`, `振幅 ${rangeVsAtr.toFixed(1)} 倍 ATR`) : '',
        fin(volVs50) ? bi(`vol ${volVs50.toFixed(1)}×`, `量 ${volVs50.toFixed(1)} 倍均量`) : '',
      ].filter(x => x !== ''),
      ', ',
      '，',
    ),
  })

  const flags: Text[] = []
  if (!hasVolume) flags.push(bi('No volume data', '无成交量数据'))
  if (divergence === 'bearish') flags.push(bi('Bearish divergence: price rising while OBV falls', '顶背离：价格上涨而 OBV 下降'))
  if (divergence === 'bullish') flags.push(bi('Bullish divergence: price falling while OBV rises', '底背离：价格下跌而 OBV 上升'))
  if (distributionDays >= 5)
    flags.push(bi(`${distributionDays} distribution days in 25 sessions: institutional selling`, `25 个交易日内出现 ${distributionDays} 个派发日：机构在卖出`))
  if (accumulationDays >= 5 && accumulationDays - distributionDays >= 3)
    flags.push(bi(`${accumulationDays} accumulation days in 25 sessions`, `25 个交易日内出现 ${accumulationDays} 个吸筹日`))
  if (fin(volVs50) && volVs50 >= 2)
    flags.push(bi(`Last session: ${character.en} (${volVs50.toFixed(1)}× average)`, `最近交易日：${character.zh}（均量的 ${volVs50.toFixed(1)} 倍）`))

  const label = !hasVolume
    ? bi('No volume read', '无成交量判断')
    : score >= 40
      ? bi('Accumulation', '吸筹')
      : score >= 15
        ? bi('Volume leans positive', '量能偏积极')
        : score > -15
          ? bi('Volume neutral', '量能中性')
          : score > -40
            ? bi('Volume leans negative', '量能偏消极')
            : bi('Distribution', '派发')
  const udr = fin(upDownRatio20) ? upDownRatio20.toFixed(2) : '-'
  const verdict = hasVolume
    ? bi(
        `${label.en}: up/down volume ${udr}, ${distributionDays} distribution vs ${accumulationDays} accumulation days${divergence !== 'none' ? `, ${divergence} OBV divergence` : ''}.`,
        `${label.zh}：上涨/下跌成交量比 ${udr}，派发日 ${distributionDays} 个、吸筹日 ${accumulationDays} 个${divergence !== 'none' ? `，OBV ${DIVERGENCE_ZH[divergence]}` : ''}。`,
      )
    : bi(`${label.en}.`, `${label.zh}。`)

  return {
    key: 'volume',
    score,
    confidence,
    verdict,
    readings,
    flags,
    stats: {
      volVs50,
      avgVol50,
      priceSlope20,
      obvSlope20,
      divergence,
      upDownRatio20,
      distributionDays,
      accumulationDays,
      lastSession: { changePct, rangeVsAtr, volVs50, closeLocation, character },
      components: comp,
    },
  }
}

/* ------------------------------------------------------------- key levels */

export type LevelKind = 'swing high' | 'swing low' | 'MA20' | 'MA50' | 'MA200' | '52w high' | '52w low'
export type LevelPoint = { price: number; kind: LevelKind; date?: string }

const LEVEL_KIND_ZH: Record<LevelKind, string> = {
  'swing high': '波段高点',
  'swing low': '波段低点',
  MA20: '20 日均线',
  MA50: '50 日均线',
  MA200: '200 日均线',
  '52w high': '52 周高点',
  '52w low': '52 周低点',
}

/** What a key level is, in both languages. */
export const levelKindText = (kind: LevelKind): Text => bi(kind, LEVEL_KIND_ZH[kind])

const LEVEL_RANK: Record<LevelKind, number> = { '52w high': 5, '52w low': 5, MA200: 4, MA50: 3, 'swing high': 2, 'swing low': 2, MA20: 1 }

/**
 * Supports below and resistances above `spot` (default: last close) with what
 * each level is: swing highs/lows of the past year (either side of price),
 * MA20/50/200 and the 52-week high/low. Nearest first, at least 1% apart,
 * at most 4 each.
 */
export function keyLevelsDetail(bars: Bar[], spot?: number): { supports: LevelPoint[]; resistances: LevelPoint[] } {
  if (!bars.length) return { supports: [], resistances: [] }
  const px = spot ?? last(bars)!.c
  const year = bars.slice(-YEAR)
  const cands: LevelPoint[] = []
  const { lows, highs } = swings(year, 5)
  for (const p of lows) cands.push({ price: p.price, kind: 'swing low', date: p.date })
  for (const p of highs) cands.push({ price: p.price, kind: 'swing high', date: p.date })
  const closes = bars.map(b => b.c)
  for (const [kind, n] of [['MA20', 20], ['MA50', 50], ['MA200', 200]] as const) {
    const v = last(sma(closes, n))
    if (fin(v)) cands.push({ price: v, kind })
  }
  let hi = year[0]!
  let lo = year[0]!
  for (const b of year) {
    if (b.h > hi.h) hi = b
    if (b.l < lo.l) lo = b
  }
  cands.push({ price: hi.h, kind: '52w high', date: hi.t }, { price: lo.l, kind: '52w low', date: lo.t })

  // Within 1% of each other the stronger kind wins, else the nearer level.
  const near = (a: LevelPoint, b: LevelPoint) => Math.abs(a.price - b.price) / Math.min(a.price, b.price) < 0.01
  const pick = (side: LevelPoint[]) => {
    const out: LevelPoint[] = []
    for (const p of side.sort((a, b) => Math.abs(a.price - px) - Math.abs(b.price - px))) {
      const clash = out.filter(q => near(p, q))
      if (!clash.length) {
        if (out.length < 4) out.push(p)
      } else if (clash.length === 1 && LEVEL_RANK[p.kind] > LEVEL_RANK[clash[0]!.kind]) {
        out[out.indexOf(clash[0]!)] = p
      }
    }

    return out.sort((a, b) => Math.abs(a.price - px) - Math.abs(b.price - px))
  }

  return {
    supports: pick(cands.filter(p => p.price < px)),
    resistances: pick(cands.filter(p => p.price > px)),
  }
}

export function keyLevels(bars: Bar[], spot?: number): Levels {
  const d = keyLevelsDetail(bars, spot)

  return { supports: d.supports.map(p => p.price), resistances: d.resistances.map(p => p.price) }
}
