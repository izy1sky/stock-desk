// Forward-looking estimates: lognormal probabilities, expected moves,
// bull/base/bear scenarios and a historical-analog study.
// The probability model is zero-drift lognormal with 252 trading days a year;
// it never folds in the directional signal, which is reported beside it.

import { sma } from '../analysis'
import { normCdf, quantile, realizedVolSeries, rsiSeries, TRADING_DAYS } from './indicators'
import { fmtPrice } from './technicals'
import { bi, biasText } from '../i18n'
import { biasOf, type Bar, type Bias, type Levels, type Text } from './types'

const fin = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

/** σ√T for `days` trading days. */
const spread = (sigma: number, days: number) => sigma * Math.sqrt(Math.max(0, days) / TRADING_DAYS)

/**
 * P(close above strike after `days` trading days): N(d2),
 * d2 = (ln(S/K) − σ²T/2) / (σ√T), zero drift.
 */
export function probAbove(spot: number, strike: number, sigma: number, days: number): number {
  if (!(spot > 0) || !(strike > 0)) return NaN
  const s = spread(sigma, days)
  if (!(s > 0)) return spot > strike ? 1 : 0

  return normCdf((Math.log(spot / strike) - (s * s) / 2) / s)
}

/**
 * P(trading at `level` at some point within `days`): reflection-principle
 * approximation, 2 × P(finishing beyond the level), capped at 1.
 */
export function probTouch(spot: number, level: number, sigma: number, days: number): number {
  if (!(spot > 0) || !(level > 0)) return NaN
  if (level === spot) return 1
  const above = probAbove(spot, level, sigma, days)
  const beyond = level > spot ? above : 1 - above

  return Math.min(1, 2 * beyond)
}

export type ExpectedMove = {
  days: number
  label: Text
  /** 1σ move in % (σ√T × 100). */
  pct1: number
  /** Lognormal bands: spot × exp(∓kσ√T). */
  lower1: number
  upper1: number
  lower2: number
  upper2: number
}

/** ±1σ and ±2σ price bands for 1 day, 1 week (5 days) and 1 month (21 days). */
export function expectedMoves(spot: number, sigma: number): ExpectedMove[] {
  return (
    [
      [1, bi('1 day', '1 日')],
      [5, bi('1 week', '1 周')],
      [21, bi('1 month', '1 个月')],
    ] as const
  ).map(([days, label]) => {
    const s = spread(sigma, days)

    return {
      days,
      label,
      pct1: s * 100,
      lower1: spot * Math.exp(-s),
      upper1: spot * Math.exp(s),
      lower2: spot * Math.exp(-2 * s),
      upper2: spot * Math.exp(2 * s),
    }
  })
}

export type Scenario = {
  name: 'bull' | 'base' | 'bear'
  /** Price target (bull, bear). */
  target?: number
  /** Inclusive range (base): [low, high]. */
  range?: [number, number]
  /** Move from spot to the target in % (base: to the range edges). */
  movePct: number | [number, number]
  /** Touch probability for bull/bear; probability of finishing inside the range for base. */
  probability: number
  probKind: 'touch' | 'finish inside'
  /** Where the target came from. */
  source: 'level' | '1 sigma'
  trigger: Text
  invalidation: Text
}

export type Scenarios = {
  spot: number
  sigma: number
  days: number
  rows: Scenario[]
  /** The composite directional signal, passed through untouched. */
  compositeScore: number
  bias: Bias
  note: Text
}

/**
 * Bull / base / bear for the next `days` sessions. Bull targets the nearest
 * resistance at least 0.5σ√T away (else +1σ), bear the nearest such support
 * (else −1σ); base is the range between them. Probabilities come from the
 * lognormal model only; compositeScore is returned beside them, not mixed in.
 */
