import { expect, test } from 'claude-code/testing'

import { etInstant } from '../hooks/engine/futures'
import type { Fetch } from '../hooks/engine/http'
import {
  analyzeIntraday,
  barsUrl,
  buildIntraday,
  intradayMarkdown,
  levelKindTextIntraday,
  loadIntraday,
  openTypeText,
  parseBreadth,
  phaseText,
  rangeStatusText,
  summarizeDay,
  type IntradayData,
  type IntradayLevel,
  type MinuteBar,
  type OpenType,
  type RangeStatus,
  type SessionPhase,
} from '../hooks/engine/intraday'
import { isText, type Text } from '../hooks/i18n'

// ---------------------------------------------------------------- builders

const DATE = '2026-11-19' // a Thursday
const PREV = '2026-11-18'
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const at = (date: string, m: number) => etInstant(date, Math.floor(m / 60), m % 60)

/** Price at minute offset `x` from 09:30 on a path through [offset, price] waypoints (linear in between). */
function priceOn(points: [number, number][], x: number): number {
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!
    const [x1, y1] = points[i]!
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1)
  }

  return points[points.length - 1]![1]
}

/** 1-minute (or `step`-minute) regular-session bars along a path: bar i opens at p(i) and closes at p(i + step). */
function walk(date: string, points: [number, number][], opts: { v?: number; step?: number; from?: number } = {}): MinuteBar[] {
  const step = opts.step ?? 1
  const end = points[points.length - 1]![0]
  const out: MinuteBar[] = []
  for (let x = opts.from ?? 0; x + step <= end; x += step) {
    const o = priceOn(points, x)
    const c = priceOn(points, x + step)
    const m = 570 + x
    out.push({ t: at(date, m), date, time: hhmm(m), o, h: Math.max(o, c) + 0.01, l: Math.min(o, c) - 0.01, c, v: opts.v ?? 1000 })
  }

  return out
}

function data(bars: MinuteBar[], extra: Partial<IntradayData> = {}): IntradayData {
  return { symbol: 'SPY', bars, history: [], sessionDate: DATE, prev: { date: PREV, close: 100, high: 101, low: 99 }, dailyAtr: 2, fetchedAt: 0, ...extra }
}

/** Past weekdays before DATE, oldest first. */
function weekdaysBefore(n: number): string[] {
  const out: string[] = []
  const d = new Date(`${DATE}T12:00:00Z`)
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1)
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10))
  }

  return out
}

/** Every Text pair inside a value, with where it sits. */
function texts(x: unknown, path = '$', out: { path: string; t: Text }[] = []): { path: string; t: Text }[] {
  if (Array.isArray(x)) x.forEach((v, i) => texts(v, `${path}[${i}]`, out))
  else if (isText(x)) out.push({ path, t: x })
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) texts(v, `${path}.${k}`, out)

  return out
}

function expectTranslated(x: unknown) {
  const all = texts(x)
  expect(all.length).toBeGreaterThan(0)
  expect(all.filter(({ t }) => t.en !== '' && !/[一-鿿]/.test(t.zh)).map(({ path, t }) => `${path}: ${t.zh}`)).toEqual([])
}

/** Equal to `digits` decimals (the harness has no toBeCloseTo). */
const close = (got: number | undefined, want: number, digits = 2) => expect(got !== undefined && Math.abs(got - want) <= 0.5 * 10 ** -digits ? want : got).toBe(want)

const read = (bars: MinuteBar[], nowMin: number, extra: Partial<IntradayData> = {}) => analyzeIntraday(data(bars, extra), { now: at(DATE, nowMin) })

// ---------------------------------------------------------------- open types

test('open type: drive up, test-drive up, rejection-reverse down, auction, too early', () => {
  const drive = walk(DATE, [
    [0, 100],
    [30, 101.5],
  ])
  expect(read(drive, 600).openType).toBe('open-drive up')

  const testDrive = walk(DATE, [
    [0, 100],
    [4, 99.7],
    [30, 101.2],
  ])
  expect(read(testDrive, 600).openType).toBe('open-test-drive up')

  const rejection = walk(DATE, [
    [0, 100],
    [14, 100.8],
    [30, 99.4],
  ])
  expect(read(rejection, 600).openType).toBe('open-rejection-reverse down')

  const auction = walk(DATE, [
    [0, 100],
    [5, 100.4],
    [10, 99.6],
    [15, 100.4],
    [20, 99.6],
    [25, 100.3],
    [30, 100.05],
  ])
  expect(read(auction, 600).openType).toBe('open-auction')

  expect(read(drive, 580).openType).toBe('too early')
})

