import { expect, test } from 'claude-code/testing'

import {
  betaStats,
  cotStats,
  futuresModule,
  impliedCash,
  leveragedCompound,
  leveragedEstimate,
  loadCashIndexes,
  loadFutures,
  parseCnbcFutures,
  parseCot,
  projectMove,
  sessionLabel,
  type CashQuote,
  type CotRow,
  type FuturesQuote,
} from '../hooks/engine/futures'
import type { Fetch } from '../hooks/engine/http'
import type { Bar } from '../hooks/engine/types'

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)

// 6:00 am ET on Thursday 2026-11-19.
const NOW = Date.parse('2026-11-19T11:00:00Z')

const CNBC_FUTURES = {
  FormattedQuoteResult: {
    FormattedQuote: [
      {
        symbol: '@SP.1',
        code: 0,
        name: "S&P 500 Fut (Dec'26)",
        last: '7,430.25',
        last_time: '2026-11-19T05:59:04.000-0500',
        open: '7,340.50',
        high: '7,435.00',
        low: '7,338.25',
        change: '+89.75',
        change_pct: '+1.22%',
        volume: '177,327',
        previous_day_closing: '7,340.50',
        altSymbol: 'ESZ26',
        open_interest: '2058800',
        expiration_date: '2026-12-18',
        settlePrice: '7340.50',
        settleDate: '2026-11-18',
      },
      { symbol: '@RTY.1', code: 1, name: null, last: null, previous_day_closing: null },
      {
        symbol: '@ND.1',
        code: 0,
        name: "NASDAQ 100 Fut (Dec'26)",
        last: '27,768.25',
        last_time: '2026-11-19T05:59:05.000-0500',
        change: '+581.50',
        change_pct: '+2.14%',
        previous_day_closing: '27,186.75',
        altSymbol: 'NQZ26',
        expiration_date: '2026-12-18',
        settleDate: '2026-11-18',
      },
    ],
  },
}

const json = (body: unknown) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(body) })
const fail = (status: number) => ({ status, ok: false, headers: {}, text: 'Too Many Requests' })

test('CNBC futures rows parse, a null row is skipped, numbers lose their commas and signs', () => {
  const quotes = parseCnbcFutures(CNBC_FUTURES, NOW)
  expect(quotes.map(q => q.root)).toEqual(['ES', 'NQ'])
  const es = quotes[0]!
  expect(es).toMatchObject({
    index: 'SPX',
    contract: 'ESZ26',
    last: 7430.25,
    change: 89.75,
    changePct: 1.22,
    prevSettle: 7340.5,
    settleDate: '2026-11-18',
    expiry: '2026-12-18',
    time: '2026-11-19T05:59:04.000-05:00',
    session: 'pre-market',
    volume: 177327,
    openInterest: 2058800,
    source: 'cnbc',
  })
  expect(quotes[1]!.last).toBe(27768.25)
})

test('the session label follows the CME week in New York time', () => {
  expect(sessionLabel(Date.parse('2026-11-19T11:00:00Z'))).toBe('pre-market') // 6:00 EST
  expect(sessionLabel(Date.parse('2026-11-19T15:00:00Z'))).toBe('regular') // 10:00
  expect(sessionLabel(Date.parse('2026-11-19T22:30:00Z'))).toBe('daily break') // 17:30
  expect(sessionLabel(Date.parse('2026-11-20T03:00:00Z'))).toBe('overnight') // 22:00
  expect(sessionLabel(Date.parse('2026-11-21T15:00:00Z'))).toBe('weekend') // Saturday
  expect(sessionLabel(Date.parse('2026-06-01T13:00:00Z'))).toBe('pre-market') // 9:00 EDT
  expect(sessionLabel(Date.parse('2026-06-01T13:30:00Z'))).toBe('regular') // 9:30 EDT
})

