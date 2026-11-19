import { analyze } from './analysis'
import type { Tone } from './analysis'
import { relativeDays, tr } from './i18n'
import type { Lang } from './i18n'
import type { Calendar, Portfolio, Position, Rules, TickerData, Trade } from '../types'

export const DEFAULT_RULES: Rules = { maxWeightPct: 25, maxLossPct: 10, stopNearPct: 3, riskPerTradePct: 1, maxSectorPct: 50, earningsDays: 7 }
export const EMPTY_PORTFOLIO: Portfolio = { positions: [], cash: 0, trades: [], rules: DEFAULT_RULES }

export type RuleLabel = { key: keyof Rules; label: string; unit: string; meaning: string; labelZh: string; unitZh: string; meaningZh: string }

export const RULE_LABELS: RuleLabel[] = [
  {
    key: 'maxWeightPct',
    label: 'Largest position',
    unit: '% of portfolio',
    meaning: 'Flag any single stock bigger than this share of everything you hold.',
    labelZh: '单一持仓上限',
    unitZh: '占组合 %',
    meaningZh: '任何一只股票占你全部持仓的比例超过这个数时提醒。',
  },
  {
    key: 'maxLossPct',
    label: 'Loss alert',
    unit: '% below your cost',
    meaning: 'Flag a position once it is down this much from what you paid.',
    labelZh: '亏损预警',
    unitZh: '低于成本 %',
    meaningZh: '持仓较你的买入成本下跌这么多时提醒。',
  },
  {
    key: 'stopNearPct',
    label: 'Near-stop warning',
    unit: '% above the stop',
    meaning: 'Warn when the price comes within this distance of your stop.',
    labelZh: '接近止损预警',
    unitZh: '高于止损 %',
    meaningZh: '股价离你的止损价只剩这么近时提醒。',
  },
  {
    key: 'riskPerTradePct',
    label: 'Risk per trade',
    unit: '% of portfolio',
    meaning: 'What the position-size calculator lets one trade lose if its stop is hit.',
    labelZh: '单笔风险',
    unitZh: '占组合 %',
    meaningZh: '仓位计算器允许一笔交易在触及止损时亏掉的比例。',
  },
  {
    key: 'maxSectorPct',
    label: 'Largest sector',
    unit: '% of portfolio',
    meaning: 'Flag a sector bigger than this share of everything you hold.',
    labelZh: '单一板块上限',
    unitZh: '占组合 %',
    meaningZh: '任何一个板块占你全部持仓的比例超过这个数时提醒。',
  },
  {
    key: 'earningsDays',
    label: 'Earnings warning',
    unit: 'days ahead',
    meaning: 'Warn this many days before a holding reports earnings.',
    labelZh: '财报预警',
    unitZh: '提前天数',
    meaningZh: '持仓公司发布财报前这么多天提醒。',
  },
]

/** A rule's label, unit and meaning in the language asked. */
export function ruleText(rule: RuleLabel, lang: Lang = 'en'): { label: string; unit: string; meaning: string } {
  return lang === 'zh' ? { label: rule.labelZh, unit: rule.unitZh, meaning: rule.meaningZh } : { label: rule.label, unit: rule.unit, meaning: rule.meaning }
}

// Nasdaq's sector names, and the two the mod writes itself.
const SECTOR_ZH: Record<string, string> = {
  Technology: '科技',
  'Health Care': '医疗保健',
  Healthcare: '医疗保健',
  Finance: '金融',
  Financials: '金融',
  'Financial Services': '金融',
  'Consumer Discretionary': '非必需消费品',
  'Consumer Cyclical': '非必需消费品',
  'Consumer Staples': '必需消费品',
  'Consumer Defensive': '必需消费品',
  Industrials: '工业',
  Energy: '能源',
  Utilities: '公用事业',
  'Real Estate': '房地产',
  'Basic Materials': '基础材料',
  Materials: '基础材料',
  Telecommunications: '电信',
  'Communication Services': '通信服务',
  Miscellaneous: '其他',
  'ETF / fund': 'ETF / 基金',
  Unknown: '未知',
}

