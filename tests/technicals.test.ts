import { expect, test } from 'claude-code/testing'

import type { Bar } from '../types'
import { isText, type Text } from '../hooks/i18n'
import { adx, ema, normCdf, percentileRank, realizedVol, slopePct, weekly } from '../hooks/engine/indicators'
import {
  divergenceText,
  ivRichText,
  keyLevels,
  keyLevelsDetail,
  levelKindText,
  sigmaSourceText,
  structureText,
  trendModule,
  volatilityModule,
  volTrendText,
  volumeModule,
} from '../hooks/engine/technicals'

/** Every Text pair inside a value, with where it sits. */
function texts(x: unknown, path = '$', out: { path: string; t: Text }[] = []): { path: string; t: Text }[] {
  if (Array.isArray(x)) x.forEach((v, i) => texts(v, `${path}[${i}]`, out))
  else if (isText(x)) out.push({ path, t: x })
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) texts(v, `${path}.${k}`, out)

  return out
}

/** Each non-empty Text has a Chinese side with at least one CJK character. */
function expectTranslated(x: unknown) {
  const all = texts(x)
  expect(all.length).toBeGreaterThan(0)
  expect(all.filter(({ t }) => t.en !== '' && !/[一-鿿]/.test(t.zh)).map(({ path, t }) => `${path}: ${t.zh}`)).toEqual([])
}

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
  expect(t.verdict.en).toMatch(/^Uptrend/)
  expect(t.verdict.zh).toMatch(/^上升趋势（看多）：/)
  const a = adx(bars)!
  expect(a.plusDI).toBeGreaterThan(a.minusDI)
})

test('a steady downtrend scores bearish', () => {
  const bars = series(repeat(320, { drift: -0.0015, vol: 0.01 }))
  const t = trendModule(bars)
  expect(t.score).toBeLessThan(-40)
  expect(t.stats.bearPairs).toBeGreaterThanOrEqual(3)
  expect(t.stats.structure).not.toBe('higher highs, higher lows')
  expect(t.verdict.en).toMatch(/^Downtrend \(bearish\)/)
  expect(t.verdict.zh).toContain('下降趋势')
  expect(t.verdict.zh).toContain('看空')
})

test('a choppy range is neutral and range-bound', () => {
  const bars = series(repeat(320, { drift: 0, vol: 0.01, meanRevert: 0.3 }))
  const t = trendModule(bars)
  expect(Math.abs(t.score)).toBeLessThan(25)
  expect(t.stats.adx!).toBeLessThan(25)
  expect(t.stats.rangeBound).toBe(true)
  expect(t.flags.some(f => f.en.startsWith('Range-bound'))).toBe(true)
  expect(t.flags.some(f => f.zh.startsWith('区间震荡：ADX'))).toBe(true)
})

test('a volatility squeeze is flagged, then the breakout reads as expanding vol and accumulation', () => {
  const calm = series([...repeat(300, { drift: 0, vol: 0.015 }), ...repeat(40, { drift: 0, vol: 0.002 })])
  const v = volatilityModule(calm)
  expect(v.stats.squeeze).toBe(true)
  expect(v.flags.some(f => f.en.startsWith('Bollinger squeeze'))).toBe(true)
  expect(v.flags.some(f => f.zh.startsWith('布林带收口（squeeze）'))).toBe(true)
  expect(v.verdict.zh).toContain('布林带收口')
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
  expect(v.flags.some(f => /distribution days/.test(f.en))).toBe(true)
  expect(v.flags.some(f => /派发日/.test(f.zh))).toBe(true)
  expect(v.verdict.zh).toMatch(/派发日 \d+ 个/)
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

test('trend, volatility and volume speak Chinese everywhere, English unchanged', () => {
  const up = series(repeat(320, { drift: 0.0015, vol: 0.01 }))
  const range = series(repeat(320, { drift: 0, vol: 0.01, meanRevert: 0.3 }))
  const calm = series([...repeat(300, { drift: 0, vol: 0.015 }), ...repeat(40, { drift: 0, vol: 0.002 })])
  const breakout = series([...repeat(300, { drift: 0, vol: 0.015 }), ...repeat(40, { drift: 0, vol: 0.002 }), ...repeat(8, { drift: 0.02, vol: 0.03, volume: 3e6 })])
  for (const bars of [up, range, breakout, series(repeat(15, { drift: 0.001, vol: 0.01 }))]) expectTranslated(trendModule(bars))
  for (const r of [volatilityModule(calm), volatilityModule(calm, { iv: 0.4 }), volatilityModule(breakout, { iv: 0.05 }), volatilityModule(series(repeat(15, { drift: 0, vol: 0.01 })))])
    expectTranslated(r)
  for (const bars of [breakout, calm, up]) expectTranslated(volumeModule(bars))
  expectTranslated(volumeModule([]))

  const t = trendModule(up)
  const stack = t.readings.find(r => r.name.en === 'MA stack')!
  expect(stack.name.zh).toBe('均线排列')
  expect(stack.note).toEqual({ en: 'fully bullish order', zh: '完全多头排列' })
  expect(t.readings.find(r => r.name.en === 'Structure (3m)')!.value).toEqual(structureText(t.stats.structure))

  const v = volatilityModule(calm, { iv: 0.4 })
  expect(v.flags.some(f => f.zh.startsWith('期权偏贵：IV 40.0%'))).toBe(true)
  expect(v.readings.find(r => r.name.en === 'Forecast sigma')!.note).toEqual({ en: 'implied vol', zh: '隐含波动率' })

  const vol = volumeModule(breakout)
  expect(vol.stats.lastSession.character.en).toMatch(/day/)
  expect(vol.stats.lastSession.character.zh).toMatch(/[一-鿿]/)
})

test('enum translators cover every key', () => {
  for (const k of ['higher highs, higher lows', 'lower highs, lower lows', 'mixed', 'unknown'] as const) expect(structureText(k).en).toBe(k)
  expect(structureText('higher highs, higher lows').zh).toBe('高点抬高、低点抬高')
  for (const k of ['expanding', 'contracting', 'stable', 'unknown'] as const) expectTranslated(volTrendText(k))
  expect(volTrendText('expanding').zh).toBe('放大')
  for (const k of ['rich', 'cheap', 'fair'] as const) expectTranslated(ivRichText(k))
  for (const k of ['iv', 'realized', 'none'] as const) expectTranslated(sigmaSourceText(k))
  for (const k of ['bearish', 'bullish', 'none'] as const) expectTranslated(divergenceText(k))
  expect(divergenceText('bearish').zh).toBe('顶背离')
  const kinds = ['swing high', 'swing low', 'MA20', 'MA50', 'MA200', '52w high', '52w low'] as const
  for (const k of kinds) expect(levelKindText(k).en).toBe(k)
  expectTranslated(kinds.map(levelKindText))
  expect(levelKindText('52w high').zh).toBe('52 周高点')
  const d = keyLevelsDetail(series(repeat(300, { drift: 0, vol: 0.015 }), 11))
  expectTranslated([...d.supports, ...d.resistances].map(l => levelKindText(l.kind)))
})
