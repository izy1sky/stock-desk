import { expect, test } from 'claude-code/testing'

import type { Bar } from '../types'
import { analogFeatures, analogs, expectedMoves, probAbove, probTouch, scenarios } from '../hooks/engine/forecast'

function noise(seed: number): () => number {
  let s = seed >>> 0
  const u = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0

    return (s + 0.5) / 4294967296
  }

  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u())
}

/** n bars of a noisy random walk with slow regime swings; optional crash over the last `crash` bars. */
function walk(n: number, seed = 3, crash = 0): Bar[] {
  const z = noise(seed)
  const bars: Bar[] = []
  const d = new Date('2015-01-01T12:00:00Z')
  let price = 100
  for (let i = 0; i < n; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
    const open = price
    const drift = i >= n - crash ? -0.03 : 0.0004 + 0.002 * Math.sin(i / 60)
    price = price * Math.exp(drift + 0.012 * z())
    bars.push({ t: d.toISOString().slice(0, 10), o: open, h: Math.max(open, price) * 1.004, l: Math.min(open, price) * 0.996, c: price, v: Math.round(1e6 * (1 + 0.3 * Math.abs(z()))) })
    d.setUTCDate(d.getUTCDate() + 1)
  }

  return bars
}

test('probAbove matches a hand-computed lognormal value', () => {
  // S 100, K 110, σ 30%, 63 days: σ√T = 0.15, d2 = (ln(100/110) − 0.01125) / 0.15 = −0.7104, N(d2) ≈ 0.2387
  expect(Math.abs(probAbove(100, 110, 0.3, 63) - 0.2387)).toBeLessThan(5e-4)
  expect(probAbove(100, 100, 0.2, 21)).toBeLessThan(0.5) // zero drift: the median sits below spot
  expect(probAbove(100, 90, 0, 21)).toBe(1)
})

test('touch probability is at least the finish-beyond probability, capped at 1', () => {
  for (const [level, sigma, days] of [[110, 0.3, 21], [90, 0.25, 5], [101, 0.6, 63], [150, 0.2, 10]] as const) {
    const above = probAbove(100, level, sigma, days)
    const beyond = level > 100 ? above : 1 - above
    const touch = probTouch(100, level, sigma, days)
    expect(touch).toBeGreaterThanOrEqual(beyond)
    expect(touch).toBeLessThanOrEqual(1)
  }
  expect(probTouch(100, 100, 0.2, 5)).toBe(1)
})

test('expected moves scale with the square root of time', () => {
  const [d1, w1, m1] = expectedMoves(100, 0.2)
  expect(Math.abs(d1!.pct1 - 20 / Math.sqrt(252))).toBeLessThan(1e-9)
  expect(Math.abs(m1!.pct1 / d1!.pct1 - Math.sqrt(21))).toBeLessThan(1e-9)
  expect(w1!.lower1).toBeLessThan(100)
  expect(w1!.upper2).toBeGreaterThan(w1!.upper1)
})

test('scenarios pick levels beyond half a sigma and keep the signal out of the odds', () => {
  const levels = { supports: [99.5, 95, 90], resistances: [100.4, 104, 110] }
  const a = scenarios({ spot: 100, sigma: 0.25, days: 21, levels, compositeScore: 60 })
  const b = scenarios({ spot: 100, sigma: 0.25, days: 21, levels, compositeScore: -60 })
  const [bull, base, bear] = a.rows
  // σ√T = 0.25·√(21/252) ≈ 7.2%: 0.5σ ≈ 3.6%, so 104 and 95 qualify, 100.4 and 99.5 do not
  expect(bull!.target).toBe(104)
  expect(bear!.target).toBe(95)
  expect(base!.range).toEqual([95, 104])
  expect(bull!.trigger).toMatch(/104/)
  expect(a.rows.map(r => r.probability)).toEqual(b.rows.map(r => r.probability))
  expect(a.compositeScore).toBe(60)
  expect(a.bias).toBe('bullish')
  expect(a.note).toMatch(/not priced in/)
  for (const r of a.rows) {
    expect(r.probability).toBeGreaterThan(0)
    expect(r.probability).toBeLessThanOrEqual(1)
  }
  // no levels: fall back to ±1σ
  const c = scenarios({ spot: 100, sigma: 0.25, days: 21, levels: { supports: [], resistances: [] }, compositeScore: 0 })
  expect(c.rows[0]!.source).toBe('1 sigma')
  expect(Math.abs(Math.log(c.rows[0]!.target! / 100) - 0.25 * Math.sqrt(21 / 252))).toBeLessThan(1e-9)
})

test('analogs only use days whose forward window ends inside the data, spaced apart', () => {
  const bars = walk(900)
  const a = analogs(bars, { horizons: [5, 20], k: 30, minGap: 5 })
  if (!a.ok) throw new Error(a.note)
  expect(a.lastEligibleIndex).toBe(bars.length - 1 - 20)
  expect(a.horizons.map(h => h.days)).toEqual([5, 20])
  expect(a.horizons[0]!.analogs.n).toBe(30)
  expect(a.horizons[0]!.baseline.n).toBeGreaterThan(a.horizons[1]!.baseline.n)
  expect(a.closest.length).toBe(5)
  for (const c of a.closest) {
    expect(c.index).toBeLessThanOrEqual(a.lastEligibleIndex)
    expect(c.date).toBe(bars[c.index]!.t)
    expect(c.forward[20]).toBeDefined()
  }
  for (let i = 1; i < a.closest.length; i++) {
    expect(a.closest[i]!.distance).toBeGreaterThanOrEqual(a.closest[i - 1]!.distance)
    for (let j = 0; j < i; j++) expect(Math.abs(a.closest[i]!.index - a.closest[j]!.index)).toBeGreaterThanOrEqual(5)
  }
  const h = a.horizons[1]!.analogs
  expect(h.p10).toBeLessThanOrEqual(h.median)
  expect(h.median).toBeLessThanOrEqual(h.p90)
})

test('analog features never look ahead: a crash in the last 20 bars leaves earlier features unchanged', () => {
  const calm = walk(700, 5, 0)
  const crashed = walk(700, 5, 20)
  const a = analogFeatures(calm)
  const b = analogFeatures(crashed)
  for (let i = 0; i < 680; i++) expect(b[i]).toEqual(a[i])
  expect(b[699]).not.toEqual(a[699])
  expect(a[270]).toBeNull()
  expect(a[300]).not.toBeNull()
})

test('analogs explain themselves on short history, and run fast on ten years', () => {
  const short = analogs(walk(300))
  expect(short.ok).toBe(false)
  if (!short.ok) expect(short.note).toMatch(/400 sessions/)

  const long = walk(2500, 9)
  const t0 = Date.now()
  const r = analogs(long)
  expect(Date.now() - t0).toBeLessThan(1500)
  expect(r.ok).toBe(true)
})