/** A sector's name in the language asked; names not in the list stay as Nasdaq wrote them. */
export const sectorName = (name: string, lang: Lang = 'en'): string => (lang === 'zh' ? (SECTOR_ZH[name] ?? name) : name)

export type Holding = Position & {
  price?: number
  value: number
  costBasis: number
  pnl: number
  pnlPct: number
  day: number
  dayPct: number
  weight: number
  sector: string
  riskToStop?: number
  toStopPct?: number
  toTargetPct?: number
}

export type Totals = {
  value: number
  invested: number
  cost: number
  pnl: number
  pnlPct: number
  day: number
  cash: number
  realized: number
  openRisk: number
  unprotected: number
}

export type Check = { tone: Tone; symbol?: string; text: string }

function priceOf(t: TickerData | undefined): { price?: number; change: number; changePct: number } {
  if (t?.quote) return { price: t.quote.price, change: t.quote.change, changePct: t.quote.changePct }
  const last = t?.bars[t.bars.length - 1]
  const prev = t?.bars[t.bars.length - 2]

  return last ? { price: last.c, change: prev ? last.c - prev.c : 0, changePct: prev ? ((last.c - prev.c) / prev.c) * 100 : 0 } : { change: 0, changePct: 0 }
}

export function valuePortfolio(pf: Portfolio, tickers: Record<string, TickerData>, lang: Lang = 'en'): { holdings: Holding[]; totals: Totals; sectors: [string, number][] } {
  const raw = pf.positions.map(p => {
    const t = tickers[p.symbol]
    const { price, change, changePct } = priceOf(t)
    const mark = price ?? p.cost

    return { p, price, change, changePct, value: mark * p.shares, sector: sectorName(t?.summary.sector || (t?.assetClass === 'etf' ? 'ETF / fund' : 'Unknown'), lang) }
  })
  const invested = raw.reduce((s, r) => s + r.value, 0)
  const total = invested + Math.max(0, pf.cash)
  const holdings: Holding[] = raw.map(({ p, price, change, changePct, value, sector }) => {
    const costBasis = p.cost * p.shares
    const mark = price ?? p.cost

    return {
      ...p,
      price,
      value,
      costBasis,
      pnl: value - costBasis,
      pnlPct: costBasis ? ((value - costBasis) / costBasis) * 100 : 0,
      day: change * p.shares,
      dayPct: changePct,
      weight: total ? (value / total) * 100 : 0,
      sector,
      riskToStop: p.stop !== undefined ? Math.max(0, mark - p.stop) * p.shares : undefined,
      toStopPct: p.stop !== undefined ? ((mark - p.stop) / mark) * 100 : undefined,
      toTargetPct: p.target !== undefined ? ((p.target - mark) / mark) * 100 : undefined,
    }
  })
  holdings.sort((a, b) => b.value - a.value)
  const cost = holdings.reduce((s, h) => s + h.costBasis, 0)
  const pnl = invested - cost
  const sectorMap = new Map<string, number>()
  for (const h of holdings) sectorMap.set(h.sector, (sectorMap.get(h.sector) ?? 0) + h.value)

  return {
    holdings,
    totals: {
      value: total,
      invested,
      cost,
      pnl,
      pnlPct: cost ? (pnl / cost) * 100 : 0,
      day: holdings.reduce((s, h) => s + h.day, 0),
      cash: Math.max(0, pf.cash),
      realized: pf.trades.reduce((s, t) => s + (t.realized ?? 0), 0),
      openRisk: holdings.reduce((s, h) => s + (h.riskToStop ?? 0), 0),
      unprotected: holdings.filter(h => h.stop === undefined).reduce((s, h) => s + h.value, 0),
    },
    sectors: [...sectorMap.entries()].map(([name, v]): [string, number] => [name, total ? (v / total) * 100 : 0]).sort((a, b) => b[1] - a[1]),
  }
}