export function scenarios(input: { spot: number; sigma: number; days: number; levels: Levels; compositeScore: number }): Scenarios {
  const { spot, sigma, days, levels, compositeScore } = input
  const s = spread(sigma, days)
  const res = [...levels.resistances].filter(r => r > spot).sort((a, b) => a - b)
  const sup = [...levels.supports].filter(r => r < spot).sort((a, b) => b - a)
  const bullLevel = res.find(r => Math.log(r / spot) >= 0.5 * s)
  const bearLevel = sup.find(r => Math.log(spot / r) >= 0.5 * s)
  const bull = bullLevel ?? spot * Math.exp(s)
  const bear = bearLevel ?? spot * Math.exp(-s)
  // Levels closer than 0.25σ√T are noise for a trigger or an invalidation.
  const r1 = res.find(r => Math.log(r / spot) >= 0.25 * s)
  const s1 = sup.find(r => Math.log(spot / r) >= 0.25 * s)
  const mv = (x: number) => ((x - spot) / spot) * 100
  const f = fmtPrice

  // Trigger: the first meaningful level in the way of the target; invalidation: the first on the other side.
  const bullTrigger = r1 !== undefined && r1 < bull ? bi(`close above ${f(r1)}`, `收盘站上 ${f(r1)}`) : bi(`push through ${f(bull)}`, `向上突破 ${f(bull)}`)
  const bearTrigger = s1 !== undefined && s1 > bear ? bi(`close below ${f(s1)}`, `收盘跌破 ${f(s1)}`) : bi(`break down to ${f(bear)}`, `下探至 ${f(bear)}`)
  const bullStop = s1 !== undefined && s1 > bear ? s1 : bear
  const bearStop = r1 !== undefined && r1 < bull ? r1 : bull

  const rows: Scenario[] = [
    {
      name: 'bull',
      target: bull,
      movePct: mv(bull),
      probability: probTouch(spot, bull, sigma, days),
      probKind: 'touch',
      source: bullLevel !== undefined ? 'level' : '1 sigma',
      trigger: bullTrigger,
      invalidation: bi(`close below ${f(bullStop)}`, `收盘跌破 ${f(bullStop)}`),
    },
    {
      name: 'base',
      range: [bear, bull],
      movePct: [mv(bear), mv(bull)],
      probability: Math.max(0, probAbove(spot, bear, sigma, days) - probAbove(spot, bull, sigma, days)),
      probKind: 'finish inside',
      source: bullLevel !== undefined || bearLevel !== undefined ? 'level' : '1 sigma',
      trigger: bi(`holds between ${f(bear)} and ${f(bull)}`, `维持在 ${f(bear)} 至 ${f(bull)} 之间`),
      invalidation: bi(`close outside ${f(bear)} – ${f(bull)}`, `收盘脱离 ${f(bear)} – ${f(bull)} 区间`),
    },
    {
      name: 'bear',
      target: bear,
      movePct: mv(bear),
      probability: probTouch(spot, bear, sigma, days),
      probKind: 'touch',
      source: bearLevel !== undefined ? 'level' : '1 sigma',
      trigger: bearTrigger,
      invalidation: bi(`close above ${f(bearStop)}`, `收盘站上 ${f(bearStop)}`),
    },
  ]
  const bias = biasOf(compositeScore)
  const sig = `${compositeScore >= 0 ? '+' : ''}${Math.round(compositeScore)}`
  const note = bi(
    `Odds are a zero-drift lognormal model at σ ${(sigma * 100).toFixed(1)}% over ${days} sessions; bull/bear are touch odds, base is the odds of finishing inside, so they overlap. ` +
      `The signal (${sig}, ${bias}) is not priced in.`,
    `概率来自零漂移对数正态模型（σ ${(sigma * 100).toFixed(1)}%，${days} 个交易日）；乐观/悲观为触及概率，基准为收于区间内的概率，三者有重叠。` +
      `方向信号（${sig}，${biasText(bias).zh}）未计入概率。`,
  )

  return { spot, sigma, days, rows, compositeScore, bias, note }
}

/* ---------------------------------------------------------------- analogs */

export const ANALOG_FEATURES = [
  'vsMa20',
  'vsMa50',
  'vsMa200',
  'ma50Slope10',
  'rsi14',
  'rv20Pct1y',
  'fromHigh52',
  'ret20',
  'upDownVol20',
] as const
export type AnalogFeature = (typeof ANALOG_FEATURES)[number]

/**
 * Feature rows for every bar, computed only from bars 0..i (rolling, O(n)).
 * `null` until all features exist (about 272 bars). Units: % for distances
 * and returns, RSI 0..100, percentile 0..100, ln(up vol / down vol).
 */
