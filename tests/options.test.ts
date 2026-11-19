import { expect, test } from 'claude-code/testing'

import type { Fetch } from '../hooks/engine/http'
import {
  analyzeChain,
  bsGamma,
  cboeSymbol,
  loadChain,
  loadVolIndexes,
  optionsModule,
  parseOcc,
  type Chain,
  type Contract,
  type OptionType,
} from '../hooks/engine/options'

type Res = { status: number; ok: boolean; headers: Record<string, string>; text: string }
const json = (body: unknown): Res => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(body) })
const notFound: Res = { status: 404, ok: false, headers: {}, text: '' }

/** One CBOE contract row. */
function row(option: string, f: Partial<Record<string, number>> = {}): Record<string, unknown> {
  return {
    option,
    bid: 1,
    ask: 1.2,
    iv: 0.3,
    open_interest: 100,
    volume: 10,
    delta: 0.5,
    gamma: 0.05,
    vega: 0.1,
    theta: -0.05,
    last_trade_price: 1.1,
    ...f,
  }
}

// A CBOE payload for 'XYZ' at 10:00 ET on Thu 2026-11-19, with every kind of
// row loadChain must drop or repair.
function payload(): unknown {
  return {
    timestamp: '2026-11-19 15:00:00',
    symbol: 'XYZ',
    data: {
      symbol: 'XYZ',
      security_type: 'stock',
      current_price: 100,
      prev_day_close: 99,
      close: 99,
      iv30: 31.5,
      last_trade_time: '2026-11-19T09:59:30',
      options: [
        row('XYZ261118C00100000'), // expired yesterday
        row('XYZ261120C00100000', { bid: 2, ask: 2.4, volume: 50 }), // kept, 1 day
        row('XYZ261120P00100000', { bid: 1.5, ask: 1.7, iv: 9 }), // absurd IV → 0
        row('B1XYZ261120C00100000', { open_interest: 500 }), // adjusted root
        row('XYZ261120C00150000', { bid: 0, ask: 0, iv: 0, open_interest: 0, volume: 0, delta: 0.01, gamma: -0.0008 }), // dead row
        row('XYZ261127P00095500', { gamma: -0.01 }), // negative gamma → 0
        row('XYZ261218C00105000'), // 29 days
        row('XYZ270618C00105000'), // beyond 120 days
      ],
    },
  }
}

/** A contract for hand-built chains: t from days (at least half a day). */
function c(expiry: string, days: number, type: OptionType, strike: number, f: Partial<Contract> = {}): Contract {
  const bid = f.bid ?? 0
  const ask = f.ask ?? 0

  return {
    expiry,
    days,
    t: Math.max(0.5, days) / 365,
    type,
    strike,
    bid,
    ask,
    mid: ask > 0 ? (bid + ask) / 2 : 0,
    last: 0,
    iv: 0.3,
    oi: 0,
    volume: 0,
    delta: type === 'C' ? 0.5 : -0.5,
    gamma: 0,
    ...f,
  }
}

const chainOf = (contracts: Contract[], spot = 100): Chain => ({ symbol: 'XYZ', spot, asOf: '2026-11-19T15:00:00.000Z', contracts })

test('OCC symbols parse from the tail, whatever the root', () => {
  expect(parseOcc('SPY261120C00710000')).toEqual({ root: 'SPY', expiry: '2026-11-20', type: 'C', strike: 710 })
  expect(parseOcc('B1SPY261120P00710500')).toEqual({ root: 'B1SPY', expiry: '2026-11-20', type: 'P', strike: 710.5 })
  expect(parseOcc('SPXW261218P07325000')).toEqual({ root: 'SPXW', expiry: '2026-12-18', type: 'P', strike: 7325 })
  expect(parseOcc('SPY261120X00710000')).toBeUndefined()
  expect(cboeSymbol('spx')).toBe('_SPX')
  expect(cboeSymbol('^VIX')).toBe('_VIX')
  expect(cboeSymbol('SPY')).toBe('SPY')
})