test('open type is mirrored for a drive down', () => {
  const down = walk(DATE, [
    [0, 100],
    [30, 98.6],
  ])
  const r = read(down, 600)
  expect(r.openType).toBe('open-drive down')
  expect(r.score).toBeLessThan(0)
})

// ---------------------------------------------------------------- opening ranges and the initial balance

test('opening ranges: breakout above the IB, a failed breakout, forming before completion', () => {
  const up = walk(DATE, [
    [0, 100],
    [30, 101],
    [45, 101.5],
    [60, 100.5],
    [75, 102.2],
    [90, 101.8],
  ])
  const r = read(up, 660)
  const ib = r.ranges.find(x => x.minutes === 60)!
  expect(ib.complete).toBe(true)
  close(ib.high, 101.51, 2)
  close(ib.low, 99.99, 2)
  expect(ib.status).toBe('above')
  close(ib.widthVsAtr, 0.76, 2)
  expect(r.ranges.find(x => x.minutes === 30)!.status).toBe('above')
  expect(r.levels.some(l => l.kind === 'initial balance high')).toBe(true)

  const failed = walk(DATE, [
    [0, 100],
    [30, 100.5],
    [40, 99.8],
    [60, 100.2],
    [70, 100.9],
    [90, 100.3],
  ])
  const f = read(failed, 660)
  expect(f.ranges.find(x => x.minutes === 60)!.status).toBe('failed above')
  expect(f.ranges.find(x => x.minutes === 30)!.status).toBe('failed above')
  expect(f.flags.some(x => x.en.startsWith('Failed breakout above the initial balance'))).toBe(true)

  const early = read(failed, 615)
  const ibEarly = early.ranges.find(x => x.minutes === 60)!
  expect(ibEarly.complete).toBe(false)
  expect(ibEarly.status).toBe('forming')
  expect(early.ranges.find(x => x.minutes === 30)!.complete).toBe(true)
  expect(early.ranges.find(x => x.minutes === 5)!.complete).toBe(true)
})

// ---------------------------------------------------------------- VWAP

test('VWAP on a hand-computable case: (10×100 + 12×300) / 400 = 11.5, σ = √0.75', () => {
  const bars: MinuteBar[] = [
    { t: at(DATE, 570), date: DATE, time: '09:30', o: 10, h: 10, l: 10, c: 10, v: 100 },
    { t: at(DATE, 571), date: DATE, time: '09:31', o: 12, h: 12, l: 12, c: 12, v: 300 },
  ]
  const v = read(bars, 572).vwap!
  close(v.value, 11.5, 6)
  close(v.upper1 - v.value, Math.sqrt(0.75), 3)
  close(v.lower2, 11.5 - 2 * Math.sqrt(0.75), 3)
  close(v.vsPct, (12 / 11.5 - 1) * 100, 2)
  expect(v.pctTimeAbove).toBe(50)
  expect(v.series.length).toBe(2)
  expect(v.series[0]!.vwap).toBe(10)
  // VWAP rose from 10 to 11.5 in one minute: +15% in 1/60 h
  close(v.slopePctPerHour, 15 * 60, 0)
})

// ---------------------------------------------------------------- relative volume

function flatHistory(dates: string[], v = 1000): MinuteBar[] {
  return dates.flatMap(d =>
    walk(
      d,
      [
        [0, 100],
        [390, 100],
      ],
      { step: 5, v },
    ),
  )
}

