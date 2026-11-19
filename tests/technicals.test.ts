import { expect, test } from 'claude-code/testing'

import type { Bar } from '../types'
import { adx, ema, normCdf, percentileRank, realizedVol, slopePct, weekly } from '../hooks/engine/indicators'
import { keyLevels, trendModule, volatilityModule, volumeModule } from '../hooks/engine/technicals'

// Deterministic normal noise (LCG + Box-Muller).
function noise(seed: number): () => number {
  let s = seed >>> 0
  const u = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0

    return (s + 0.5) / 4294967296
  }

  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u())
}

function tradingDays(n: number): string[] {
  const out: string[] = []
  const d = new Date('2020-01-01T12:00:00Z')
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }

  return out
}

/** Bars from daily (drift, vol, volume) specs; closes compound from 100. */
function series(specs: { drift: number; vol: number; volume?: number; meanRevert?: number }[], seed = 7): Bar[] {
  const z = noise(seed)
  const days = tradingDays(specs.length)
  const bars: Bar[] = []
  let price = 100
  specs.forEach((sp, i) => {
    const open = price
    const pull = sp.meanRevert ? sp.meanRevert * Math.log(100 / price) : 0
    price = price * Math.exp(sp.drift + pull + sp.vol * z())
    const wick = Math.abs(sp.vol * z()) * 0.5 + sp.vol * 0.3
    bars.push({
      t: days[i]!,
      o: open,
      h: Math.max(open, price) * (1 + wick),
      l: Math.min(open, price) * (1 - wick),
      c: price,
      v: Math.round((sp.volume ?? 1e6) * (1 + 0.2 * z())),
    })
  })

  return bars
}

const repeat = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x)

test('indicator basics: ema, weekly bars, realized vol, percentile, slope, normal cdf', () => {
  const e = ema([1, 2, 3, 4, 5], 3)
  expect(e[1]).toBeNull()
  expect(e[2]).toBe(2)
  expect(e[3]).toBe(3)

  const bars = series(repeat(30, { drift: 0.001, vol: 0.01 }))
  const wk = weekly(bars)
  expect(wk.length).toBe(7) // 2020-01-01 is a Wednesday: 30 sessions span 7 ISO weeks
  expect(wk[0]!.c).toBe(bars[2]!.c) // Wed, Thu, Fri
  expect(wk[0]!.v).toBe(bars[0]!.v + bars[1]!.v + bars[2]!.v)
  expect(wk[1]!.o).toBe(bars[3]!.o)

  const steady = Array.from({ length: 30 }, (_, i) => 100 * 1.01 ** i)
  expect(realizedVol(steady, 20)!).toBeLessThan(1e-9)
  expect(Math.abs(slopePct(steady.map((_, i) => 10 + i), 10)! - (1 / 34.5) * 100)).toBeLessThan(1e-9)
  expect(percentileRank([1, 2, 3, 4], 3)).toBe(62.5)
  expect(Math.abs(normCdf(0) - 0.5)).toBeLessThan(1e-7)
  expect(Math.abs(normCdf(1.96) - 0.9750021)).toBeLessThan(1e-6)
  expect(Math.abs(normCdf(-1) - 0.1586553)).toBeLessThan(1e-6)
})

test('a steady uptrend scores bullish with a full MA stack', () => {
  const bars = series(repeat(320, { drift: 0.0015, vol: 0.01 }))
  const t = trendModule(bars)
  expect(t.score).toBeGreaterThan(40)
  expect(t.stats.bullPairs).toBe(4)
  expect(t.stats.rangePos).toBeGreaterThan(0.7)
  expect(t.verdict).toMatch(/^Uptrend/)
  const a = adx(bars)!
  expect(a.plusDI).toBeGreaterThan(a.minusDI)
})

test('a steady downtrend scores bearish', () => {
  const bars = series(repeat(320, { drift: -0.0015, vol: 0.01 }))
  const t = trendModule(bars)
  expect(t.score).toBeLessThan(-40)
  expect(t.stats.bearPairs).toBeGreaterThanOrEqual(3)
  expect(t.stats.structure).not.toBe('higher highs, higher lows')
})

