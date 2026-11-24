import { expect, test } from 'claude-code/testing'

import { cboeJson, cboePausedUntil, resumeCboe } from '../hooks/engine/cboe'
import { loadOptionStats, loadVol, parseCnbcVol, scaleStats, type OptionCache } from '../hooks/engine/chains'
import { loadIndexHistory } from '../hooks/engine/futures'
import type { Fetch } from '../hooks/engine/http'
import { fillVols, impliedVol, loadNasdaqChain, parseNasdaqChain, parseSpotQuote, quotesAsOf, type SpotQuote } from '../hooks/engine/nasdaq-chain'
import { analyzeChain, normCdf, optionsModule, RISK_FREE, sourceText, volFamily, type Contract } from '../hooks/engine/options'

// Option data sources: CBOE first, Nasdaq's chain with vols solved here when
// CBOE refuses, CNBC for the VIX family.

type Res = { status: number; ok: boolean; headers: Record<string, string>; text: string }
const json = (body: unknown): Res => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(body) })
const fail = (status: number, text = ''): Res => ({ status, ok: false, headers: {}, text })
const BLOCKED = fail(403, '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>')

// Tue 2026-11-24, 10:00 ET: the session is open.
const OPEN = Date.UTC(2026, 10, 24, 15)
const et = (h: number, m = 0, day = 24) => Date.UTC(2026, 10, day, h + 5, m)

/** Black-76 price, discounted: what a quote at this vol would be. */
function quote(type: 'C' | 'P', f: number, k: number, t: number, iv: number): number {
  const sd = iv * Math.sqrt(t)
  const d1 = Math.log(f / k) / sd + sd / 2
  const call = f * normCdf(d1) - k * normCdf(d1 - sd)

  return (type === 'C' ? call : call - f + k) * Math.exp(-RISK_FREE * t)
}

const two = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const tOf = (expiry: string, at: number) => (Date.UTC(Number(expiry.slice(0, 4)), Number(expiry.slice(5, 7)) - 1, Number(expiry.slice(8)), 21) - at) / (365 * 86_400_000)

type Opt = { root?: string; strikes?: number[]; iv?: (k: number) => number; expiries?: string[]; quoted?: boolean; oi?: (k: number, type: 'C' | 'P') => number }

/** A Nasdaq payload priced at `spot` as of `at`: strikes 80%–120%, a put skew, two expiries. */
function payload(spot: number, at: number, o: Opt = {}): unknown {
  const root = (o.root ?? 'xyz').toLowerCase()
  const iv = o.iv ?? (k => 0.3 + Math.max(0, 1 - k / spot) * 0.5)
  const rows: Record<string, unknown>[] = []
  for (const e of o.expiries ?? ['2026-12-18', '2027-01-15']) {
    rows.push({ expirygroup: `group ${e}` })
    const t = tOf(e, at)
    for (const pct of [80, 85, 90, 95, 98, 100, 102, 105, 110, 115, 120]) {
      const k = (o.strikes ?? [])[0] ?? Math.round(spot * pct) / 100
      const c = quote('C', spot, k, t, iv(k))
      const p = quote('P', spot, k, t, iv(k))
      const side = (x: number) => (o.quoted === false ? ['--', '--'] : [two(x - 0.02), two(x + 0.02)])
      const [cb, ca] = side(c)
      const [pb, pa] = side(p)
      rows.push({
        expirygroup: '',
        strike: two(k),
        c_Bid: cb,
        c_Ask: ca,
        c_Last: two(c),
        c_Volume: '1,200',
        c_Openinterest: String(o.oi?.(k, 'C') ?? 900),
        p_Bid: pb,
        p_Ask: pa,
        p_Last: two(p),
        p_Volume: '1,500',
        p_Openinterest: String(o.oi?.(k, 'P') ?? 1100),
        drillDownURL: `/market-activity/stocks/${root}/option-chain/call-put-options/${root}---${e.slice(2).replace(/-/g, '')}c${String(Math.round(k * 1000)).padStart(8, '0')}`,
      })
    }
  }

  return { data: { table: { rows } }, status: { rCode: 200 } }
}