test('rvol: cumulative volume since the open vs the same minutes of past sessions, interpolated inside 5-minute bars', () => {
  const history = flatHistory(weekdaysBefore(3))
  const today = walk(
    DATE,
    [
      [0, 100],
      [30, 100.3],
    ],
    { v: 400 },
  )
  // 10:00: 30 × 400 = 12,000 vs 6 × 1,000 = 6,000
  const r = read(today, 600, { history })
  expect(r.rvol).toEqual({ value: 2, sessions: 3 })
  // 09:47:30: 18 bars × 400 = 7,200 vs 3.5 slots × 1,000
  const half = analyzeIntraday(data(today, { history }), { now: at(DATE, 587) + 30_000 })
  close(half.rvol!.value, 7200 / 3500, 2)
})

// ---------------------------------------------------------------- gap

test('gap up: direction, size vs ATR, filled only once price trades back to the prior close', () => {
  const holding = walk(DATE, [
    [0, 100.8],
    [30, 101.2],
  ])
  const h = read(holding, 600)
  expect(h.gap.direction).toBe('up')
  close(h.gap.pct, 0.8, 2)
  close(h.gap.vsAtr, 0.4, 2)
  expect(h.gap.filled).toBe(false)

  const filling = walk(DATE, [
    [0, 100.8],
    [40, 99.9],
    [60, 100.3],
  ])
  const f = read(filling, 630)
  expect(f.gap.filled).toBe(true)
  expect(f.flags.some(x => x.en.startsWith('Gap up of 0.80% filled'))).toBe(true)

  const flat = walk(DATE, [
    [0, 100.1],
    [30, 100.2],
  ])
  expect(read(flat, 600).gap.direction).toBe('flat')
})

// ---------------------------------------------------------------- phase

test('phase follows the New York clock; another day is closed', () => {
  const pre: MinuteBar[] = [{ t: at(DATE, 480), date: DATE, time: '08:00', o: 100.5, h: 100.6, l: 100.4, c: 100.5, v: 500 }]
  const bars = [
    ...pre,
    ...walk(DATE, [
      [0, 100.5],
      [390, 101],
    ]),
  ]
  const phase = (nowMs: number): SessionPhase => analyzeIntraday(data(bars), { now: nowMs }).phase
  expect(phase(at(DATE, 180))).toBe('closed')
  expect(phase(at(DATE, 481))).toBe('pre-market')
  expect(phase(at(DATE, 580))).toBe('opening range')
  expect(phase(at(DATE, 615))).toBe('first hour')
  expect(phase(at(DATE, 720))).toBe('regular')
  expect(phase(at(DATE, 1020))).toBe('after hours')
  expect(phase(at(DATE, 1260))).toBe('closed')
  expect(phase(at('2026-11-21', 720))).toBe('closed')

  const p = analyzeIntraday(data(bars), { now: at(DATE, 481) })
  expect(p.premarket).toEqual({ high: 100.6, low: 100.4, last: 100.5, volume: 500 })
  expect(p.gap.direction).toBe('up')
  expect(p.ranges).toEqual([])
  expect(p.minutesSinceOpen).toBe(-89)
  expect(p.study).toBeUndefined()
  expect(p.confidence).toBeLessThanOrEqual(0.2)

  // A closed session (weekend read) sees every bar.
  const closed = analyzeIntraday(data(bars), { now: at('2026-11-21', 720) })
  expect(closed.price).toBe(101)
  expect(closed.ranges.every(r => r.complete)).toBe(true)
})

// ---------------------------------------------------------------- the session study

test('study: past states use only bars before `at` (the afternoon would flip every feature)', () => {
  const dates = weekdaysBefore(12)
  const history: MinuteBar[] = []
  let last = 100
  for (const d of dates) {
    // Flat open at the prior close, a steady rise into 10:30, then a collapse to −3% by the close.
    const base = last
    history.push(
      ...walk(
        d,
        [
          [0, base],
          [60, base * 1.01],
          [390, base * 0.98],
        ],
        { step: 5 },
      ),
    )
    last = history[history.length - 1]!.c
  }
  const today = walk(DATE, [
    [0, last],
    [60, last * 1.01],
  ])
  const r = analyzeIntraday(data(today, { history, prev: { date: dates[dates.length - 1]!, close: last, high: last * 1.01, low: last * 0.98 } }), { now: at(DATE, 630) })
  const s = r.study!
  expect(s.at).toBe('10:30')
  // the first history session has no prior close, the other 11 all match on all three features
  expect(s.n).toBe(11)
  expect(s.matchedOn.en).toBe('above VWAP, above the 30-min range, flat open')
  expect(s.closeAboveNow).toBe(0)
  expect(s.closeAboveOpen).toBe(0)
  close(s.meanRestOfDay, (0.98 / 1.01 - 1) * 100, 1)
  expect(s.baseline.n).toBe(11)
  expect(s.dates[0]).toBe(dates[dates.length - 1]!)
  expect(s.dates.includes(DATE)).toBe(false)
  // every past session matched, so there is no edge over the baseline
  expect(s.baseline.closeAboveNow).toBe(0)
  expect(r.flags.some(x => x.en.startsWith('Sessions like this one'))).toBe(false)
})