test('loadChain fetches the cdn-api host and keeps only live, standard, in-range contracts', async () => {
  const urls: string[] = []
  const fetch: Fetch = async url => {
    urls.push(url)

    return url.endsWith('/options/XYZ.json') ? json(payload()) : notFound
  }
  const chain = await loadChain(fetch, 'XYZ')
  expect(urls).toEqual(['https://cdn-api.cboe.com/api/global/delayed_quotes/options/XYZ.json'])
  expect(chain.spot).toBe(100)
  expect(chain.prevClose).toBe(99)
  expect(chain.iv30).toBe(0.315)
  // As of the underlying's last trade (09:59:30 ET is before the 10:00 snapshot).
  expect(chain.asOf).toBe('2026-11-19T14:59:30.000Z')
  expect(chain.contracts.map(k => `${k.expiry} ${k.type} ${k.strike}`)).toEqual([
    '2026-11-20 C 100',
    '2026-11-20 P 100',
    '2026-11-27 P 95.5',
    '2026-12-18 C 105',
  ])
  const [call, put, weekly, monthly] = chain.contracts
  expect(call?.days).toBe(1)
  expect(call?.mid).toBe(2.2)
  expect(call?.volume).toBe(50)
  expect(put?.iv).toBe(0)
  expect(weekly?.gamma).toBe(0)
  expect(monthly?.days).toBe(29)
  expect(call!.t).toBeGreaterThan(1 / 365)

  const near = await loadChain(fetch, 'XYZ', { maxDays: 10 })
  expect(near.contracts.map(k => k.expiry)).toEqual(['2026-11-20', '2026-11-20', '2026-11-27'])
})

test('put/call ratios by volume, near-term volume and open interest', () => {
  const s = analyzeChain(
    chainOf([
      c('2026-11-20', 1, 'C', 100, { volume: 100, oi: 1000 }),
      c('2026-11-20', 1, 'P', 100, { volume: 150, oi: 500 }),
      c('2026-12-18', 29, 'C', 100, { volume: 300, oi: 1000 }),
      c('2026-12-18', 29, 'P', 100, { volume: 50, oi: 2500 }),
    ]),
  )
  expect(s.pcVolume).toBe(0.5) // 200 / 400
  expect(s.pcVolumeNear).toBe(1.5) // 150 / 100
  expect(s.pcOi).toBe(1.5) // 3000 / 2000
  expect(s.totalOi).toBe(5000)
})

test('max pain on a hand-computed expiry, and the monthly is the third Friday', () => {
  // Payout to holders at settlement K (per contract, ×OI):
  //   K=90:  calls 0;                    puts 100·10 + 50·20 = 2000
  //   K=100: calls 100·10 = 1000;        puts 50·10 = 500     → 1500 (least)
  //   K=110: calls 100·20 + 200·10 = 4000; puts 0              → 4000
  const nov = [
    c('2026-11-20', 1, 'C', 90, { oi: 100 }),
    c('2026-11-20', 1, 'C', 100, { oi: 200 }),
    c('2026-11-20', 1, 'C', 110, { oi: 100 }),
    c('2026-11-20', 1, 'P', 90, { oi: 300 }),
    c('2026-11-20', 1, 'P', 100, { oi: 100 }),
    c('2026-11-20', 1, 'P', 110, { oi: 50 }),
  ]
  // A weekly before it with all its OI at 120 calls: max pain at its lowest strike.
  const weekly = [c('2026-11-19', 0, 'C', 95, { oi: 1 }), c('2026-11-19', 0, 'C', 120, { oi: 500 })]
  const s = analyzeChain(chainOf([...weekly, ...nov]))
  expect(s.maxPain.nearest).toEqual({ expiry: '2026-11-19', days: 0, strike: 95, monthly: false })
  expect(s.maxPain.monthly).toEqual({ expiry: '2026-11-20', days: 1, strike: 100, monthly: true })
})

test('dealer gamma: calls add, puts subtract, walls sit on the biggest strikes either side', () => {
  const e = '2026-12-18'
  const s = analyzeChain(
    chainOf([
      c(e, 29, 'C', 105, { oi: 1000 }),
      c(e, 29, 'C', 110, { oi: 400 }),
      c(e, 29, 'C', 95, { oi: 50 }), // below spot: never the call wall
      c(e, 29, 'P', 95, { oi: 1000 }),
      c(e, 29, 'P', 90, { oi: 300 }),
      c(e, 29, 'P', 105, { oi: 50 }), // above spot: never the put wall
    ]),
  )
  const row105 = s.gex.byStrike.find(r => r.strike === 105)!
  const expected = bsGamma(100, 105, 29 / 365, 0.3) * 1000 * 100 * 100 * 100 * 0.01
  expect(Math.abs(row105.call / expected - 1)).toBeLessThan(1e-9)
  expect(s.gex.callTotal).toBeGreaterThan(0)
  expect(s.gex.putTotal).toBeLessThan(0)
  expect(s.gex.byStrike.find(r => r.strike === 95)!.put).toBeLessThan(0)
  expect(s.gex.callWall).toBe(105)
  expect(s.gex.putWall).toBe(95)
  expect(s.gex.note).toMatch(/short the puts/)
})

