import { etTime, tr } from './i18n'
import type { Lang } from './i18n'
import type { CalCategory, Calendar, EconEvent, MyEvent, TickerData } from '../types'

export type CalEvent = {
  date: string
  /** ET, "08:30"; absent for all-day events. */
  time?: string
  category: CalCategory
  title: string
  detail?: string
  importance: 1 | 2 | 3
  /** Set on events the person or Claude added, so they can be removed. */
  myId?: string
}

export const CATEGORY: Record<CalCategory, { label: string; labelZh: string; color: string }> = {
  watchlist: { label: 'Your stocks', labelZh: '自选股', color: '#22c55e' },
  'big-earnings': { label: 'Big earnings', labelZh: '大公司财报', color: '#f59e0b' },
  economy: { label: 'Economy', labelZh: '经济数据', color: '#0ea5e9' },
  fed: { label: 'Fed', labelZh: '美联储', color: '#a855f7' },
  politics: { label: 'Politics', labelZh: '政治', color: '#ef4444' },
  market: { label: 'Market', labelZh: '市场', color: '#64748b' },
  mine: { label: 'Mine', labelZh: '我的', color: '#ec4899' },
}

/** A calendar category's name in the language asked. */
export const categoryLabel = (c: CalCategory, lang: Lang = 'en'): string => (lang === 'zh' ? CATEGORY[c].labelZh : CATEGORY[c].label)

// ---------- economic release names ----------