test('Yahoo answers for the roots CNBC could not, and says so', async () => {
  const urls: string[] = []
  const fetch: Fetch = async url => {
    urls.push(url)
    if (url.includes('cnbc.com')) return fail(503)
    if (url.includes('/ES%3DF'))
      return json({
        chart: {
          result: [
            {
              meta: {
                symbol: 'ES=F',
                shortName: 'E-Mini S&P 500 Dec 26',
                regularMarketPrice: 7430.25,
                previousClose: 7340.5,
                regularMarketTime: Date.parse('2026-11-19T10:59:00Z') / 1000,
              },
            },
          ],
        },
      })

    return fail(429)
  }
  const quotes = await loadFutures(fetch, ['ES', 'NQ'], NOW)
  expect(quotes).toHaveLength(1)
  expect(quotes[0]).toMatchObject({ root: 'ES', source: 'yahoo', last: 7430.25, prevSettle: 7340.5, change: 89.75, changePct: 1.22, expiry: '2026-12-18' })
  expect(urls.some(u => u.includes('/NQ%3DF'))).toBe(true)

  // With CNBC answering, Yahoo is not asked at all.
  const calls: string[] = []
  const cnbc: Fetch = async url => (calls.push(url), url.includes('cnbc.com') ? json(CNBC_FUTURES) : fail(429))
  expect((await loadFutures(cnbc, ['ES', 'NQ'], NOW)).map(q => q.source)).toEqual(['cnbc', 'cnbc'])
  expect(calls).toHaveLength(1)
})

test('cash indexes fall back to CBOE and drop a stale CBOE quote', async () => {
  const fetch: Fetch = async url => {
    if (url.includes('cnbc.com'))
      return json({ FormattedQuoteResult: { FormattedQuote: [{ symbol: '.SPX', code: 0, name: 'S&P 500 Index', last: '7,323.63', change: '-16.90', change_pct: '-0.23%', last_time: '2026-11-18' }] } })
    if (url.includes('_NDX.json'))
      return json({ data: { current_price: 27116.2578, price_change: 114.4578, price_change_percent: 0.4221, last_trade_time: '2026-11-18T16:14:59' } })
    if (url.includes('_DJI.json'))
      return json({ data: { current_price: 52297.09, price_change: -189.41, price_change_percent: -0.36, last_trade_time: '2026-11-12T16:14:59' } })

    return fail(404)
  }
  const cash = await loadCashIndexes(fetch, ['SPX', 'NDX', 'DJI', 'RUT'], NOW)
  expect(cash.map(c => `${c.symbol}:${c.source}`)).toEqual(['SPX:cnbc', 'NDX:cboe'])
  expect(cash[0]).toMatchObject({ last: 7323.63, prevClose: 7340.53, sessionDate: '2026-11-18', open: false })
  expect(cash[1]!.time).toBe('2026-11-18T16:14:59-05:00')
})

// A hand-made case: the settlement sits 10 points over a cash close of 1000,
// and the quote comes exactly halfway from that settlement (4:00 pm ET on
// June 1) to expiry (9:30 am ET on June 11), so half the basis is left.
const FUT: FuturesQuote = {
  root: 'ES',
  index: 'SPX',
  name: 'test',
  last: 1030,
  change: 20,
  changePct: 1.98,
  prevSettle: 1010,
  settleDate: '2026-06-01',
  time: new Date((Date.parse('2026-06-01T20:00:00Z') + Date.parse('2026-06-11T13:30:00Z')) / 2).toISOString(),
  expiry: '2026-06-11',
  session: 'overnight',
  source: 'cnbc',
}
const CASH: CashQuote = { symbol: 'SPX', name: 'S&P 500', last: 1000, change: 5, changePct: 0.5, prevClose: 995, sessionDate: '2026-06-01', time: '2026-06-01', open: false, source: 'cnbc' }