export function analogFeatures(bars: Bar[]): (number[] | null)[] {
  const n = bars.length
  const closes = bars.map(b => b.c)
  const m20 = sma(closes, 20)
  const m50 = sma(closes, 50)
  const m200 = sma(closes, 200)
  const rsi = rsiSeries(closes, 14)
  const rv = realizedVolSeries(closes, 20)
  const out: (number[] | null)[] = new Array(n).fill(null)
  // rolling max of highs over 252 bars (monotonic deque of indices)
  const dq: number[] = []
  let head = 0
  let upVol = 0
  let downVol = 0
  const signedVol = (i: number) => {
    const d = closes[i]! - closes[i - 1]!

    return d > 0 ? bars[i]!.v : d < 0 ? -bars[i]!.v : 0
  }
  for (let i = 0; i < n; i++) {
    while (dq.length > head && bars[dq[dq.length - 1]!]!.h <= bars[i]!.h) dq.pop()
    dq.push(i)
    while (dq[head]! <= i - 252) head++
    if (head > 512) {
      dq.splice(0, head)
      head = 0
    }
    if (i >= 1) {
      const v = signedVol(i)
      if (v > 0) upVol += v
      else downVol -= v
    }
    if (i >= 21) {
      const v = signedVol(i - 20)
      if (v > 0) upVol -= v
      else downVol += v
    }
    if (i < 271) continue
    const c = closes[i]!
    const a20 = m20[i], a50 = m50[i], a200 = m200[i], a50ago = m50[i - 10], r = rsi[i], vol = rv[i]
    if (!fin(a20) || !fin(a50) || !fin(a200) || !fin(a50ago) || !fin(r) || !fin(vol)) continue
    // RV20 percentile within its trailing year (252 values ending at i)
    let below = 0, equal = 0, count = 0
    for (let j = i - 251; j <= i; j++) {
      const x = rv[j]
      if (!fin(x)) continue
      count++
      if (x < vol) below++
      else if (x === vol) equal++
    }
    const hi52 = bars[dq[head]!]!.h
    out[i] = [
      (c / a20 - 1) * 100,
      (c / a50 - 1) * 100,
      (c / a200 - 1) * 100,
      (a50 / a50ago - 1) * 100,
      r,
      count ? (100 * (below + equal / 2)) / count : 50,
      (c / hi52 - 1) * 100,
      (c / closes[i - 20]! - 1) * 100,
      Math.log((Math.max(0, upVol) + 1) / (Math.max(0, downVol) + 1)),
    ]
  }

  return out
}

export type ForwardStats = {
  n: number
  /** Share of positive forward returns, 0..100. */
  winRate: number
  mean: number
  median: number
  p10: number
  p90: number
}

export type AnalogHorizon = {
  days: number
  analogs: ForwardStats
  /** Every eligible day, unconditional. */
  baseline: ForwardStats
}

export type AnalogDate = {
  date: string
  index: number
  distance: number
  /** Forward return in % per horizon (keyed by days). */
  forward: Record<number, number>
}

export type AnalogStudy =
  | {
      ok: true
      asOf: string
      k: number
      minGap: number
      /** Days with all features and a complete forward window for the longest horizon. */
      eligibleDays: number
      /** Last bar index a pick may have (last index − longest horizon). */
      lastEligibleIndex: number
      horizons: AnalogHorizon[]
      closest: AnalogDate[]
      /** Today's raw feature values. */
      today: Record<AnalogFeature, number>
      note: Text
    }
  | { ok: false; note: Text }

function forwardStats(rets: number[]): ForwardStats {
  const s = [...rets].sort((a, b) => a - b)
  const n = s.length

  return {
    n,
    winRate: n ? (100 * s.filter(x => x > 0).length) / n : NaN,
    mean: n ? s.reduce((a, b) => a + b, 0) / n : NaN,
    median: quantile(s, 0.5),
    p10: quantile(s, 0.1),
    p90: quantile(s, 0.9),
  }
}

/**
 * Historical analogs: the k past days whose setup (trend, momentum, vol,
 * drawdown, volume features, z-scored over history) is nearest today's, at
 * least `minGap` sessions apart, with forward returns over each horizon
 * compared with the unconditional baseline. Only days whose longest forward
 * window ends inside the data are eligible, and every feature uses data up to
 * its own day only.
 */