// Nasdaq's names for US releases, in Chinese. Keys are matched after
// `econKey` (lower case, hyphens dropped, punctuation to spaces), and each
// entry can list the other spellings Nasdaq uses.
const ECON_ZH: [string[], string][] = [
  // jobs
  [['Nonfarm Payrolls', 'Non Farm Payrolls', 'Nonfarm Employment Change'], '非农就业人数'],
  [['Private Nonfarm Payrolls'], '私营部门非农就业人数'],
  [['Manufacturing Payrolls'], '制造业就业人数'],
  [['Unemployment Rate'], '失业率'],
  [['U6 Unemployment Rate'], 'U6 失业率'],
  [['Participation Rate', 'Labor Force Participation Rate'], '劳动参与率'],
  [['Average Hourly Earnings'], '平均时薪'],
  [['Average Weekly Hours'], '平均每周工时'],
  [['Initial Jobless Claims'], '初请失业金人数'],
  [['Continuing Jobless Claims'], '续请失业金人数'],
  [['Jobless Claims 4-Week Avg.', 'Jobless Claims 4-Week Average'], '初请失业金人数四周均值'],
  [['ADP Nonfarm Employment Change', 'ADP Employment Change', 'ADP Nonfarm Payrolls'], 'ADP 非农就业人数'],
  [['ADP Employment Change Weekly'], 'ADP 每周就业变化'],
  [['JOLTS Job Openings', 'JOLTs Job Openings'], 'JOLTS 职位空缺'],
  [['Challenger Job Cuts'], '挑战者企业裁员人数'],
  [['Nonfarm Productivity'], '非农生产率'],
  [['Unit Labor Costs'], '单位劳动力成本'],
  [['Employment Cost Index'], '就业成本指数'],
  // inflation
  [['CPI', 'Consumer Price Index'], '消费者物价指数（CPI）'],
  [['Core CPI', 'Core Consumer Price Index'], '核心 CPI'],
  [['Cleveland CPI'], '克利夫兰联储 CPI'],
  [['PPI', 'Producer Price Index'], '生产者物价指数（PPI）'],
  [['Core PPI', 'Core Producer Price Index'], '核心 PPI'],
  [['PCE Price Index', 'PCE Prices'], 'PCE 物价指数'],
  [['Core PCE Price Index', 'Core PCE Prices'], '核心 PCE 物价指数'],
  [['Import Price Index'], '进口物价指数'],
  [['Export Price Index'], '出口物价指数'],
  [['Michigan 1-Year Inflation Expectations'], '密歇根大学 1 年期通胀预期'],
  [['Michigan 5-Year Inflation Expectations'], '密歇根大学 5 年期通胀预期'],
  [['NY Fed 1-Year Consumer Inflation Expectations'], '纽约联储 1 年期消费者通胀预期'],
  // growth and spending
  [['GDP', 'Gross Domestic Product'], '国内生产总值（GDP）'],
  [['GDP Price Index'], 'GDP 价格指数'],
  [['GDP Sales', 'Real Final Sales'], 'GDP 最终销售'],
  [['Atlanta Fed GDPNow'], '亚特兰大联储 GDPNow'],
  [['Retail Sales'], '零售销售'],
  [['Core Retail Sales', 'Retail Sales Ex Autos'], '核心零售销售'],
  [['Retail Control'], '零售销售控制组'],
  [['Retail Sales Ex Gas/Autos'], '除汽油和汽车外零售销售'],
  [['Personal Income'], '个人收入'],
  [['Personal Spending'], '个人支出'],
  [['Durable Goods Orders'], '耐用品订单'],
  [['Core Durable Goods Orders'], '核心耐用品订单'],
  [['Factory Orders'], '工厂订单'],
  [['Industrial Production'], '工业产出'],
  [['Capacity Utilization Rate', 'Capacity Utilization'], '产能利用率'],
  [['Business Inventories'], '商业库存'],
  [['Wholesale Inventories'], '批发库存'],
  [['Construction Spending'], '营建支出'],
  [['Trade Balance'], '贸易差额'],
  [['Goods Trade Balance'], '商品贸易差额'],
  [['Federal Budget Balance'], '联邦预算收支'],
  [['US Leading Index', 'CB Leading Index', 'Leading Indicators'], '谘商会领先指标'],
  [['Consumer Credit'], '消费信贷'],
  // surveys
  [['ISM Manufacturing PMI'], 'ISM 制造业 PMI'],
  [['ISM Manufacturing Prices'], 'ISM 制造业物价指数'],
  [['ISM Non-Manufacturing PMI', 'ISM Services PMI'], 'ISM 非制造业 PMI'],
  [['ISM Non-Manufacturing Prices', 'ISM Services Prices'], 'ISM 非制造业物价指数'],
  [['S&P Global Manufacturing PMI'], '标普全球制造业 PMI'],
  [['S&P Global Services PMI'], '标普全球服务业 PMI'],
  [['S&P Global Composite PMI'], '标普全球综合 PMI'],
  [['Michigan Consumer Sentiment', 'UoM Consumer Sentiment', 'University of Michigan Consumer Sentiment'], '密歇根大学消费者信心指数'],
  [['Michigan Consumer Expectations'], '密歇根大学消费者预期指数'],
  [['CB Consumer Confidence', 'Conference Board Consumer Confidence', 'Consumer Confidence'], '谘商会消费者信心指数'],
  [['Philadelphia Fed Manufacturing Index', 'Philly Fed Manufacturing Index'], '费城联储制造业指数'],
  [['NY Empire State Manufacturing Index', 'Empire State Manufacturing Index'], '纽约联储制造业指数'],
  [['NFIB Small Business Optimism'], 'NFIB 小企业乐观指数'],
  // housing
  [['Housing Starts'], '新屋开工'],
  [['Building Permits'], '营建许可'],
  [['Existing Home Sales'], '成屋销售'],
  [['New Home Sales'], '新屋销售'],
  [['Pending Home Sales'], '成屋签约销售'],
  [['NAHB Housing Market Index'], 'NAHB 房产市场指数'],
  // energy
  [['Crude Oil Inventories', 'EIA Crude Oil Inventories'], 'EIA 原油库存'],
  [['API Weekly Crude Oil Stock'], 'API 原油库存'],
  [['Natural Gas Storage'], 'EIA 天然气库存'],
  [['Gasoline Inventories'], 'EIA 汽油库存'],
  // the Fed
  [['Fed Interest Rate Decision', 'Interest Rate Decision'], '美联储利率决议'],
  [['FOMC Statement'], 'FOMC 声明'],
  [['FOMC Press Conference'], 'FOMC 新闻发布会'],
  [['FOMC Meeting Minutes', 'FOMC Minutes'], 'FOMC 会议纪要'],
  [['FOMC Economic Projections'], 'FOMC 经济预测'],
  [["Fed's Balance Sheet"], '美联储资产负债表'],
  [['Beige Book', 'Fed Beige Book'], '美联储褐皮书'],
]