const NO_SYMBOL = { data: null, status: { rCode: 400, bCodeMessage: [{ code: 1001, errorMessage: 'Symbol not exists.' }] } }

/** CNBC quote rows: an open session by default. */
const cnbc = (rows: Record<string, unknown>[]) => json({ FormattedQuoteResult: { FormattedQuote: rows.map(r => ({ code: 0, curmktstatus: 'REG_MKT', last_time: '2026-11-24T10:00:00.000-0500', ...r })) } })

const spotAt = (last: number, over: Partial<SpotQuote> = {}): SpotQuote => ({ last, current: last, prevClose: last, sessionDate: '2026-11-24', ...over })

test('implied vol comes back from a price made with it, and not from one below intrinsic value', () => {
  for (const iv of [0.08, 0.3, 1.2])
    for (const k of [90, 100, 112]) {
      const price = quote('C', 100, k, 0.1, iv) * Math.exp(RISK_FREE * 0.1)
      const got = impliedVol('C', price, 100, k, 0.1)
      if (price > 0.01) expect(Math.abs(got! - iv) < 0.002).toBe(true)
    }
  expect(impliedVol('C', 9.9, 100, 90, 0.1)).toBeUndefined()
  expect(impliedVol('P', 0, 100, 90, 0.1)).toBeUndefined()
})

test("Nasdaq's rows become contracts with the vol and greeks their quotes carry", () => {
  const body = payload(100, OPEN - 15 * 60_000) as { data: { table: { rows: Record<string, unknown>[] } } }
  // An adjusted root, a dead row and an expired one are dropped.
  const extra = body.data.table.rows[1]!
  body.data.table.rows.push({ ...extra, drillDownURL: String(extra.drillDownURL).replace('xyz---', 'xyz1--') })
  body.data.table.rows.push({ ...extra, strike: '250.00', c_Bid: '--', c_Ask: '--', c_Last: '--', c_Volume: '--', c_Openinterest: '--', p_Bid: '--', p_Ask: '--', p_Last: '--', p_Volume: '--', p_Openinterest: '--', drillDownURL: String(extra.drillDownURL).replace(/c\d{8}$/, 'c00250000') })
  body.data.table.rows.push({ ...extra, drillDownURL: '/market-activity/stocks/xyz/option-chain/call-put-options/xyz---261120c00100000' })
  const chain = parseNasdaqChain(body, 'XYZ', spotAt(100), { now: OPEN })
  expect(chain.contracts).toHaveLength(44)
  expect(chain.asOf).toBe(new Date(OPEN - 15 * 60_000).toISOString())
  expect(chain.source).toEqual({ provider: 'nasdaq' })
  const atm = chain.contracts.filter(c => c.strike === 100 && c.expiry === '2026-12-18')
  expect(atm.map(c => c.type)).toEqual(['C', 'P'])
  for (const c of atm) expect(Math.abs(c.iv - 0.3) < 0.01).toBe(true)
  // The put wing carries the skew, and a call at that strike the same vol.
  const low = chain.contracts.filter(c => c.strike === 90 && c.expiry === '2026-12-18')
  for (const c of low) expect(Math.abs(c.iv - 0.35) < 0.015).toBe(true)
  expect(atm[0]!.delta > 0.4 && atm[0]!.delta < 0.6).toBe(true)
  expect(atm[0]!.gamma > 0).toBe(true)
  expect(atm[0]!.volume).toBe(1200)

  const s = analyzeChain(chain)
  expect(Math.abs(s.ivAtm30! - 0.3) < 0.01).toBe(true)
  expect(s.skew!.put25 > s.skew!.call25).toBe(true)
  expect(s.source?.provider).toBe('nasdaq')
})

