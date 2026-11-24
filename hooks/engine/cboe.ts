// CBOE's delayed-quotes host, shared by the option chains, the volatility
// indexes and the cash index fallback.
//
// CBOE sits behind Cloudflare, which can refuse a client outright (a 403 page
// saying so) or ask it to slow down (429). Either answer is respected: no
// further request goes to CBOE for six hours, and callers use their other
// source. A plain 403 or 404 (CBOE's answer for a symbol it does not list) is
// about that symbol only.

import { getJson, HttpError, type Fetch } from './http'

export const CBOE = 'https://cdn-api.cboe.com/api/global/delayed_quotes'

const PAUSE_MS = 6 * 3600_000
let pausedUntil = 0

/** Whether CBOE refused this client, rather than one symbol. */
export function isRefusal(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false

  return e.status === 429 || (e.status === 403 && /cloudflare|you have been blocked/i.test(e.body))
}

/** When CBOE will be asked again (epoch ms), while it is paused. */
export function cboePausedUntil(now = Date.now()): number | undefined {
  return now < pausedUntil ? pausedUntil : undefined
}

/** Forget a pause (tests). */
export function resumeCboe(): void {
  pausedUntil = 0
}

/** GET a JSON document under CBOE's delayed-quotes root, e.g. '/options/SPY.json'. */
export async function cboeJson(fetch: Fetch, path: string, now = Date.now()): Promise<any> {
  if (cboePausedUntil(now) !== undefined) throw new Error('CBOE refused access earlier; not asked again yet')
  try {
    return await getJson(fetch, `${CBOE}${path}`)
  } catch (e) {
    if (isRefusal(e)) pausedUntil = now + PAUSE_MS
    throw e
  }
}