/** Lower case, hyphens dropped, other punctuation to single spaces: "Non-Farm Payrolls." and "nonfarm payrolls" meet. */
const econKey = (name: string) =>
  name
    .replace(/&amp;/gi, '&')
    .toLowerCase()
    .replace(/[-‐–]/g, '')
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim()

const ECON_MAP = new Map<string, string>(ECON_ZH.flatMap(([names, zh]) => names.map((n): [string, string] => [econKey(n), zh])))

// Fed speakers: "Fed Chair Warsh Speaks", "FOMC Member Williams Speaks", "Fed Waller Speaks".
const SPEAKERS: [RegExp, string][] = [
  [/^fed chair (?:of the fed )?(.+?) speaks$/i, '美联储主席'],
  [/^fed vice chair for supervision (.+?) speaks$/i, '美联储负责监管的副主席'],
  [/^fed vice chair (.+?) speaks$/i, '美联储副主席'],
  [/^fed governor (.+?) speaks$/i, '美联储理事'],
  [/^fomc member (.+?) speaks$/i, 'FOMC 委员'],
  [/^fed(?:'s)? (.+?) speaks$/i, '美联储官员'],
]

const PERIOD_ZH: Record<string, string> = { mom: '月率', yoy: '年率', qoq: '季率' }

/** Joins two pieces of Chinese text, with a space where Latin letters or digits meet Chinese. */
function glue(a: string, b: string): string {
  const latinCjk = /[A-Za-z0-9%]$/.test(a) && /^[\u4e00-\u9fff]/.test(b)
  const cjkLatin = /[\u4e00-\u9fff]$/.test(a) && /^[A-Za-z0-9$]/.test(b)

  return latinCjk || cjkLatin ? `${a} ${b}` : `${a}${b}`
}

/**
 * An economic release's name in the language asked. Nasdaq writes them in
 * English and varies the wording; names the dictionary does not know stay
 * English. A "(MoM)" / "(YoY)" / "(QoQ)" ending becomes 月率 / 年率 / 季率.
 */
export function econName(name: string, lang: Lang = 'en'): string {
  if (lang !== 'zh') return name
  let base = name.trim()
  const tails: string[] = []
  for (let m = /\s*\(([^()]*)\)\s*$/.exec(base); m && m.index > 0; m = /\s*\(([^()]*)\)\s*$/.exec(base)) {
    const inner = m[1]!.trim()
    tails.unshift(PERIOD_ZH[inner.toLowerCase()] ?? `（${inner}）`)
    base = base.slice(0, m.index)
  }
  const join = (zh: string) => tails.reduce(glue, zh)
  const exact = ECON_MAP.get(econKey(base))
  if (exact) return join(exact)
  for (const [re, who] of SPEAKERS) {
    const m = re.exec(base)
    if (m) return join(`${who} ${m[1]} 讲话`)
  }
  const core = /^core\s+(.+)$/i.exec(base)
  const rest = core ? ECON_MAP.get(econKey(core[1]!)) : undefined
  if (rest) return join(glue('核心', rest))

  return name
}

// Releases that move the whole market (3) or are worth knowing (2).
const TIER_3 = /^(core )?cpi\b|^(core )?ppi\b|pce price index|^nonfarm payrolls$|^unemployment rate$|^gdp\b|fed interest rate decision|fomc statement|fomc press conference/i
const TIER_2 = /ism (manufacturing|non-manufacturing) pmi|^(core )?retail sales|^initial jobless claims$|jolts job openings|adp nonfarm|michigan consumer sentiment$|consumer confidence$|^durable goods orders|fomc meeting minutes|fed chair|^average hourly earnings|^private nonfarm payrolls$/i

// Index levels and unadjusted series repeat a headline release: leave them out.
const REPEATS = /\bindex\b(?! of)|n\.s\.a|, s\.a|ex\. food\/energy\/transport/i

export function econTier(name: string): 0 | 2 | 3 {
  if (REPEATS.test(name) && !/pce price index/i.test(name)) return 0

  return TIER_3.test(name) ? 3 : TIER_2.test(name) ? 2 : 0
}

// The Fed's published 2026 schedule: the second day of each meeting, when the
// decision comes out at 2:00 pm ET and the chair holds a press conference.
const FOMC_DECISIONS = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09']

// ---------- dates ----------

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay()

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)

  return d.toISOString().slice(0, 10)
}

