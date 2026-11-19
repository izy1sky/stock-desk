// Indicator math for the analysis engine. Pure functions over plain arrays,
// oldest value first. Series functions return one entry per input value, with
// `null` until enough history exists.

import type { Bar } from './types'

export const TRADING_DAYS = 252

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

export function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN
}

/** Sample standard deviation (n − 1). */
export function stdev(values: number[]): number {
  if (values.length < 2) return NaN
  const m = mean(values)

  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1))
}

/** Value at quantile q (0..1) of an already sorted array, linear interpolation. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q))
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)

  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

/** Exponential moving average, seeded with the simple average of the first n values. */
export function ema(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = []
  const alpha = 2 / (n + 1)
  let value = 0
  for (let i = 0; i < values.length; i++) {
    const x = values[i]!
    if (i < n - 1) {
      value += x
      out.push(null)
    } else if (i === n - 1) {
      value = (value + x) / n
      out.push(value)
    } else {
      value = alpha * x + (1 - alpha) * value
      out.push(value)
    }
  }

  return out
}

/** Wilder's RSI for every bar (null until n + 1 closes). Matches `rsi` in ../analysis. */
export function rsiSeries(closes: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null)
  if (closes.length <= n) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= n; i++) {
    const d = closes[i]! - closes[i - 1]!
    gain += Math.max(d, 0)
    loss += Math.max(-d, 0)
  }
  gain /= n
  loss /= n
  const value = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss))
  out[n] = value()
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!
    gain = (gain * (n - 1) + Math.max(d, 0)) / n
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n
    out[i] = value()
  }

  return out
}

export type AdxSeries = { adx: (number | null)[]; plusDI: (number | null)[]; minusDI: (number | null)[] }

/**
 * Wilder's ADX with +DI / −DI for every bar. DI is available from bar n,
 * ADX (the Wilder average of DX) from bar 2n − 1.
 */
export function adxSeries(bars: Bar[], n = 14): AdxSeries {
  const len = bars.length
  const adx: (number | null)[] = new Array(len).fill(null)
  const plusDI: (number | null)[] = new Array(len).fill(null)
  const minusDI: (number | null)[] = new Array(len).fill(null)
  if (len <= n) return { adx, plusDI, minusDI }
  let sTR = 0
  let sPlus = 0
  let sMinus = 0
  let dxSum = 0
  let adxValue = 0
  for (let i = 1; i < len; i++) {
    const b = bars[i]!
    const p = bars[i - 1]!
    const tr = Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c))
    const up = b.h - p.h
    const down = p.l - b.l
    const plusDM = up > down && up > 0 ? up : 0
    const minusDM = down > up && down > 0 ? down : 0
    if (i <= n) {
      sTR += tr
      sPlus += plusDM
      sMinus += minusDM
      if (i < n) continue
    } else {
      sTR = sTR - sTR / n + tr
      sPlus = sPlus - sPlus / n + plusDM
      sMinus = sMinus - sMinus / n + minusDM
    }
    const pdi = sTR > 0 ? (100 * sPlus) / sTR : 0
    const mdi = sTR > 0 ? (100 * sMinus) / sTR : 0
    plusDI[i] = pdi
    minusDI[i] = mdi
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0
    const k = i - n // 0 for the first DX
    if (k < n) {
      dxSum += dx
      if (k === n - 1) {
        adxValue = dxSum / n
        adx[i] = adxValue
      }
    } else {
      adxValue = (adxValue * (n - 1) + dx) / n
      adx[i] = adxValue
    }
  }

  return { adx, plusDI, minusDI }
}

/** ADX(n), +DI and −DI of the last bar, or undefined with fewer than 2n bars. */
export function adx(bars: Bar[], n = 14): { adx: number; plusDI: number; minusDI: number } | undefined {
  const s = adxSeries(bars, n)
  const i = bars.length - 1
  const a = s.adx[i]
  const p = s.plusDI[i]
  const m = s.minusDI[i]
  if (!finite(a) || !finite(p) || !finite(m)) return undefined

  return { adx: a, plusDI: p, minusDI: m }
}

/** On-balance volume, starting at 0. */
export function obv(bars: Bar[]): number[] {
  const out: number[] = []
  let total = 0
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      const d = bars[i]!.c - bars[i - 1]!.c
      if (d > 0) total += bars[i]!.v
      else if (d < 0) total -= bars[i]!.v
    }
    out.push(total)
  }

  return out
}

export type Bollinger = { mid: number; upper: number; lower: number; width: number }

/** Bollinger bands of the last close (population standard deviation). width = (upper − lower) / mid. */
export function bollinger(closes: number[], n = 20, k = 2): Bollinger | undefined {
  if (closes.length < n) return undefined
  const w = closes.slice(-n)
  const mid = mean(w)
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / n)
  const upper = mid + k * sd
  const lower = mid - k * sd

  return { mid, upper, lower, width: mid !== 0 ? (upper - lower) / mid : NaN }
}