test('quotes with thousands separators parse, and a wide quote does not set a vol', () => {
  const chain = parseNasdaqChain(payload(26_746.1, OPEN - 15 * 60_000, { root: 'ndxp' }), 'NDX', spotAt(26_746.1), { now: OPEN, cls: 'index' })
  expect(chain.securityType).toBe('index')
  expect(chain.contracts.some(c => c.strike > 26_000 && c.bid > 100)).toBe(true)

  const c = (type: 'C' | 'P', strike: number, bid: number, ask: number): Contract => ({ expiry: '2026-12-18', days: 24, t: 24 / 365, type, strike, bid, ask, mid: (bid + ask) / 2, last: 0, iv: 0, oi: 10, volume: 0, delta: 0, gamma: 0 })
  const wide = [c('P', 90, 0.1, 5), c('P', 95, 0.2, 6), c('C', 105, 0.1, 5), c('C', 110, 0.1, 5)]
  fillVols(wide, 100)
  expect(wide.every(x => x.iv === 0)).toBe(true)
})

test('when the quotes are from: 15 minutes ago in the session, the close otherwise, unless the pre-market moved them', () => {
  const day = spotAt(100)
  expect(quotesAsOf(day, 100, OPEN)).toEqual({ ms: OPEN - 15 * 60_000, atClose: false })
  const before = { last: 100, current: 98.5, prevClose: 100, sessionDate: '2026-11-23' }
  const close = et(16, 0, 23)
  expect(quotesAsOf(before, 98.6, et(7))).toEqual({ ms: et(7) - 15 * 60_000, atClose: false })
  expect(quotesAsOf(before, 99.9, et(7))).toEqual({ ms: close, atClose: true })
  // No usable parity says nothing about the quotes: the close.
  expect(quotesAsOf(before, undefined, et(7))).toEqual({ ms: close, atClose: true })
  // Overnight and on a weekend the last session's close, whatever parity says.
  expect(quotesAsOf(before, 98.6, et(2))).toEqual({ ms: close, atClose: true })
  expect(quotesAsOf({ ...before, sessionDate: '2026-11-20' }, 98.6, et(11, 0, 22))).toEqual({ ms: et(16, 0, 20), atClose: true })
  // After the bell `last` belongs to today.
  expect(quotesAsOf(day, 98.6, et(18))).toEqual({ ms: et(16), atClose: true })
})

test('the underlying price: extended hours from CNBC, and the close behind it', () => {
  const pre = parseSpotQuote({ last: '722.29', change: '+32.48', curmktstatus: 'PRE_MKT', last_time: '2026-11-23', ExtendedMktQuote: { type: 'PRE_MKT', last: '715.90' } }, et(8))
  expect(pre).toEqual({ last: 722.29, current: 715.9, prevClose: 722.29, sessionDate: '2026-11-23' })
  const open = parseSpotQuote({ last: '715.00', change: '-7.29', curmktstatus: 'REG_MKT', last_time: '2026-11-24T10:00:00.000-0500', ExtendedMktQuote: { type: 'PRE_MKT', last: '700' } }, OPEN)!
  expect(open.current).toBe(715)
  expect(Math.abs(open.prevClose - 722.29) < 1e-6).toBe(true)
  expect(parseSpotQuote({ last: '', code: 1 })).toBeUndefined()
})