test('study relaxes the match (gap first) until 8 sessions match, and says so for small samples', () => {
  const dates = weekdaysBefore(10)
  const history = dates.flatMap(d =>
    walk(
      d,
      [
        [0, 100],
        [60, 101],
        [390, 101.5],
      ],
      { step: 5 },
    ),
  )
  // Every past session opened flat; today gaps up 1%, so the gap feature has to go.
  const today = walk(DATE, [
    [0, 102.5],
    [60, 103.5],
  ])
  const s = analyzeIntraday(data(today, { history, prev: { date: dates[dates.length - 1]!, close: 101.5, high: 101.6, low: 100 } }), { now: at(DATE, 630) }).study!
  expect(s.n).toBe(9)
  expect(s.matchedOn.en).toBe('above VWAP, above the 30-min range')
  expect(s.note.en.includes('Small sample')).toBe(true)
})

// ---------------------------------------------------------------- loading through a fake fetch

const cnbcBar = (date: string, time: string, o: number, h: number, l: number, c: number, v: number) => ({
  open: o.toFixed(4),
  high: h.toFixed(4),
  low: l.toFixed(4),
  close: c.toFixed(4),
  volume: v,
  tradeTime: `${date.replace(/-/g, '')}${time.replace(':', '')}00`,
  tradeTimeinMills: etInstant(date, Number(time.slice(0, 2)), Number(time.slice(3, 5))),
})

/** 5-minute history in CNBC's shape: 16 sessions, each with a zero-volume 20:00 close marker, plus a stray weekend bar. */
function historyFixture(): { json: unknown; dates: string[] } {
  const dates = weekdaysBefore(16)
  const rows: unknown[] = []
  dates.forEach((d, i) => {
    const base = 100 + i
    rows.push(cnbcBar(d, '04:00', base, base + 0.2, base - 0.2, base, 2000))
    for (let x = 0; x < 390; x += 5) {
      const p = base + Math.sin(x / 40)
      rows.push(cnbcBar(d, hhmm(570 + x), p, p + 0.3, p - 0.3, p + 0.05, 10000))
    }
    rows.push(cnbcBar(d, '16:00', base, base + 0.1, base - 0.1, base, 5_000_000))
    rows.push(cnbcBar(d, '20:00', base + 0.25, base + 0.25, base + 0.25, base + 0.25, 0))
  })
  rows.push(cnbcBar('2026-10-31', '13:35', 99, 99, 99, 99, 0))

  return { json: { barData: { priceBars: rows } }, dates }
}

function todayFixture(date: string) {
  return {
    barData: {
      priceBars: [
        cnbcBar(date, '04:00', 116.5, 116.8, 116.2, 116.6, 3000),
        cnbcBar(date, '04:01', 116.6, 116.7, 116.5, 116.6, 0),
        cnbcBar(date, '08:15', 116.6, 117.0, 116.6, 116.9, 5000),
        cnbcBar(date, '09:30', 117.0, 117.4, 116.9, 117.3, 90000),
        cnbcBar(date, '09:31', 117.3, 117.5, 117.2, 117.4, 40000),
      ],
    },
  }
}

function fakeFetch(map: (url: string) => unknown | undefined, calls: string[] = []): Fetch {
  return async url => {
    calls.push(url)
    const body = map(url)
    if (body === undefined) return { status: 500, ok: false, headers: {}, text: 'nope' } as never

    return { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } as never
  }
}