const usd = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

/** Each holding measured against the rules the person set. Facts and thresholds, never buy or sell calls. */
export function runChecks(pf: Portfolio, tickers: Record<string, TickerData>, cal: Calendar, today: string, lang: Lang = 'en'): Check[] {
  const t = (en: string, zh: string) => tr(lang, en, zh)
  // Measured with the English sector names ('Unknown' is left out), written in the language asked.
  const { holdings, totals, sectors } = valuePortfolio(pf, tickers)
  const r = pf.rules
  const checks: Check[] = []
  const days = (iso: string) => Math.round((Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000)

  for (const h of holdings) {
    const price = h.price
    if (price === undefined) {
      checks.push({ tone: 'info', symbol: h.symbol, text: t(`${h.symbol}: no price yet.`, `${h.symbol}：还没有价格。`) })
      continue
    }
    if (h.stop !== undefined && price <= h.stop)
      checks.push({ tone: 'risk', symbol: h.symbol, text: t(`${h.symbol} is at $${price.toFixed(2)}, at or below your stop of $${h.stop.toFixed(2)}.`, `${h.symbol} 现价 $${price.toFixed(2)}，已触及或跌破你的止损价 $${h.stop.toFixed(2)}。`) })
    else if (h.toStopPct !== undefined && h.toStopPct <= r.stopNearPct)
      checks.push({
        tone: 'warn',
        symbol: h.symbol,
        text: t(
          `${h.symbol} is ${h.toStopPct.toFixed(1)}% above your stop of $${h.stop!.toFixed(2)} (your warning: ${r.stopNearPct}%).`,
          `${h.symbol} 只比你的止损价 $${h.stop!.toFixed(2)} 高 ${h.toStopPct.toFixed(1)}%（你设的预警线：${r.stopNearPct}%）。`,
        ),
      })
    if (h.target !== undefined && price >= h.target)
      checks.push({ tone: 'good', symbol: h.symbol, text: t(`${h.symbol} reached your target of $${h.target.toFixed(2)} (now $${price.toFixed(2)}).`, `${h.symbol} 已达到你的目标价 $${h.target.toFixed(2)}（现价 $${price.toFixed(2)}）。`) })
    if (-h.pnlPct >= r.maxLossPct)
      checks.push({
        tone: 'risk',
        symbol: h.symbol,
        text: t(
          `${h.symbol} is ${(-h.pnlPct).toFixed(1)}% below your cost of $${h.cost.toFixed(2)} (your alert: ${r.maxLossPct}%), a loss of ${usd(h.pnl)}.`,
          `${h.symbol} 比你的成本价 $${h.cost.toFixed(2)} 低 ${(-h.pnlPct).toFixed(1)}%（你设的预警线：${r.maxLossPct}%），浮动亏损 ${usd(h.pnl)}。`,
        ),
      })
    if (h.weight > r.maxWeightPct)
      checks.push({ tone: 'warn', symbol: h.symbol, text: t(`${h.symbol} is ${h.weight.toFixed(1)}% of your portfolio, above your ${r.maxWeightPct}% limit.`, `${h.symbol} 占你组合的 ${h.weight.toFixed(1)}%，超过你设的 ${r.maxWeightPct}% 上限。`) })
    if (h.stop === undefined)
      checks.push({ tone: 'info', symbol: h.symbol, text: t(`${h.symbol} has no stop set, so its downside isn't measured (${usd(h.value)} at stake).`, `${h.symbol} 没有设止损，下行风险无从衡量（涉及 ${usd(h.value)}）。`) })

    const data = tickers[h.symbol]
    const a = data ? analyze(data.bars, '3M') : undefined
    if (a && a.moveVsAtr !== undefined && a.change < 0 && a.moveVsAtr >= 2)
      checks.push({
        tone: 'warn',
        symbol: h.symbol,
        text: t(
          `${h.symbol} fell ${a.changePct.toFixed(1)}% last session, ${a.moveVsAtr.toFixed(1)}× its normal daily range: worth reading its news.`,
          `${h.symbol} 上一交易日下跌 ${Math.abs(a.changePct).toFixed(1)}%，是正常日波幅的 ${a.moveVsAtr.toFixed(1)}×：值得看看它的新闻。`,
        ),
      })
    if (a) {
      const m200 = a.ma200[a.ma200.length - 1]
      if (m200 != null && price < m200) checks.push({ tone: 'info', symbol: h.symbol, text: t(`${h.symbol} is below its 200-day average ($${m200.toFixed(2)}).`, `${h.symbol} 位于 200 日均线（$${m200.toFixed(2)}）下方。`) })
    }
    for (const date of Object.keys(cal.earnings).sort()) {
      const row = cal.earnings[date]?.find(x => x.symbol === h.symbol)
      if (!row) continue
      const d = days(date)
      if (d >= 0 && d <= r.earningsDays)
        checks.push({
          tone: 'warn',
          symbol: h.symbol,
          text: t(
            `${h.symbol} reports earnings ${d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`} (${h.weight.toFixed(1)}% of your portfolio). Prices can gap past stops on earnings.`,
            `${h.symbol} ${relativeDays('zh', d)}发布财报（占你组合的 ${h.weight.toFixed(1)}%）。财报时股价可能跳空越过止损价。`,
          ),
        })
      break
    }
  }
  for (const [name, pct] of sectors)
    if (pct > r.maxSectorPct && name !== 'Unknown')
      checks.push({ tone: 'warn', text: t(`${name} is ${pct.toFixed(1)}% of your portfolio, above your ${r.maxSectorPct}% sector limit.`, `${sectorName(name, 'zh')}${/[A-Za-z0-9]$/.test(sectorName(name, 'zh')) ? ' ' : ''}板块占你组合的 ${pct.toFixed(1)}%，超过你设的 ${r.maxSectorPct}% 板块上限。`) })
  if (totals.value > 0 && totals.openRisk > 0)
    checks.push({
      tone: 'info',
      text: t(
        `If every stop were hit, you would lose about ${usd(totals.openRisk)} (${((totals.openRisk / totals.value) * 100).toFixed(1)}% of the portfolio), plus any gap past the stops.`,
        `如果所有止损都被触发，你将亏损约 ${usd(totals.openRisk)}（占组合的 ${((totals.openRisk / totals.value) * 100).toFixed(1)}%），跳空越过止损的部分另计。`,
      ),
    })

  const order: Record<Tone, number> = { risk: 0, warn: 1, good: 2, info: 3 }

  return checks.sort((x, y) => order[x.tone] - order[y.tone])
}

export type Command =
  | { kind: 'buy'; symbol: string; shares: number; price: number; stop?: number; target?: number }
  | { kind: 'sell'; symbol: string; shares: number; price: number }
  | { kind: 'cash'; amount: number }

// The Chinese words a trade can be typed with, read as their English forms.
const ZH_WORDS: [RegExp, string][] = [
  [/^(?:买入|买)\s*/, 'buy '],
  [/^(?:卖出|卖)\s*/, 'sell '],
  [/^现金\s*/, 'cash '],
  [/\s*股(?=\s*(?:@|＠|价格|$))/g, ' '],
  [/\s*(?:＠|价格)\s*/g, ' @ '],
  [/\s*止损价?\s*/g, ' stop '],
  [/\s*目标价?\s*/g, ' target '],
]

/**
 * "NVDA 50 @ 120.5 stop 110 target 160", "buy NVDA 50 at 120.5",
 * "sell NVDA 10 @ 140" or "cash 5000"; also in Chinese, "买入 NVDA 50 @ 120.5
 * 止损 110 目标 160", "卖出 NVDA 10 @ 140" or "现金 5000".
 */
export function parseCommand(text: string): Command | undefined {
  let t = text.trim().replace(/[,，]/g, '')
  if (/[一-鿿＠]/.test(t)) for (const [re, en] of ZH_WORDS) t = t.replace(re, en).replace(/\s+/g, ' ').trim()
  const cash = /^cash\s+\$?(-?\d+(?:\.\d+)?)$/i.exec(t)
  if (cash) return { kind: 'cash', amount: Number(cash[1]) }
  const sell = /^sell\s+\$?([A-Za-z][A-Za-z0-9.\-]{0,9})\s+(\d+(?:\.\d+)?)\s*(?:@|at)\s*\$?(\d+(?:\.\d+)?)$/i.exec(t)
  if (sell) return { kind: 'sell', symbol: sell[1]!.toUpperCase(), shares: Number(sell[2]), price: Number(sell[3]) }
  const buy = /^(?:buy\s+)?\$?([A-Za-z][A-Za-z0-9.\-]{0,9})\s+(\d+(?:\.\d+)?)\s*(?:shares?\s*)?(?:@|at)\s*\$?(\d+(?:\.\d+)?)(.*)$/i.exec(t)
  if (!buy) return undefined
  const rest = buy[4] ?? ''
  const stop = /stop\s*\$?(\d+(?:\.\d+)?)/i.exec(rest)
  const target = /target\s*\$?(\d+(?:\.\d+)?)/i.exec(rest)

  return {
    kind: 'buy',
    symbol: buy[1]!.toUpperCase(),
    shares: Number(buy[2]),
    price: Number(buy[3]),
    stop: stop ? Number(stop[1]) : undefined,
    target: target ? Number(target[1]) : undefined,
  }
}

/** Applies a buy, sell or cash entry; a buy into an existing position averages the cost. */
export function applyCommand(pf: Portfolio, c: Command, today: string, lang: Lang = 'en'): { pf: Portfolio; message: string } {
  const t = (en: string, zh: string) => tr(lang, en, zh)
  if (c.kind === 'cash') return { pf: { ...pf, cash: c.amount }, message: t(`Cash set to $${c.amount.toLocaleString('en-US')}.`, `现金已设为 $${c.amount.toLocaleString('en-US')}。`) }
  const existing = pf.positions.find(p => p.symbol === c.symbol)
  if (c.kind === 'buy') {
    const trade: Trade = { date: today, symbol: c.symbol, side: 'buy', shares: c.shares, price: c.price }
    if (!existing) {
      const position: Position = { symbol: c.symbol, shares: c.shares, cost: c.price, stop: c.stop, target: c.target, opened: today }

      return { pf: { ...pf, positions: [...pf.positions, position], trades: [...pf.trades, trade] }, message: t(`Added ${c.shares} ${c.symbol} at $${c.price}.`, `已添加 ${c.shares} 股 ${c.symbol}，价格 $${c.price}。`) }
    }
    const shares = existing.shares + c.shares
    const cost = (existing.shares * existing.cost + c.shares * c.price) / shares
    const position: Position = { ...existing, shares, cost, stop: c.stop ?? existing.stop, target: c.target ?? existing.target }

    return {
      pf: { ...pf, positions: pf.positions.map(p => (p.symbol === c.symbol ? position : p)), trades: [...pf.trades, trade] },
      message: t(`Bought ${c.shares} more ${c.symbol}: now ${shares} shares at an average $${cost.toFixed(2)}.`, `加仓 ${c.shares} 股 ${c.symbol}：现持有 ${shares} 股，平均成本 $${cost.toFixed(2)}。`),
    }
  }
  if (!existing) return { pf, message: t(`You hold no ${c.symbol}.`, `你没有持有 ${c.symbol}。`) }
  const sold = Math.min(c.shares, existing.shares)
  const realized = (c.price - existing.cost) * sold
  const trade: Trade = { date: today, symbol: c.symbol, side: 'sell', shares: sold, price: c.price, realized }
  const left = existing.shares - sold
  const positions = left > 0 ? pf.positions.map(p => (p.symbol === c.symbol ? { ...p, shares: left } : p)) : pf.positions.filter(p => p.symbol !== c.symbol)

  return {
    pf: { ...pf, positions, trades: [...pf.trades, trade] },
    message: t(
      `Sold ${sold} ${c.symbol} at $${c.price}: ${realized >= 0 ? 'gain' : 'loss'} of $${Math.abs(realized).toFixed(2)}${left > 0 ? `, ${left} shares left` : ', position closed'}.`,
      `以 $${c.price} 卖出 ${sold} 股 ${c.symbol}：已实现${realized >= 0 ? '盈利' : '亏损'} $${Math.abs(realized).toFixed(2)}${left > 0 ? `，剩余 ${left} 股` : '，已清仓'}。`,
    ),
  }
}

/** Shares a trade can hold so that hitting its stop loses `riskPerTradePct` of the portfolio. */
export function sizePosition(input: string, total: number, rules: Rules, lang: Lang = 'en'): string {
  const t = (en: string, zh: string) => tr(lang, en, zh)
  let text = input.trim().replace(/,/g, '')
  if (/[一-鿿，]/.test(text))
    text = text
      .replace(/，/g, '')
      .replace(/\s*止损价?\s*/g, ' stop ')
      .replace(/\s*(?:买入价|买入|入场价|入场)\s*/g, ' entry ')
      .replace(/\s+/g, ' ')
      .trim()
  const m = /^(?:\$?([A-Za-z][A-Za-z0-9.\-]{0,9})\s+)?(?:entry\s+)?\$?(\d+(?:\.\d+)?)\s+stop\s+\$?(\d+(?:\.\d+)?)$/i.exec(text)
  if (!m) return t('Type an entry and a stop, e.g. "NVDA 180 stop 165".', '请输入买入价和止损价，例如“NVDA 180 stop 165”或“NVDA 180 止损 165”。')
  const entry = Number(m[2])
  const stop = Number(m[3])
  if (!(stop < entry)) return t('The stop has to be below the entry price.', '止损价必须低于买入价。')
  if (total <= 0) return t('Add your positions or cash first: the size is a share of your portfolio.', '请先添加持仓或现金：仓位大小按组合的比例计算。')
  const risk = (total * rules.riskPerTradePct) / 100
  const perShare = entry - stop
  const shares = Math.floor(risk / perShare)
  const value = shares * entry
  const weight = (value / total) * 100
  const label = m[1] ? `${m[1].toUpperCase()}: ` : ''
  if (lang === 'zh')
    return (
      `${m[1] ? `${m[1].toUpperCase()}：` : ''}${shares.toLocaleString('en-US')} 股（约 $${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}，占组合的 ${weight.toFixed(1)}%）。` +
      `如果触及 $${stop}，你将亏损约 $${(shares * perShare).toFixed(0)}，即你设的 ${rules.riskPerTradePct}% 单笔风险。` +
      (weight > rules.maxWeightPct ? `这超过了你设的 ${rules.maxWeightPct}% 单一持仓上限；止损放得更宽，就需要更少的股数。` : '')
    )

  return (
    `${label}${shares.toLocaleString('en-US')} shares (about $${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}, ${weight.toFixed(1)}% of the portfolio). ` +
    `If $${stop} is hit you lose about $${(shares * perShare).toFixed(0)}, your ${rules.riskPerTradePct}% risk per trade.` +
    (weight > rules.maxWeightPct ? ` That is more than your ${rules.maxWeightPct}% largest-position limit; a wider stop needs fewer shares.` : '')
  )
}