test('with no quotes posted the last trades stand in, flagged and less trusted', () => {
  const now = et(8)
  const body = payload(100, et(16, 0, 23), { quoted: false })
  const spot: SpotQuote = { last: 100, current: 92, prevClose: 100, sessionDate: '2026-11-23' }
  const chain = parseNasdaqChain(body, 'XYZ', spot, { now })
  expect(chain.source).toEqual({ provider: 'nasdaq', atClose: true, fromTrades: true })
  expect(chain.quoteSpot).toBe(100)
  const s = analyzeChain(chain)
  expect(Math.abs(s.ivAtm30! - 0.3) < 0.02).toBe(true)
  const m = optionsModule(s)
  expect(m.flags.some(f => /last session's trades/.test(f.en) && /成交价/.test(f.zh))).toBe(true)
  const quoted = optionsModule(analyzeChain(parseNasdaqChain(payload(100, OPEN - 15 * 60_000), 'XYZ', spotAt(100), { now: OPEN })))
  expect(quoted.confidence > m.confidence).toBe(true)
})

test('a Cloudflare refusal pauses CBOE for six hours; an unknown symbol does not', async () => {
  resumeCboe()
  let asked = 0
  const s3: Fetch = async () => (asked++, fail(403, '<Error><Code>AccessDenied</Code></Error>'))
  await cboeJson(s3, '/options/ZZZZ.json', OPEN).catch(() => undefined)
  expect(cboePausedUntil(OPEN)).toBeUndefined()

  const blocked: Fetch = async () => (asked++, BLOCKED)
  let text = ''
  await cboeJson(blocked, '/options/SPY.json', OPEN).catch(e => (text = String(e.message)))
  expect(text).toBe('HTTP 403 from cdn-api.cboe.com')
  expect(cboePausedUntil(OPEN + 1)).toBe(OPEN + 6 * 3600_000)
  asked = 0
  await cboeJson(blocked, '/options/QQQ.json', OPEN + 5 * 3600_000).catch(() => undefined)
  expect(asked).toBe(0)
  await cboeJson(blocked, '/options/QQQ.json', OPEN + 6 * 3600_000).catch(() => undefined)
  expect(asked).toBe(1)

  resumeCboe()
  await cboeJson(async () => fail(429), '/quotes/_VIX.json', OPEN).catch(() => undefined)
  expect(cboePausedUntil(OPEN)).toBeDefined()
  resumeCboe()
})

/** CBOE refuses; Nasdaq serves `served` by asset class; CNBC prices the underlyings. */
function world(served: Record<string, unknown>, quotes: Record<string, unknown>[], urls: string[]): Fetch {
  return async url => {
    urls.push(url)
    if (url.includes('cdn-api.cboe.com')) return BLOCKED
    if (url.includes('cnbc.com')) return cnbc(quotes)
    const m = /quote\/([^/]+)\/option-chain\?assetclass=(\w+)/.exec(url)

    return m ? json(served[`${m[1]}:${m[2]}`] ?? NO_SYMBOL) : fail(404)
  }
}

test('a refused CBOE falls to Nasdaq, says so, and later reads neither ask CBOE nor download again', async () => {
  resumeCboe()
  const urls: string[] = []
  const fetch = world({ 'SPY:etf': payload(700, OPEN - 15 * 60_000, { root: 'spy' }) }, [{ symbol: 'SPY', last: '700.00', change: '-5.00' }], urls)
  const cache: OptionCache = new Map()
  const [a, b] = await Promise.all([loadOptionStats(fetch, 'SPY', { cache, now: OPEN }), loadOptionStats(fetch, 'spy', { cache, now: OPEN })])
  expect(a).toBe(b)
  expect(a.source).toEqual({ provider: 'nasdaq', fallback: 'HTTP 403 from cdn-api.cboe.com' })
  expect(urls.filter(u => u.includes('cboe')).length).toBe(1)
  expect(urls.filter(u => u.includes('option-chain')).length).toBe(1)
  await loadOptionStats(fetch, 'SPY', { cache, now: OPEN + 9 * 60_000 })
  expect(urls.filter(u => u.includes('option-chain')).length).toBe(1)
  await loadOptionStats(fetch, 'SPY', { cache, now: OPEN + 11 * 60_000 })
  expect(urls.filter(u => u.includes('option-chain')).length).toBe(2)
  // CBOE stayed paused for that second download.
  expect(urls.filter(u => u.includes('cboe')).length).toBe(1)
  resumeCboe()
})

test('a stock is looked for as a stock, then as a fund; a ticker with no options says what failed', async () => {
  resumeCboe()
  const urls: string[] = []
  const fetch = world({ 'ABC:etf': payload(50, OPEN - 15 * 60_000, { root: 'abc' }) }, [{ symbol: 'ABC', last: '50.00', change: '1.00' }], urls)
  expect((await loadOptionStats(fetch, 'ABC', { now: OPEN })).symbol).toBe('ABC')
  expect(urls.filter(u => u.includes('option-chain')).map(u => /assetclass=(\w+)/.exec(u)![1])).toEqual(['stocks', 'etf'])
  let text = ''
  const cache: OptionCache = new Map()
  await loadOptionStats(fetch, 'NOPE', { now: OPEN, cache }).catch(e => (text = e.message))
  expect(text).toContain('Nasdaq has no option chain for NOPE')
  expect(text).toContain('CBOE')
  // A failure is not kept.
  await Promise.resolve()
  expect(cache.size).toBe(0)
  let direct = ''
  await loadNasdaqChain(fetch, 'NOPE', ['stocks'], { now: OPEN }).catch(e => (direct = e.message))
  expect(direct).toBe('Nasdaq has no option chain for NOPE')
  resumeCboe()
})

test('CBOE is used alone when it answers', async () => {
  resumeCboe()
  const urls: string[] = []
  const fetch: Fetch = async url => {
    urls.push(url)
    if (!url.includes('cboe')) return fail(404)

    return json({
      timestamp: '2026-11-24 15:00:00',
      data: { current_price: 100, close: 100, prev_day_close: 99, security_type: 'stock', last_trade_time: '2026-11-24T10:00:00', options: [{ option: 'XYZ261218C00100000', bid: 2, ask: 2.2, iv: 0.3, open_interest: 10, volume: 5, delta: 0.5, gamma: 0.05, last_trade_price: 2.1 }] },
    })
  }
  const s = await loadOptionStats(fetch, 'XYZ', { now: OPEN })
  expect(s.source).toEqual({ provider: 'cboe' })
  expect(urls).toEqual(['https://cdn-api.cboe.com/api/global/delayed_quotes/options/XYZ.json'])
})

test("SPX is scaled from SPY's chain by the ratio of their last regular prices", async () => {
  resumeCboe()
  const urls: string[] = []
  const oi = (k: number, type: 'C' | 'P') => (type === 'C' ? (k === 735 ? 90_000 : 500) : k === 665 ? 80_000 : 500)
  const fetch = world(
    { 'SPY:etf': payload(700, OPEN - 15 * 60_000, { root: 'spy', oi }) },
    [
      { symbol: 'SPY', last: '700.00', change: '-5.00' },
      { symbol: '.SPX', last: '7,014.00', change: '-50.00' },
    ],
    urls,
  )
  const spy = await loadOptionStats(fetch, 'SPY', { now: OPEN })
  const spx = await loadOptionStats(fetch, 'SPX', { now: OPEN })
  expect(spx.symbol).toBe('SPX')
  expect(Math.abs(spx.source!.via!.ratio - 10.02) < 1e-9).toBe(true)
  expect(spx.source!.via!.symbol).toBe('SPY')
  expect(spx.spot).toBe(7014)
  expect(spx.gex.callWall).toBe(Math.round(spy.gex.callWall! * 1002) / 100)
  expect(spx.gex.putWall).toBe(Math.round(spy.gex.putWall! * 1002) / 100)
  expect(spx.gex.total).toBe(spy.gex.total)
  expect(spx.expectedMoves[0]!.pct).toBe(spy.expectedMoves[0]!.pct)
  expect(spx.maxPain.monthly!.strike).toBe(Math.round(spy.maxPain.monthly!.strike * 1002) / 100)
  expect(sourceText(spx.source).en).toMatch(/^scaled from SPY ×10\.020; Nasdaq, about 15 min delayed/)
  expect(scaleStats(spy, 'SPX', 1).spot).toBe(spy.spot)
  resumeCboe()
})

const vol = (symbol: string, last: string, over: Record<string, unknown> = {}) => ({ symbol, last, change: 'UNCH', change_pct: 'UNCH', previous_day_closing: last, last_time: '2026-11-23', ...over })
const VOL_ROWS = [
  vol('.VIX', '29.92', { change: '+3.30', change_pct: '+12.40%', previous_day_closing: '26.62', last_time: '2026-11-24T08:30:00.000-0500' }),
  vol('.VIX9D', '27.76'),
  vol('.VIX3M', '25.50'),
  vol('.VVIX', '117.36'),
  vol('.VXN', '36.31'),
  { symbol: '.SKEW', code: 1 },
]

test('the VIX family falls to CNBC with VXN, and compares values of the same session', async () => {
  resumeCboe()
  const v = await loadVol(async url => (url.includes('cnbc.com') ? cnbc(VOL_ROWS) : BLOCKED))
  expect(v.source).toBe('cnbc')
  expect(v.vix).toEqual({ value: 29.92, change: 3.3, prevClose: 26.62, changePct: 12.4, date: '2026-11-24' })
  expect(v.vxn?.value).toBe(36.31)
  expect(v.skew).toBeUndefined()
  // VIX is already trading; VIX9D and VIX3M are at the prior close, so VIX's own prior close is compared.
  expect(v.vixToVix3m).toBe(26.62 / 25.5)
  expect(v.vix9dToVix).toBe(27.76 / 26.62)
  expect(v.regime).toBe('backwardation (stress)')
  // All from one session: the live value.
  expect(volFamily({ vix: { value: 20, prevClose: 30, date: '2026-11-24' }, vix3m: { value: 25, date: '2026-11-24' } }).vixToVix3m).toBe(0.8)
  expect(Object.keys(parseCnbcVol({}))).toEqual([])
  resumeCboe()

  // CBOE gave part of it: CNBC fills the rest.
  const part: Fetch = async url => {
    if (url.includes('cnbc.com')) return cnbc(VOL_ROWS)

    return url.endsWith('/_VIX.json') ? json({ data: { current_price: 26.62, price_change: -9, price_change_percent: -25 } }) : fail(404)
  }
  const mixed = await loadVol(part)
  expect(mixed.source).toBe('cboe+cnbc')
  expect(mixed.vix?.value).toBe(26.62)
  expect(mixed.vix3m?.value).toBe(25.5)

  let text = ''
  await loadVol(async () => fail(404)).catch(e => (text = e.message))
  expect(text).toBe('CBOE volatility indexes unavailable')
})

test("SPX's daily history falls to CNBC, and the first failure shows when neither answers", async () => {
  resumeCboe()
  const day = (d: string, c: string) => ({ open: c, high: c, low: c, close: c, tradeTime: `${d}000000` })
  const bars = await loadIndexHistory(
    async url => (url.includes('/bars/.SPX/1D/') ? json({ barData: { priceBars: [day('20261119', '7,100.5'), day('20261120', '6910.00')] } }) : BLOCKED),
    'SPX',
    50,
  )
  expect(bars.map(b => [b.t, b.c])).toEqual([
    ['2026-11-19', 7100.5],
    ['2026-11-20', 6910],
  ])
  resumeCboe()
  let text = ''
  await loadIndexHistory(async () => BLOCKED, 'SPX', 50).catch(e => (text = e.message))
  expect(text).toBe('HTTP 403 from cdn-api.cboe.com')
  resumeCboe()
})

test('every source line comes in both languages', () => {
  for (const s of [undefined, { provider: 'cboe' as const }, { provider: 'nasdaq' as const }, { provider: 'nasdaq' as const, atClose: true }, { provider: 'nasdaq' as const, fromTrades: true }, { provider: 'nasdaq' as const, via: { symbol: 'SPY', ratio: 10.02 } }]) {
    const t = sourceText(s)
    expect(t.en.length > 0).toBe(true)
    expect(/[一-鿿]/.test(t.zh)).toBe(true)
  }
})