test('a choppy range is neutral and range-bound', () => {
  const bars = series(repeat(320, { drift: 0, vol: 0.01, meanRevert: 0.3 }))
  const t = trendModule(bars)
  expect(Math.abs(t.score)).toBeLessThan(25)
  expect(t.stats.adx!).toBeLessThan(25)
  expect(t.stats.rangeBound).toBe(true)
  expect(t.flags.some(f => f.startsWith('Range-bound'))).toBe(true)
})

test('a volatility squeeze is flagged, then the breakout reads as expanding vol and accumulation', () => {
  const calm = series([...repeat(300, { drift: 0, vol: 0.015 }), ...repeat(40, { drift: 0, vol: 0.002 })])
  const v = volatilityModule(calm)
  expect(v.stats.squeeze).toBe(true)
  expect(v.flags.some(f => f.startsWith('Bollinger squeeze'))).toBe(true)
  expect(v.score).toBeGreaterThan(15)
  expect(v.stats.sigma!).toBeGreaterThanOrEqual(v.stats.rv20!)

  const breakout = series([
    ...repeat(300, { drift: 0, vol: 0.015 }),
    ...repeat(40, { drift: 0, vol: 0.002 }),
    ...repeat(8, { drift: 0.02, vol: 0.03, volume: 3e6 }),
  ])
  const vb = volatilityModule(breakout)
  expect(vb.stats.volTrend).toBe('expanding')
  expect(vb.score).toBeLessThan(0)
  const vol = volumeModule(breakout)
  expect(vol.score).toBeGreaterThan(15)
  expect(vol.stats.upDownRatio20!).toBeGreaterThan(1.5)
  expect(trendModule(breakout).score).toBeGreaterThan(0)

  // implied vol, when given, drives sigma and the rich/cheap read
  const withIv = volatilityModule(calm, { iv: 0.4 })
  expect(withIv.stats.sigma).toBe(0.4)
  expect(withIv.stats.ivRich).toBe('rich')
})

test('selling on rising volume counts distribution days and scores negative', () => {
  const specs = repeat(200, { drift: 0, vol: 0.01 })
  const bars = series(specs)
  // last 25 sessions: alternate a light up day with a heavier down day
  for (let i = bars.length - 25; i < bars.length; i++) {
    const p = bars[i - 1]!
    const down = (i - bars.length) % 2 === 0
    const c = p.c * (down ? 0.985 : 1.004)
    bars[i] = { ...bars[i]!, o: p.c, h: Math.max(p.c, c) * 1.002, l: Math.min(p.c, c) * 0.998, c, v: down ? 2e6 : 8e5 }
  }
  const v = volumeModule(bars)
  expect(v.stats.distributionDays).toBeGreaterThanOrEqual(10)
  expect(v.stats.accumulationDays).toBeLessThanOrEqual(1)
  expect(v.score).toBeLessThan(-30)
  expect(v.flags.some(f => /distribution days/.test(f))).toBe(true)
})

test('key levels sit on the right side of price, nearest first, at least 1% apart', () => {
  const bars = series(repeat(300, { drift: 0, vol: 0.015 }), 11)
  const spot = bars[bars.length - 1]!.c
  const lv = keyLevels(bars)
  expect(lv.supports.length).toBeGreaterThan(0)
  expect(lv.resistances.length).toBeGreaterThan(0)
  expect(lv.supports.length).toBeLessThanOrEqual(4)
  expect(lv.resistances.length).toBeLessThanOrEqual(4)
  expect(lv.supports.every(s => s < spot)).toBe(true)
  expect(lv.resistances.every(r => r > spot)).toBe(true)
  for (const side of [lv.supports, lv.resistances]) {
    for (let i = 1; i < side.length; i++) {
      expect(Math.abs(side[i]! - spot)).toBeGreaterThanOrEqual(Math.abs(side[i - 1]! - spot))
      for (let j = 0; j < i; j++) expect(Math.abs(side[i]! - side[j]!) / Math.min(side[i]!, side[j]!)).toBeGreaterThanOrEqual(0.01)
    }
  }
})

test('short histories degrade gracefully', () => {
  const bars = series(repeat(15, { drift: 0.001, vol: 0.01 }))
  expect(trendModule(bars).confidence).toBe(0)
  expect(volatilityModule(bars).stats.sigma).toBeUndefined()
  expect(volumeModule([]).score).toBe(0)
  expect(keyLevels([])).toEqual({ supports: [], resistances: [] })
})