export function analogs(bars: Bar[], opts?: { horizons?: number[]; k?: number; minGap?: number }): AnalogStudy {
  const horizons = [...new Set((opts?.horizons ?? [5, 20]).filter(h => Number.isInteger(h) && h > 0))].sort((a, b) => a - b)
  const k = Math.max(1, Math.floor(opts?.k ?? 40))
  const minGap = Math.max(1, Math.floor(opts?.minGap ?? 5))
  if (bars.length < 400) return { ok: false, note: bi(`Analogs need about 400 sessions of history; have ${bars.length}.`, `历史相似样本需要约 400 个交易日的历史，当前只有 ${bars.length} 个。`) }
  if (!horizons.length) return { ok: false, note: bi('No valid horizons.', '没有有效的周期。') }
  const maxH = horizons[horizons.length - 1]!
  const feats = analogFeatures(bars)
  const lastIdx = bars.length - 1
  const today = feats[lastIdx]
  if (!today) return { ok: false, note: bi('Not enough history to compute today’s features.', '历史数据不足，无法计算今日特征。') }

  // z-score each feature over all days that have it
  const dim = ANALOG_FEATURES.length
  const mu = new Array(dim).fill(0)
  const sd = new Array(dim).fill(0)
  let count = 0
  for (const f of feats) {
    if (!f) continue
    count++
    for (let d = 0; d < dim; d++) mu[d] += f[d]!
  }
  for (let d = 0; d < dim; d++) mu[d] /= count
  for (const f of feats) {
    if (!f) continue
    for (let d = 0; d < dim; d++) sd[d] += (f[d]! - mu[d]) ** 2
  }
  for (let d = 0; d < dim; d++) sd[d] = Math.sqrt(sd[d] / Math.max(1, count - 1))
  const z = (f: number[], d: number) => (sd[d] > 0 ? (f[d]! - mu[d]) / sd[d] : 0)
  const zToday = today.map((_, d) => z(today, d))

  const lastEligibleIndex = lastIdx - maxH
  const cands: { i: number; dist: number }[] = []
  for (let i = 0; i <= lastEligibleIndex; i++) {
    const f = feats[i]
    if (!f) continue
    let s = 0
    for (let d = 0; d < dim; d++) s += (z(f, d) - zToday[d]!) ** 2
    cands.push({ i, dist: Math.sqrt(s) })
  }
  if (cands.length < k * 2)
    return {
      ok: false,
      note: bi(`Only ${cands.length} eligible past days; need at least ${k * 2} for ${k} analogs.`, `仅有 ${cands.length} 个可用历史交易日；取 ${k} 个相似样本至少需要 ${k * 2} 个。`),
    }
  cands.sort((a, b) => a.dist - b.dist)
  const picked: { i: number; dist: number }[] = []
  for (const c of cands) {
    if (picked.every(p => Math.abs(p.i - c.i) >= minGap)) picked.push(c)
    if (picked.length === k) break
  }

  const fwd = (i: number, h: number) => (bars[i + h]!.c / bars[i]!.c - 1) * 100
  const horizonRows: AnalogHorizon[] = horizons.map(h => {
    const base: number[] = []
    for (let i = 0; i + h <= lastIdx; i++) if (feats[i]) base.push(fwd(i, h))

    return { days: h, analogs: forwardStats(picked.map(p => fwd(p.i, h))), baseline: forwardStats(base) }
  })
  const closest: AnalogDate[] = picked.slice(0, 5).map(p => ({
    date: bars[p.i]!.t,
    index: p.i,
    distance: Number(p.dist.toFixed(3)),
    forward: Object.fromEntries(horizons.map(h => [h, Number(fwd(p.i, h).toFixed(2))])),
  }))
  const todayRec = Object.fromEntries(ANALOG_FEATURES.map((name, d) => [name, today[d]!])) as Record<AnalogFeature, number>
  const h0 = horizonRows[horizonRows.length - 1]!
  const edge = h0.analogs.mean - h0.baseline.mean
  const since = bars[cands.reduce((m, c) => Math.min(m, c.i), lastIdx)]!.t
  const sgn = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`
  const note = bi(
    `${picked.length} analogs from ${cands.length} eligible days since ${since}. ` +
      `${h0.days}-day mean ${sgn(h0.analogs.mean)}% vs baseline ${sgn(h0.baseline.mean)}% ` +
      `(${sgn(edge)} pts). Analog samples overlap and are small: treat as context, not a forecast.`,
    `自 ${since} 起的 ${cands.length} 个可用交易日中选出 ${picked.length} 个相似样本。` +
      `${h0.days} 日平均收益 ${sgn(h0.analogs.mean)}%，基准（全部交易日）${sgn(h0.baseline.mean)}%` +
      `（差 ${sgn(edge)} 个百分点）。相似样本彼此重叠且数量少：仅作参考，不是预测。`,
  )

  return {
    ok: true,
    asOf: bars[lastIdx]!.t,
    k,
    minGap,
    eligibleDays: cands.length,
    lastEligibleIndex,
    horizons: horizonRows,
    closest,
    today: todayRec,
    note,
  }
}