test('the gamma flip is found between the put and call strikes, and the module reads it', () => {
  // Heavy puts at 95 and calls at 105: exposure is negative low, positive high.
  const e = '2026-12-18'
  const build = (putOi: number) =>
    analyzeChain(chainOf([c(e, 29, 'P', 95, { oi: putOi, iv: 0.2 }), c(e, 29, 'C', 105, { oi: 5000, iv: 0.2 })]))

  const balanced = build(5000)
  expect(balanced.gex.profile[0]!.gex).toBeLessThan(0)
  expect(balanced.gex.profile[balanced.gex.profile.length - 1]!.gex).toBeGreaterThan(0)
  expect(balanced.gex.flip).toBeGreaterThan(95)
  expect(balanced.gex.flip).toBeLessThan(105)

  // Three times the puts pushes the flip above spot: dealers short gamma.
  const heavy = build(15000)
  expect(heavy.gex.flip).toBeGreaterThan(100)
  expect(heavy.gex.flip).toBeLessThan(105)
  expect(heavy.gex.total).toBeLessThan(0)
  const bear = optionsModule(heavy, { vix: { value: 30 }, vix3m: { value: 25 }, vixToVix3m: 1.2, regime: 'backwardation (stress)' })
  expect(bear.key).toBe('options')
  expect(bear.score).toBeLessThan(-15)
  expect(bear.flags.join(' ')).toMatch(/short gamma/)
  expect(bear.flags.join(' ')).toMatch(/backwardation/)
  expect(bear.levels).toEqual({ callWall: 105, putWall: 95, gammaFlip: heavy.gex.flip, maxPain: 95 })
  expect(bear.verdict).toMatch(/short gamma below the 10\d\.\d flip/)

  // A third of the puts: long gamma well above the flip.
  const bull = optionsModule(build(1500), { vix: { value: 14 }, vix3m: { value: 17 }, vixToVix3m: 14 / 17, regime: 'contango (calm)' })
  expect(bull.score).toBeGreaterThan(15)
  expect(bull.verdict).toMatch(/long gamma/)
  // Tiny open interest: low confidence.
  expect(bull.confidence).toBeLessThan(0.3)
})

test('expected move from the ATM straddle, with the IV move beside it', () => {
  const e = '2026-11-20'
  const s = analyzeChain(
    chainOf([
      c(e, 1, 'C', 95, { bid: 5.9, ask: 6.1, oi: 10 }),
      c(e, 1, 'P', 95, { bid: 0.9, ask: 1.1, oi: 10 }),
      c(e, 1, 'C', 100, { bid: 2.9, ask: 3.1, oi: 10 }),
      c(e, 1, 'P', 100, { bid: 2.4, ask: 2.6, oi: 10 }),
    ]),
  )
  const m = s.expectedMoves[0]!
  expect(m.monthly).toBe(true)
  expect(m.straddle).toBe(5.5)
  expect(m.pct).toBe(5.5)
  expect(m.lo).toBe(94.5)
  expect(m.hi).toBe(105.5)
  expect(m.ivMove).toBeGreaterThan(0)
  expect(s.term[0]?.iv).toBe(0.3)
})

test('volatility indexes: ratios and regime, tolerating a missing index', async () => {
  const quote = (v: number, ch: number) => json({ data: { current_price: v, price_change: ch, price_change_percent: (ch / (v - ch)) * 100 } })
  const fetch: Fetch = async url => {
    if (url.endsWith('/quotes/_VIX.json')) return quote(25, 3)
    if (url.endsWith('/quotes/_VIX9D.json')) return quote(30, 5)
    if (url.endsWith('/quotes/_VIX3M.json')) return quote(22, 1)
    if (url.endsWith('/quotes/_SKEW.json')) return quote(140, 0)

    return notFound
  }
  const v = await loadVolIndexes(fetch)
  expect(v.vix).toEqual({ value: 25, change: 3, prevClose: 22, changePct: (3 / 22) * 100 })
  expect(v.vvix).toBeUndefined()
  expect(v.vix9dToVix).toBe(1.2)
  expect(v.vixToVix3m).toBe(25 / 22)
  expect(v.regime).toBe('backwardation (stress)')
})