/** Bollinger bandwidth ((upper − lower) / mid) for every close, rolling in O(n). */
export function bandwidthSeries(closes: number[], n = 20, k = 2): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  let sq = 0
  for (let i = 0; i < closes.length; i++) {
    const x = closes[i]!
    sum += x
    sq += x * x
    if (i >= n) {
      const y = closes[i - n]!
      sum -= y
      sq -= y * y
    }
    if (i < n - 1) {
      out.push(null)
      continue
    }
    const m = sum / n
    const sd = Math.sqrt(Math.max(0, sq / n - m * m))
    out.push(m !== 0 ? (2 * k * sd) / m : null)
  }

  return out
}

/** Daily log returns; entry i is ln(c[i] / c[i − 1]), entry 0 is null. */
export function logReturns(closes: number[]): (number | null)[] {
  return closes.map((c, i) => (i > 0 && c > 0 && closes[i - 1]! > 0 ? Math.log(c / closes[i - 1]!) : null))
}

/**
 * Annualized realized volatility (decimal, e.g. 0.18) of the last n daily log
 * returns: sample standard deviation × √252. Needs n + 1 closes.
 */
export function realizedVol(closes: number[], n: number): number | undefined {
  if (closes.length < n + 1) return undefined
  const r = logReturns(closes.slice(-(n + 1))).slice(1) as number[]
  if (r.some(x => !finite(x))) return undefined

  return stdev(r) * Math.sqrt(TRADING_DAYS)
}

/** Realized volatility for every close (window of the n returns ending there), rolling in O(n). */
export function realizedVolSeries(closes: number[], n: number): (number | null)[] {
  const r = logReturns(closes)
  const out: (number | null)[] = []
  let sum = 0
  let sq = 0
  let bad = 0
  for (let i = 0; i < closes.length; i++) {
    const x = r[i]
    if (i > 0) {
      if (finite(x)) {
        sum += x
        sq += x * x
      } else bad++
    }
    const j = i - n // return leaving the window
    if (j >= 1) {
      const y = r[j]
      if (finite(y)) {
        sum -= y
        sq -= y * y
      } else bad--
    }
    if (i < n || bad > 0) {
      out.push(null)
      continue
    }
    const m = sum / n
    const v = Math.max(0, (sq - n * m * m) / (n - 1))
    out.push(Math.sqrt(v * TRADING_DAYS))
  }

  return out
}

/** Percentile rank (0..100) of x among values: share below plus half the ties. */
export function percentileRank(values: (number | null)[], x: number): number {
  let below = 0
  let equal = 0
  let count = 0
  for (const v of values) {
    if (!finite(v)) continue
    count++
    if (v < x) below++
    else if (v === x) equal++
  }

  return count ? (100 * (below + equal / 2)) / count : NaN
}

/**
 * Least-squares slope over the last n values, as % of their mean per bar.
 * Undefined when fewer than n finite values end the series or the mean is 0.
 */
export function slopePct(values: (number | null)[], n: number): number | undefined {
  if (n < 2 || values.length < n) return undefined
  const w = values.slice(-n)
  if (!w.every(finite)) return undefined
  const ys = w as number[]
  const xm = (n - 1) / 2
  const ym = mean(ys)
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (ys[i]! - ym)
    den += (i - xm) ** 2
  }
  if (ym === 0) return undefined

  return ((num / den) / Math.abs(ym)) * 100
}

/** Raw least-squares slope (units per bar) over the last n values. */
export function slope(values: (number | null)[], n: number): number | undefined {
  if (n < 2 || values.length < n) return undefined
  const w = values.slice(-n)
  if (!w.every(finite)) return undefined
  const ys = w as number[]
  const xm = (n - 1) / 2
  const ym = mean(ys)
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (ys[i]! - ym)
    den += (i - xm) ** 2
  }

  return num / den
}

/** Monday (YYYY-MM-DD) of the ISO week holding a YYYY-MM-DD date. */
export function weekKey(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))

  return d.toISOString().slice(0, 10)
}

/**
 * Weekly bars grouped by ISO week (Monday to Sunday): o = first open,
 * h = max, l = min, c = last close, v = sum. `t` is the week's last session.
 */
export function weekly(bars: Bar[]): Bar[] {
  const out: Bar[] = []
  let key = ''
  for (const b of bars) {
    const k = weekKey(b.t)
    const cur = out[out.length - 1]
    if (cur && k === key) {
      cur.h = Math.max(cur.h, b.h)
      cur.l = Math.min(cur.l, b.l)
      cur.c = b.c
      cur.v += b.v
      cur.t = b.t
    } else {
      out.push({ ...b })
      key = k
    }
  }

  return out
}

/**
 * Standard normal CDF, Abramowitz & Stegun 26.2.17 (absolute error < 7.5e-8).
 */
export function normCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : x < 0 ? 0 : NaN
  const z = Math.abs(x)
  const t = 1 / (1 + 0.2316419 * z)
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const tail = (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) * poly

  return x >= 0 ? 1 - tail : tail
}