test('loadIntraday: CNBC 1M today + 5M history → session, prior close from the close marker, ATR, today excluded', async () => {
  const h = historyFixture()
  const calls: string[] = []
  const fetch = fakeFetch(url => (url.includes('/5M/') ? h.json : url.includes('/1M/20261119000000/') ? todayFixture(DATE) : undefined), calls)
  const d = await loadIntraday(fetch, 'spy', { now: at(DATE, 572) })
  expect(d.symbol).toBe('SPY')
  expect(d.sessionDate).toBe(DATE)
  expect(d.bars.length).toBe(4) // the zero-volume bar is dropped
  expect(d.bars[0]!.time).toBe('04:00')
  expect(d.bars[2]!.c).toBe(117.3)
  expect(d.prev).toEqual({ date: h.dates[15]!, close: 115.25, high: expect.any(Number), low: expect.any(Number) } as never)
  expect(d.prev.high).toBeGreaterThan(d.prev.low)
  expect(d.history.some(b => b.date === '2026-10-31')).toBe(false)
  expect(d.history.some(b => b.date === DATE)).toBe(false)
  expect(d.dailyAtr).toBeGreaterThan(1)
  expect(calls.some(u => u.includes('/SPY/1M/20261119000000/20261119235900/adjusted/EST5EDT.json'))).toBe(true)

  const r = analyzeIntraday(d, { now: at(DATE, 572) })
  expect(r.phase).toBe('opening range')
  expect(r.premarket!.high).toBe(117)
  expect(r.open).toBe(117)
  close(r.gap.pct, (117 / 115.25 - 1) * 100, 2)
  expect(r.rvol!.sessions).toBe(16)

  expect(barsUrl('@SP.1', '5M', '2026-08-01', DATE)).toBe('https://ts-api.cnbc.com/harmony/app/bars/@SP.1/5M/20260801000000/20261119235900/adjusted/EST5EDT.json')
})

test('loadIntraday on a weekend falls back to the latest session', async () => {
  const h = historyFixture()
  const last = h.dates[15]!
  const lastKey = `/1M/${last.replace(/-/g, '')}000000/`
  const fetch = fakeFetch(url => (url.includes('/5M/') ? h.json : url.includes('/1M/20261121000000/') ? { barData: { priceBars: [] } } : url.includes(lastKey) ? todayFixture(last) : undefined))
  const d = await loadIntraday(fetch, 'SPY', { now: at('2026-11-21', 720) })
  expect(d.sessionDate).toBe(last)
  expect(d.prev.date).toBe(h.dates[14]!)
  expect(d.history.some(b => b.date === last)).toBe(false)
  expect(analyzeIntraday(d, { now: at('2026-11-21', 720) }).phase).toBe('closed')
})

// ---------------------------------------------------------------- breadth

const quote = (symbol: string, last: number, prev: number, open: number, extra: Record<string, unknown> = {}) => ({
  symbol,
  code: 0,
  last: last.toFixed(2),
  open: open.toFixed(2),
  change: (last - prev >= 0 ? '+' : '') + (last - prev).toFixed(2),
  change_pct: `${((last / prev - 1) * 100).toFixed(2)}%`,
  previous_day_closing: prev.toFixed(2),
  last_time: '2026-11-19T10:14:28.601-0500',
  curmktstatus: 'REG_MKT',
  ...extra,
})

/** Nov 19 10:14 ET as CNBC showed it: a narrow, tech-led rally. */
const BREADTH_FIXTURE = {
  FormattedQuoteResult: {
    FormattedQuote: [
      quote('XLK', 167.8, 163.81, 167.42),
      quote('XLF', 56.26, 56.42, 56.51),
      quote('XLE', 61.38, 61.29, 61.71),
      quote('XLV', 179.17, 181.17, 180.4),
      quote('XLY', 118.73, 119.2, 119.59),
      quote('XLP', 89.5, 91.18, 90.05),
      quote('XLI', 164.51, 164.66, 165.76),
      quote('XLB', 50.17, 50.46, 50.3),
      quote('XLU', 43.09, 43.55, 43.33),
      quote('XLRE', 43.26, 43.62, 43.45),
      quote('XLC', 105.85, 105.58, 106.69),
      quote('RSP', 214.83, 215.43, 215.91),
      quote('SPY', 735.29, 730.2, 737.46),
      quote('QQQ', 670.18, 659.51, 671.09),
      quote('IWM', 269.74, 270.12, 271.08),
      quote('SMH', 474.59, 459.54, 473.05),
      quote('DIA', 501.25, 501.73, 504),
      quote('.VIX', 23.02, 24.56, 22.06),
      { symbol: 'BAD', code: 1 },
    ],
  },
}

