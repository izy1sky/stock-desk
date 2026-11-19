// Shared contract of the analysis engine. Every module is pure: it takes a
// `Fetch` (or already loaded data) and returns plain values, so the tools, the
// pane and the tests all run the same code.

import type { Bar } from '../../types'
import type { Text } from '../i18n'

export type { Bar, Text }

/**
 * One measured value, with what it says, in both languages. `value` is the
 * number, a formatted figure that needs no translation ("7,431.75", "23.1%"),
 * or a Text pair when it holds words.
 */
export type Reading = {
  name: Text
  value: number | string | Text
  /** Short interpretation, e.g. "bullish stack" / "多头排列". */
  note?: Text
}

export type ModuleKey = 'trend' | 'volatility' | 'volume' | 'options' | 'futures'

/**
 * What every analysis module returns.
 *
 * `score` is a directional bias from -100 (strongly bearish) to +100 (strongly
 * bullish) for the underlying. The volatility module scores risk the same way:
 * calm or compressing volatility leans positive, stressed or expanding
 * volatility leans negative.
 */
export type ModuleResult = {
  key: ModuleKey
  score: number
  /** 0..1: how much this module's score should be trusted right now. */
  confidence: number
  /** One sentence: the module's conclusion. */
  verdict: Text
  readings: Reading[]
  /** Notable conditions worth calling out, most important first. */
  flags: Text[]
}

/** Price levels the forecast uses; nearest first in each list. */
export type Levels = {
  supports: number[]
  resistances: number[]
}

export type Bias = 'bullish' | 'lean bullish' | 'neutral' | 'lean bearish' | 'bearish'

export const clampScore = (n: number) => Math.max(-100, Math.min(100, Math.round(n)))

export function biasOf(score: number): Bias {
  if (score >= 40) return 'bullish'
  if (score >= 15) return 'lean bullish'
  if (score > -15) return 'neutral'
  if (score > -40) return 'lean bearish'

  return 'bearish'
}