test('implied cash strips the prior basis, scaled by the time left to expiry', () => {
  const r = impliedCash(FUT, CASH)
  expect(r.cashRef).toBe(1000)
  expect(r.basisPrev).toBe(10)
  close(r.daysPrev, 9.73, 0.001) // 9 days 17.5 hours
  close(r.daysNow, 4.86, 0.01)
  expect(r.basisNow).toBe(5)
  expect(r.impliedCash).toBe(1025)
  expect(r.impliedChangePct).toBe(2.5)
  // 1% over 9.73 days is a 37.5% annual carry: far outside a normal basis.
  close(r.carryPct, 37.52, 0.01)
  expect(r.anomaly).toMatch(/rich/)

  // Cash open the next day: the basis reference is its prior close (the
  // settlement day's close) and the move is measured from it.
  const open = impliedCash(FUT, { ...CASH, last: 1012, change: 12, prevClose: 1000, sessionDate: '2026-06-02', open: true })
  expect(open.cashRef).toBe(1000)
  expect(open.impliedCash).toBe(1025)
  expect(open.impliedChangePct).toBe(2.5)
})

function cotRows(nets: number[], lastDate = '2026-11-10'): CotRow[] {
  return nets.map((net, i) => {
    const d = new Date(`${lastDate}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 7 * (nets.length - 1 - i))

    return { date: d.toISOString().slice(0, 10), oi: 1000, levLong: 500 + net, levShort: 500, amLong: 600, amShort: 100 + i, dealerLong: 100, dealerShort: 200 }
  })
}

test('COT nets, indexes, percentiles, crowding and staleness', () => {
  const parsed = parseCot([
    { report_date_as_yyyy_mm_dd: '2026-11-10T00:00:00.000', open_interest_all: '2017687', lev_money_positions_long: '145755', lev_money_positions_short: '448815', asset_mgr_positions_long: '1115756', asset_mgr_positions_short: '201626', dealer_positions_long_all: '175005', dealer_positions_short_all: '910294' },
    { report_date_as_yyyy_mm_dd: '2026-11-03T00:00:00.000', open_interest_all: '1986532' },
  ])
  expect(parsed).toEqual([{ date: '2026-11-10', oi: 2017687, levLong: 145755, levShort: 448815, amLong: 1115756, amShort: 201626, dealerLong: 175005, dealerShort: 910294 }])

  // Ten weeks rising 0..90 and then 100: the latest is the 3-year high.
  const high = cotStats(cotRows([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]), NOW, 'ES')
  expect(high.lev).toMatchObject({ net: 100, change: 10, pctOi: 10, index3y: 100, pct3y: 100, crowded: 'long' })
  expect(high.dealer.net).toBe(-100)
  expect(high.am.net).toBe(490)
  expect(high.am.crowded).toBe('short') // asset manager net falls every week
  expect(high).toMatchObject({ date: '2026-11-10', released: '2026-11-13', nextRelease: '2026-11-20', ageDays: 9, overdue: false })
  expect(high.flags[0]).toMatch(/crowded long/)

  // Forty weeks rising 0..38 then back to 30: 3-year index (30-0)/38, but
  // only the last 26 reports (14..38 and 30) count for the 26-week index.
  const nets = Array.from({ length: 39 }, (_, i) => i).concat([30])
  const mid = cotStats(cotRows(nets), NOW)
  expect(mid.weeks3y).toBe(40)
  expect(mid.weeks26w).toBe(26)
  expect(mid.lev.index3y).toBe(78.9)
  expect(mid.lev.index26w).toBe(66.7)
  expect(mid.lev.pct3y).toBe(78.2) // 30 below and one tie among the 39 others
  expect(mid.lev.crowded).toBeUndefined()

  expect(cotStats(cotRows([1, 2, 3]), Date.parse('2026-11-25T15:00:00Z')).overdue).toBe(true)
})

// Deterministic "random" daily returns.
const baseRet = (i: number) => 0.01 * Math.sin(i * 1.3) + 0.006 * Math.cos(i * 0.7 + 0.4)
const noise = (i: number) => 0.003 * Math.sin(i * 2.9 + 1)

function series(n: number, ret: (i: number) => number, skip: Set<number> = new Set()): Bar[] {
  const bars: Bar[] = []
  let c = 100
  const d = new Date('2026-01-01T12:00:00Z')
  for (let i = 0; i < n; i++) {
    d.setUTCDate(d.getUTCDate() + 1)
    c *= 1 + ret(i)
    if (!skip.has(i)) bars.push({ t: d.toISOString().slice(0, 10), o: c, h: c, l: c, c, v: 0 })
  }

  return bars
}

test('beta recovers a known 3x relationship, aligning dates with gaps', () => {
  const base = series(120, baseRet)
  const target = series(120, i => 3 * baseRet(i) + noise(i))
  const s = betaStats(base, target, 60)!
  expect(s.n).toBe(60)
  close(s.beta, 3, 0.15)
  expect(s.corr).toBeGreaterThan(0.95)
  close(s.residSd, 0.003 / Math.SQRT2, 0.001)
  expect(s.to).toBe(base[base.length - 1]!.t)
  expect(s.from).toBe(base[base.length - 61]!.t)

  // Noise-free and fully aligned: exact.
  const exact = betaStats(base, series(120, i => 3 * baseRet(i)), 60)!
  close(exact.beta, 3, 1e-9)
  close(exact.residSd, 0, 1e-9)
  close(exact.corr, 1, 1e-9)

  // Days missing on either side: only shared days count, returns span the gaps.
  const holes = betaStats(series(30, baseRet, new Set([5, 6])), series(30, i => 3 * baseRet(i), new Set([10, 11, 20])), 60)!
  expect(holes.n).toBe(24) // 25 shared days
  close(holes.beta, 3, 0.1)

  expect(betaStats(base.slice(0, 5), target.slice(0, 5))).toBeUndefined()
})

test('a projection moves the target by beta and bands it by one residual sd', () => {
  const p = projectMove({ beta: 4, residSd: 0.02 }, { basePrev: 100, baseTarget: 102.5, targetPrev: 50 })
  expect(p).toEqual({ baseMovePct: 2.5, movePct: 10, price: 55, lo: 54, hi: 56 })

  close(leveragedEstimate(2.4, 3), 7.2, 1e-9)
  expect(leveragedEstimate(-40, 3)).toBe(-100)
  // +10% then -10%: the index is down 1%, a 3x fund down 9%, not 3%.
  expect(leveragedCompound([10, -10], 3)).toEqual({ underlyingPct: -1, naivePct: -3, compoundedPct: -9 })
})

test('the futures module scores a strong tech-led overnight rally and fades a crowded long', () => {
  const quotes = parseCnbcFutures(CNBC_FUTURES, NOW)
  const cash: CashQuote[] = [
    { symbol: 'SPX', name: 'S&P 500', last: 7323.63, change: -16.9, changePct: -0.23, prevClose: 7340.53, sessionDate: '2026-11-18', time: '2026-11-18', open: false, source: 'cnbc' },
  ]
  const r = futuresModule({ quotes, cash, now: NOW })
  expect(r.key).toBe('futures')
  close(r.stats.implied.ES!.basisPrev, 16.87, 1e-9)
  close(r.stats.implied.ES!.impliedChangePct, 1.23, 0.01)
  expect(r.score).toBeGreaterThan(50)
  expect(r.verdict).toMatch(/higher/)
  expect(r.flags.some(f => /Large overnight move/.test(f))).toBe(true)

  const crowded = futuresModule({ quotes, cash, now: NOW, cot: cotStats(cotRows([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]), NOW, 'ES') })
  expect(crowded.stats.components.positioning).toBe(-20)
  expect(crowded.score).toBe(r.score - 20)
  expect(crowded.verdict).toMatch(/crowded long/)

  expect(futuresModule({ quotes: [], now: NOW }).confidence).toBe(0)
})