test('breadth: sector ETFs and RSP vs SPY read a narrow, tech-led rally', () => {
  const b = parseBreadth(BREADTH_FIXTURE)
  expect(b.sectors.length).toBe(11)
  expect(b.benchmarks.map(x => x.symbol)).toEqual(['RSP', 'SPY', 'QQQ', 'IWM', 'SMH', 'DIA'])
  expect(b.sectorsUp).toBe(3)
  close(b.rspMinusSpy, -0.98, 2)
  close(b.qqqMinusSpy, 0.92, 2)
  close(b.vix!.changePct, -6.27, 2)
  expect(b.asOf).toBe('2026-11-19T10:14:28.601-05:00')

  close(b.vix!.vsOpenPct, (23.02 / 22.06 - 1) * 100, 2)

  // SPY rising with that breadth: the narrow move discounts the bullish read
  const bars = walk(DATE, [
    [0, 735],
    [44, 737.5],
  ])
  const r = analyzeIntraday(data(bars, { prev: { date: PREV, close: 730.2, high: 732, low: 726 } }), { now: at(DATE, 614), breadth: b })
  const row = r.readings.find(x => x.name.en === 'Breadth')!
  expect((row.value as Text).en).toBe('a narrow, tech-led rally')
  expect(r.flags.some(x => x.en.startsWith('A narrow, tech-led rally') && x.en.includes('discounted'))).toBe(true)
  expect(r.score).toBeGreaterThan(0)
  const falling = analyzeIntraday(data(walk(DATE, [[0, 737.4], [44, 733]]), { prev: { date: PREV, close: 730.2, high: 732, low: 726 } }), { now: at(DATE, 614), breadth: b })
  expect(falling.flags.some(x => x.en.startsWith('A narrow, tech-led rally') && !x.en.includes('discounted'))).toBe(true)

  // pre-market rows use the extended-hours price against the regular last
  const pre = parseBreadth({ FormattedQuoteResult: { FormattedQuote: [quote('SPY', 730.2, 728, 729, { curmktstatus: 'PRE_MKT', ExtendedMktQuote: { last: '737.30', last_time: '2026-11-19T09:00:00.000-0500' } })] } })
  expect(pre.benchmarks[0]).toEqual({ symbol: 'SPY', name: pre.benchmarks[0]!.name, last: 737.3, open: 737.3, prevClose: 730.2, changePct: 0.97, vsOpenPct: 0 })
})

test('buildIntraday: a failing quote source goes into errors, it does not throw', async () => {
  const h = historyFixture()
  const fetch = fakeFetch(url => (url.includes('/5M/') ? h.json : url.includes('/1M/') ? todayFixture(DATE) : undefined))
  const r = await buildIntraday(fetch, 'SPY', { now: at(DATE, 572) })
  expect(r.errors.length).toBe(1)
  expect(r.errors[0]!.startsWith('breadth:')).toBe(true)
  expect(intradayMarkdown(r).includes('Data gaps: breadth')).toBe(true)
})

// ---------------------------------------------------------------- the full read

function fullRead(nowMin = 645) {
  const history = flatHistory(weekdaysBefore(20))
  const today = walk(DATE, [
    [0, 100.6],
    [4, 100.4],
    [30, 101.4],
    [60, 101.2],
    [75, 102.0],
    [390, 101.5],
  ])
  const pre: MinuteBar[] = [{ t: at(DATE, 500), date: DATE, time: '08:20', o: 100.5, h: 100.9, l: 100.3, c: 100.6, v: 2000 }]

  return analyzeIntraday(data([...pre, ...today], { history }), {
    now: at(DATE, nowMin),
    breadth: parseBreadth(BREADTH_FIXTURE),
    options: { gammaFlip: 100.8, callWall: 102.2, putWall: 99, maxPain: 100, todayMove: { expiry: DATE, pct: 1.1, lo: 99, hi: 101.3 } },
    daily: { supports: [99.5, 98], resistances: [103, 105] },
  })
}