/** The `n`th given weekday (0 Sunday … 6 Saturday) of a month; `n` −1 is the last. */
function nthWeekday(year: number, month: number, day: number, n: number): string {
  if (n < 0) {
    const last = new Date(Date.UTC(year, month, 0, 12))
    const back = (last.getUTCDay() - day + 7) % 7

    return iso(year, month, last.getUTCDate() - back)
  }
  const first = new Date(Date.UTC(year, month - 1, 1, 12)).getUTCDay()

  return iso(year, month, 1 + ((day - first + 7) % 7) + (n - 1) * 7)
}

/** Easter Sunday (anonymous Gregorian algorithm). */
function easter(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1

  return iso(year, month, day)
}

/** A fixed-date holiday moved off the weekend: Saturday to Friday, Sunday to Monday. */
function observed(date: string): string {
  const w = weekday(date)

  return w === 6 ? shift(date, -1) : w === 0 ? shift(date, 1) : date
}

/** NYSE full closures and 1:00 pm early closes for one year, from the exchange's rules. */
const HOLIDAY_ZH: Record<string, string> = {
  "New Year's Day": '元旦',
  'Martin Luther King Jr. Day': '马丁·路德·金纪念日',
  "Presidents' Day": '总统日',
  'Good Friday': '耶稣受难日',
  'Memorial Day': '阵亡将士纪念日',
  Juneteenth: '六月节（Juneteenth）',
  'Independence Day': '独立日',
  'day before Independence Day': '独立日前一天',
  'Labor Day': '劳动节',
  Thanksgiving: '感恩节',
  'day after Thanksgiving': '感恩节次日',
  Christmas: '圣诞节',
  'Christmas Eve': '平安夜',
}

export function marketHolidays(year: number, lang: Lang = 'en'): CalEvent[] {
  const zh = (name: string) => HOLIDAY_ZH[name] ?? name
  const closed = (date: string, name: string): CalEvent => ({ date, category: 'market', title: tr(lang, `Market closed: ${name}`, `休市：${zh(name)}`), importance: 2 })
  const early = (date: string, name: string): CalEvent => ({
    date,
    time: '13:00',
    category: 'market',
    title: tr(lang, `Early close (1:00 pm ET): ${name}`, `提前收盘（${etTime('zh', '13:00')}）：${zh(name)}`),
    importance: 1,
  })
  const out: CalEvent[] = []
  const newYear = iso(year, 1, 1)
  // NYSE does not close on Friday Dec 31 when New Year's Day is a Saturday.
  if (weekday(newYear) !== 6) out.push(closed(observed(newYear), "New Year's Day"))
  out.push(closed(nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day'))
  out.push(closed(nthWeekday(year, 2, 1, 3), "Presidents' Day"))
  out.push(closed(shift(easter(year), -2), 'Good Friday'))
  out.push(closed(nthWeekday(year, 5, 1, -1), 'Memorial Day'))
  out.push(closed(observed(iso(year, 6, 19)), 'Juneteenth'))
  const july4 = observed(iso(year, 7, 4))
  out.push(closed(july4, 'Independence Day'))
  const july3 = iso(year, 7, 3)
  if (july4 === iso(year, 7, 4) && weekday(july3) >= 1 && weekday(july3) <= 4) out.push(early(july3, 'day before Independence Day'))
  out.push(closed(nthWeekday(year, 9, 1, 1), 'Labor Day'))
  const thanksgiving = nthWeekday(year, 11, 4, 4)
  out.push(closed(thanksgiving, 'Thanksgiving'))
  out.push(early(shift(thanksgiving, 1), 'day after Thanksgiving'))
  const christmas = iso(year, 12, 25)
  out.push(closed(observed(christmas), 'Christmas'))
  const eve = iso(year, 12, 24)
  if (weekday(eve) >= 1 && weekday(eve) <= 4) out.push(early(eve, 'Christmas Eve'))

  return out
}

/** Monthly options expiration (third Friday), quarterly "quad witching" in Mar/Jun/Sep/Dec. */
export function optionsExpirations(year: number, lang: Lang = 'en'): CalEvent[] {
  const out: CalEvent[] = []
  for (let month = 1; month <= 12; month++) {
    const isQuad = month % 3 === 0
    out.push({
      date: nthWeekday(year, month, 5, 3),
      category: 'market',
      title: isQuad ? tr(lang, 'Quad witching: quarterly options and futures expire', '四巫日（quad witching）：季度期权和期货同日到期') : tr(lang, 'Monthly options expiration', '月度期权到期'),
      detail: isQuad
        ? tr(lang, 'Very heavy volume near the close; index rebalances often land the same day.', '临近收盘时成交量极大；指数调仓也常在同一天进行。')
        : tr(lang, 'Volume and price swings can pick up as contracts expire.', '合约到期前后，成交量和价格波动可能加大。'),
      importance: isQuad ? 2 : 1,
    })
  }

  return out
}

/** US federal elections: the Tuesday after the first Monday of November, in even years. */
export function elections(year: number, lang: Lang = 'en'): CalEvent[] {
  if (year % 2 !== 0) return []
  const date = shift(nthWeekday(year, 11, 1, 1), 1)
  const isPresidential = year % 4 === 0

  return [
    {
      date,
      category: 'politics',
      title: isPresidential
        ? tr(lang, `US presidential election (${year})`, `美国总统大选（${year}）`)
        : tr(lang, `US midterm elections (${year}): all House seats, a third of the Senate`, `美国中期选举（${year}）：众议院全部席位和参议院三分之一席位改选`),
      detail: tr(lang, 'Results arrive overnight and can move sectors tied to policy (energy, health care, defense, banks) and the dollar.', '结果在隔夜陆续揭晓，可能影响与政策相关的板块（能源、医疗保健、国防、银行）以及美元。'),
      importance: 3,
    },
  ]
}

export function fedMeetings(lang: Lang = 'en'): CalEvent[] {
  return FOMC_DECISIONS.map(date => ({
    date,
    time: '14:00',
    category: 'fed',
    title: tr(lang, 'Fed rate decision (FOMC), press conference at 2:30 pm', `美联储利率决议（FOMC），${etTime('zh', '14:30')} 召开新闻发布会`),
    detail: tr(lang, 'The single biggest scheduled event for rates, the dollar and growth stocks.', '对利率、美元和成长股来说，影响最大的单一定期事件。'),
    importance: 3,
  }))
}

// ---------- the combined calendar ----------

/** "CPI (MoM)" and "Core CPI (YoY)" are one release: group them under "CPI". */
function econEvents(rows: EconEvent[], lang: Lang): CalEvent[] {
  const t = (en: string, zh: string) => tr(lang, en, zh)
  const groups = new Map<string, EconEvent[]>()
  for (const r of rows) {
    if (r.tier === 0) continue
    const family = r.name.replace(/\s*\((MoM|YoY|QoQ)\)\s*/i, '').replace(/^Core /i, '').trim()
    const key = `${r.date}|${r.time}|${family}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }

  return [...groups.entries()].map(([key, list]) => {
    const [date, time, family] = key.split('|') as [string, string, string]
    const isFed = /fed|fomc/i.test(family)
    const parts = list.slice(0, 4).map(r => {
      const isCore = /^Core /i.test(r.name)
      const hasCore = list.some(x => /^Core /i.test(x.name))
      const period = /\((MoM|YoY|QoQ)\)/i.exec(r.name)?.[1] ?? ''
      const periodZh = { mom: '月率', yoy: '年率', qoq: '季率' }[period.toLowerCase()] ?? period
      const variant =
        lang === 'zh'
          ? [isCore ? '核心' : hasCore ? '整体' : '', periodZh].filter(Boolean).join(' ')
          : [isCore ? 'core' : hasCore ? 'headline' : '', period].filter(Boolean).join(' ')
      const numbers = [r.actual && t(`actual ${r.actual}`, `公布值 ${r.actual}`), r.consensus && t(`forecast ${r.consensus}`, `预期 ${r.consensus}`), r.previous && t(`prev ${r.previous}`, `前值 ${r.previous}`)]
        .filter(Boolean)
        .join(t(', ', '，'))

      return numbers ? `${variant ? t(`${variant}: `, `${variant}：`) : ''}${numbers}` : ''
    })

    return {
      date,
      time: /^\d{1,2}:\d{2}$/.test(time) ? time : undefined,
      category: isFed ? 'fed' : 'economy',
      title: econName(family, lang),
      detail: parts.filter(Boolean).join(' · ') || undefined,
      importance: Math.max(...list.map(r => r.tier)) === 3 ? 3 : 2,
    }
  })
}

const WHEN: Record<string, string> = { 'pre-market': 'before the open', 'after-hours': 'after the close', 'not-supplied': 'time not announced' }

function earningsTitle(symbol: string, time: string, lang: Lang): string {
  if (lang !== 'zh') return `${symbol} earnings ${WHEN[time] ?? ''}`.trim()
  if (time === 'pre-market') return `${symbol} 盘前发布财报`
  if (time === 'after-hours') return `${symbol} 盘后发布财报`
  if (time === 'not-supplied') return `${symbol} 发布财报（时间未公布）`

  return `${symbol} 发布财报`
}

export function buildEvents(input: {
  today: string
  horizon: number
  calendar: Calendar
  tickers: Record<string, TickerData>
  watchlist: string[]
  mine: MyEvent[]
  /** The language of the titles and details the mod writes (default English). */
  lang?: Lang
}): CalEvent[] {
  const lang = input.lang ?? 'en'
  // Which events repeat one another is decided on the English titles, so both
  // languages keep the same events.
  const events = collectEvents(input, lang)
  const english = lang === 'en' ? events : collectEvents(input, 'en')
  const { today } = input
  const end = shift(today, input.horizon)
  const seen = new Set<string>()

  return events
    .filter((e, i) => {
      if (!(e.date >= today && e.date <= end)) return false
      const en = english[i]!
      const key = en.category === 'fed' && /rate decision/i.test(en.title) ? `${en.date}|fed-decision` : `${en.date}|${en.title}`
      if (seen.has(key)) return false
      seen.add(key)

      return true
    })
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.time ?? '00:00') < (b.time ?? '00:00') ? -1 : 1))
}

function collectEvents(input: Parameters<typeof buildEvents>[0], lang: Lang): CalEvent[] {
  const { today, calendar, tickers, watchlist } = input
  const end = shift(today, input.horizon)
  const years = [Number(today.slice(0, 4)), Number(end.slice(0, 4))].filter((y, i, a) => a.indexOf(y) === i)
  const events: CalEvent[] = []

  for (const rows of Object.values(calendar.earnings)) {
    for (const r of rows) {
      const isMine = watchlist.includes(r.symbol)
      if (!isMine && r.marketCap < 200e9) continue
      events.push({
        date: r.date,
        time: r.time === 'pre-market' ? '07:00' : r.time === 'after-hours' ? '16:05' : undefined,
        category: isMine ? 'watchlist' : 'big-earnings',
        title: earningsTitle(r.symbol, r.time, lang),
        detail: tr(
          lang,
          `${r.name}${r.quarter ? `, quarter ending ${r.quarter}` : ''} · EPS forecast ${r.epsForecast || '—'} (a year ago ${r.lastYearEPS || '—'})`,
          `${r.name}${r.quarter ? `，财季截至 ${r.quarter}` : ''} · EPS 预期 ${r.epsForecast || '—'}（去年同期 ${r.lastYearEPS || '—'}）`,
        ),
        importance: isMine ? 3 : 2,
      })
    }
  }

  for (const symbol of watchlist) {
    const s = tickers[symbol]?.summary
    if (s?.exDividend)
      events.push({
        date: s.exDividend,
        category: 'watchlist',
        title: tr(lang, `${symbol} ex-dividend date`, `${symbol} 除息日`),
        detail: tr(
          lang,
          `Buy before this day to receive the dividend${s.dividendYield ? ` (yield ${s.dividendYield})` : ''}; the price usually drops by the dividend amount.`,
          `在这一天之前买入才能拿到股息${s.dividendYield ? `（股息率 ${s.dividendYield}）` : ''}；当天股价通常会下跌约一笔股息的金额。`,
        ),
        importance: 1,
      })
    if (s?.dividendPay) events.push({ date: s.dividendPay, category: 'watchlist', title: tr(lang, `${symbol} dividend paid`, `${symbol} 股息发放日`), importance: 1 })
  }

  events.push(...econEvents(calendar.econ, lang))
  for (const year of years) events.push(...marketHolidays(year, lang), ...optionsExpirations(year, lang), ...elections(year, lang))
  // The economic feed also lists the Fed decision: buildEvents keeps one.
  events.push(...fedMeetings(lang))
  for (const m of input.mine) events.push({ date: m.date, category: m.category, title: m.title, detail: m.detail, importance: m.importance, myId: m.id })

  return events
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** What to type when a calendar entry has no date the parser understands. */
export const myEventHint = (lang: Lang = 'en'): string =>
  tr(lang, 'Start with a date: 2026-11-20 Nvidia GTC, 11/20 Nvidia GTC or Nov 20 Nvidia GTC', '请以日期开头：2026-11-20 Nvidia GTC、11/20 Nvidia GTC 或 11月20日 Nvidia GTC')

/**
 * "2026-11-20 Nvidia GTC", "11/20 Nvidia GTC", "Nov 20 Nvidia GTC",
 * "11月20日 Nvidia GTC" or "2026年11月20日 Nvidia GTC" → a date and a title;
 * a month/day already past this year means next year.
 */
export function parseMyEvent(text: string, today: string): { date: string; title: string } | undefined {
  const t = text.trim()
  const year = Number(today.slice(0, 4))
  const pick = (m: number, d: number, y?: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
    const date = iso(y ?? year, m, d)

    return y === undefined && date < today ? iso(year + 1, m, d) : date
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(.+)$/.exec(t)
  if (m) {
    const date = pick(Number(m[2]), Number(m[3]), Number(m[1]))

    return date ? { date, title: m[4]!.trim() } : undefined
  }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(.+)$/.exec(t)
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined
    const date = pick(Number(m[1]), Number(m[2]), y)

    return date ? { date, title: m[4]!.trim() } : undefined
  }
  m = /^(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]\s*(.+)$/.exec(t)
  if (m) {
    const date = pick(Number(m[2]), Number(m[3]), m[1] ? Number(m[1]) : undefined)

    return date ? { date, title: m[4]!.trim() } : undefined
  }
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+(.+)$/.exec(t)
  const month = m ? MONTHS[m[1]!.toLowerCase()] : undefined
  if (m && month) {
    const date = pick(month, Number(m[2]), m[3] ? Number(m[3]) : undefined)

    return date ? { date, title: m[4]!.trim() } : undefined
  }

  return undefined
}