test('full read: levels highest first and deduplicated, scenarios, timeline at the checkpoints reached, markdown', () => {
  const r = fullRead()
  expect(r.phase).toBe('regular')
  expect(r.openType).toBe('open-test-drive up')
  expect(r.ranges.find(x => x.minutes === 60)!.status).toBe('above')
  expect(r.score).toBeGreaterThan(15)
  expect(r.confidence).toBeGreaterThan(0.3)
  const prices = r.levels.map(l => l.price)
  expect([...prices].sort((a, b) => b - a)).toEqual(prices)
  for (let i = 1; i < prices.length; i++) expect(Math.abs(prices[i - 1]! / prices[i]! - 1)).toBeGreaterThan(0.0005)
  const kinds = new Set(r.levels.map(l => l.kind))
  for (const k of ['prior close', 'open', 'initial balance high', 'VWAP', 'gamma flip', 'call wall', 'put wall', 'daily resistance', 'daily support', 'pre-market high'] as IntradayLevel['kind'][]) expect(kinds.has(k)).toBe(true)
  expect(r.scenarios.map(s => s.name)).toEqual(['trend up', 'range', 'reversal down', 'trend down'])
  expect(r.scenarios[0]!.trigger.en.includes('already broken')).toBe(true)
  expect(r.timeline.map(c => c.time)).toEqual(['09:35', '09:45', '10:00', '10:30'])
  expect(r.timeline[3]!.note.en.includes('inside the initial balance')).toBe(true)
  expect(fullRead(590).timeline.map(c => c.time)).toEqual(['09:35', '09:45'])
  const md = intradayMarkdown(r)
  expect(md.startsWith('# SPY intraday — ')).toBe(true)
  for (const part of ['Levels (highest first)', 'Scenarios for the rest of the session', 'First-hour timeline', 'Session study at 10:45', 'no NYSE TICK']) expect(md.includes(part)).toBe(true)
})

test('every Text in a read has Chinese on the zh side', () => {
  expectTranslated(fullRead())
  expectTranslated(fullRead(480))
  expectTranslated(fullRead(1300))
  const phases: SessionPhase[] = ['pre-market', 'opening range', 'first hour', 'regular', 'after hours', 'closed']
  const types: OpenType[] = ['too early', 'open-drive up', 'open-drive down', 'open-test-drive up', 'open-test-drive down', 'open-rejection-reverse up', 'open-rejection-reverse down', 'open-auction']
  const statuses: RangeStatus[] = ['forming', 'inside', 'above', 'below', 'failed above', 'failed below']
  const kinds: IntradayLevel['kind'][] = [
    'prior close',
    'prior high',
    'prior low',
    'pre-market high',
    'pre-market low',
    'open',
    'opening range high',
    'opening range low',
    'initial balance high',
    'initial balance low',
    'VWAP',
    'VWAP +1σ',
    'VWAP −1σ',
    'gamma flip',
    'call wall',
    'put wall',
    'daily resistance',
    'daily support',
  ]
  expectTranslated([...phases.map(phaseText), ...types.map(openTypeText), ...statuses.map(rangeStatusText), ...kinds.map(levelKindTextIntraday)])
})

// ---------------------------------------------------------------- archive summary

test('summarizeDay: needs a full session; records the 10:00 and 10:30 states', () => {
  const bars = walk(DATE, [
    [0, 100],
    [30, 101],
    [60, 100.5],
    [390, 102],
  ])
  const s = summarizeDay(data(bars))!
  expect(s.open).toBe(100)
  expect(s.close).toBe(102)
  expect(s.prevClose).toBe(100)
  expect(s.at['10:00'].price).toBe(101)
  expect(s.at['10:30'].price).toBe(100.5)
  close(s.at['10:30'].or30High, 101.01, 2)
  close(s.ibHigh, 101.01, 2)
  expect(summarizeDay(data(bars.slice(0, 80)))).toBeUndefined()
})
