/**
 * dsh-tidewatch billing and peak/off-peak math (pure functions, shared by the host and ports).
 *
 * Peak/off-peak basis: DeepSeek's official time-of-day pricing effective 2026-08-17.
 *   Peak hours (UTC hours, half-open): 01:00–04:00 and 06:00–10:00
 *   (i.e. 09:00–12:00 and 14:00–18:00 Beijing time);
 *   every other hour is off-peak, and the off-peak price is half the peak price.
 *
 * Model pricing: DeepSeek V4.1 Flash launched 2026-09-10 12:00 Beijing time and the
 *   model name changed from deepseek-v4-flash to deepseek-flash; the legacy names
 *   deepseek-v4-flash, deepseek-v4-flash-vision-exp and deepseek-v4.1-flash all remain
 *   callable and all route to V4.1 Flash at the new price (see MODEL_ALIASES).
 *   deepseek-v4-pro pricing is unchanged.
 *
 * Price eras (three, picked by the instant of the call, for historical accuracy):
 *   1. before 2026-08-16 16:00 UTC: legacy base price (legacyBase);
 *   2. 2026-08-16 16:00 UTC ~ 2026-09-10 04:00 UTC: first peak/off-peak price
 *      (flash peak cacheMiss 0.44 / output 1.32, see priorPeak/priorOffPeak);
 *   3. from 2026-09-10 04:00 UTC: V4.1 Flash new price (peak 0.3 / 1.2).
 *
 * Billing basis: USD per 1M tokens (the official pricing page basis), cost =
 *   input × cacheMiss + output × output + (cacheRead + cacheWrite) × cacheHit
 *   (+ reasoning × reasoningPrice, when a price entry provides a reasoning price).
 *
 * The core algorithms here (isPeakHour / peakPhaseAt / tierFor / costOf and the price
 * table shape) are adapted from dsh-cost-meter (MIT License,
 * https://github.com/Han-1413141/dsh-cost-meter) and rewritten for a lean goal:
 * no configuration dependency, peak/off-peak always enabled.
 */

/** Start of the peak/off-peak era (2026-08-16 16:00 UTC): earlier calls bill at the then-current base price. */
export const LEGACY_BASE_BOUNDARY = '2026-08-16T16:00:00Z'

/**
 * V4.1 Flash repricing boundary (= 2026-09-10 12:00 Beijing, i.e. 04:00 UTC):
 * peak/off-peak calls before it bill at the first peak/off-peak price
 * (priorPeak/priorOffPeak), calls after it at the V4.1 Flash new price.
 */
export const FLASH_REPRICE_BOUNDARY = '2026-09-10T04:00:00Z'

/** Peak windows (UTC hours, half-open interval [start, end)). */
export const DEFAULT_PEAK_WINDOWS = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
]

/**
 * Built-in default DeepSeek price table (USD per 1M tokens; identical to the official
 * page figures; the base tier = the off-peak tier).
 * deepseek-flash carries the V4.1 Flash new price (effective 2026-09-10 12:00 Beijing);
 * deepseek-v4-pro is unchanged: the official pricing footnote (2) and the 2026-09-10
 * changelog both state that V4 Pro API service continues after 2026-09-14 with billing
 * unchanged until further notice (see V4_PRO_RETIRE_BOUNDARY, currently a sentinel).
 */
export const DEFAULT_PRICE_TABLE = {
  models: {
    'deepseek-flash': {
      cacheHit: 0.003,
      cacheMiss: 0.15,
      output: 0.6,
      offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
      peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
      // First peak/off-peak price (2026-08-16 16:00 UTC ~ 2026-09-10 04:00 UTC).
      priorOffPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
      priorPeak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
      // Base price before the peak/off-peak era (before 2026-08-16 16:00 UTC).
      legacyBase: { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
    },
    'deepseek-v4-pro': {
      cacheHit: 0.022,
      cacheMiss: 0.66,
      output: 1.98,
      offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
      peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
      legacyBase: { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
    },
  },
  default: {
    cacheHit: 0.003,
    cacheMiss: 0.15,
    output: 0.6,
    offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  },
}

/**
 * Model aliases: legacy / transitional model names → current real model key.
 * After the V4.1 Flash rename (launched 2026-09-10), the old names deepseek-v4-flash
 * and deepseek-v4-flash-vision-exp, plus the community's deepseek-v4.1-flash, remain
 * callable and route to V4.1 Flash at the new price (registered explicitly so nothing
 * depends on the default fallback).
 */
export const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
}

/**
 * V4 Pro repricing boundary (sentinel value = no effective date).
 *
 * Official basis (three official pages checked 2026-09-13, all consistent):
 *   - English pricing page footnote (2): V4 Pro API service continues after
 *     2026-09-14, billing method remaining unchanged;
 *   - Chinese pricing page footnote (2): billing method stays unchanged, and any
 *     change will be announced separately;
 *   - changelog entry 2026-09-10: the same statement repeated in full.
 * The older reading ("from 2026-09-14 V4 Pro bills at V4.1-Flash rates") appears only
 * in the news release page news260910 and has been superseded by those three
 * confirmations, so it is not used as a billing basis.
 *
 * Hence this boundary stays a sentinel: until the official announcement of a new date,
 * pro always bills at its own price list (offPeak / peak). When the official repricing
 * is announced, set this constant to the effective instant to restore routing; the
 * branch in priceEntryFor needs no change.
 */
export const V4_PRO_RETIRE_BOUNDARY = '9999-12-31T00:00:00Z'

/**
 * Model-name normalization: ignores case, spaces, dashes, dots and parenthesized
 * annotations; legacy names first map through MODEL_ALIASES to the current real key
 * and then look up the price table.
 * @param model - the model id from the request.
 * @param atMs - billing instant (epoch ms, optional); deepseek-v4-pro routes to the
 *   Flash price only once the repricing boundary (V4_PRO_RETIRE_BOUNDARY, currently a
 *   sentinel) has passed.
 * @returns the matching price entry; `default` when nothing matches.
 */
export function priceEntryFor(model, atMs) {
  const normalize = s => String(s ?? '').toLowerCase().replace(/[\s\-_.()（）]/g, '')
  let id = normalize(model)
  // Alias normalization: legacy model names (such as deepseek-v4-flash before the V4.1
  // Flash rename) map to the current real key so legacy names hit the new price.
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    if (id === normalize(alias)) {
      id = normalize(target)
      break
    }
  }
  // V4 Pro repricing route: bills at the Flash price only after V4_PRO_RETIRE_BOUNDARY.
  // That constant is currently a sentinel (billing officially unchanged), so this never
  // triggers and pro uses its own price list.
  if (id === normalize('deepseek-v4-pro') && Number.isFinite(atMs) && atMs >= Date.parse(V4_PRO_RETIRE_BOUNDARY)) {
    id = 'deepseekflash'
  }
  if (id.length > 0 && Object.prototype.hasOwnProperty.call(DEFAULT_PRICE_TABLE.models, id)) {
    return DEFAULT_PRICE_TABLE.models[id]
  }
  // Fallback: a request name containing a table model name also matches (e.g. a routing prefix provider/…).
  for (const [key, entry] of Object.entries(DEFAULT_PRICE_TABLE.models)) {
    if (id.includes(normalize(key))) return entry
  }
  return DEFAULT_PRICE_TABLE.default
}

/**
 * Whether an instant falls in a peak window. Official since 2026-08-23: Saturday and
 * Sunday (UTC calendar days) bill as off-peak all day with no switch; weekdays use the
 * peak windows.
 * @param atMs - instant (epoch ms).
 * @param windows - peak window array (defaults to the official windows).
 * @returns true inside a peak window; false on weekends or outside the windows.
 */
export function isPeakHour(atMs, windows = DEFAULT_PEAK_WINDOWS) {
  if (!Array.isArray(windows) || windows.length === 0) return false
  const d = new Date(atMs)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false // weekends are off-peak all day (official since 2026-08-23)
  const hour = d.getUTCHours()
  return windows.some(w => {
    const start = Number(w?.start)
    const end = Number(w?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
    if (start < end) return hour >= start && hour < end
    // Window crossing midnight (not present in this configuration; handled for compatibility).
    return hour >= start || hour < end
  })
}

/**
 * The peak/off-peak phase at an instant plus the adjacent switch instants (for the
 * countdown). Windows are half-open [start, end) in UTC hours, and midnight-crossing
 * windows (end <= start) are supported. Weekends (UTC Saturday/Sunday) have no switch:
 * the next instant is the next working day's first peak, and the collection range
 * spans -1 ~ +3 days to cover the Saturday → Monday gap.
 * @param atMs - instant (epoch ms).
 * @param windows - peak window array.
 * @returns { inPeak, prevAtMs, nextAtMs, nextIntoPeak }, or null (no valid window/instant).
 *   prevAtMs = start of the current phase, nextAtMs = the next switch instant,
 *   nextIntoPeak = whether that switch enters peak.
 */
export function peakPhaseAt(atMs, windows = DEFAULT_PEAK_WINDOWS) {
  if (!Array.isArray(windows) || windows.length === 0 || !Number.isFinite(atMs)) return null
  const hourAt = (dayOffset, hour) => {
    const date = new Date(atMs)
    date.setUTCDate(date.getUTCDate() + dayOffset)
    date.setUTCHours(hour, 0, 0, 0)
    return date.getTime()
  }
  // Collect every switch point from two days back to three days ahead so any instant
  // has both neighbours (weekends have no window points: a weekend's prev lands on
  // Friday and its next on the following Monday).
  const points = []
  for (let day = -2; day <= 3; day += 1) {
    const d = new Date(hourAt(day, 0))
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue // weekends have no peak/off-peak switch
    for (const w of windows) {
      const start = Number(w?.start)
      const end = Number(w?.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      points.push({ at: hourAt(day, start), intoPeak: true })
      // A midnight-crossing window ends on the following day.
      points.push({ at: hourAt(end <= start ? day + 1 : day, end), intoPeak: false })
    }
  }
  const inPeak = isPeakHour(atMs, windows)
  let prev = null
  let next = null
  for (const p of points) {
    if (p.at <= atMs && (prev === null || p.at > prev.at)) prev = p
    if (p.at > atMs && (next === null || p.at < next.at)) next = p
  }
  if (prev === null || next === null) return null
  return { inPeak, prevAtMs: prev.at, nextAtMs: next.at, nextIntoPeak: next.intoPeak }
}

/**
 * Pick the price tier for one usage sample by the instant of the call, across the three
 * price eras:
 *   before the peak era (before 2026-08-16 16:00 UTC) → legacyBase;
 *   first peak era (until 2026-09-10 04:00 UTC) → priorPeak / priorOffPeak (when the entry provides them);
 *   current peak era → peak / offPeak.
 * @param entry - model price record.
 * @param atMs - billing instant.
 * @returns a tier { cacheHit, cacheMiss, output, reasoning? }.
 */
export function tierFor(entry, atMs) {
  const base = entry ?? { cacheHit: 0, cacheMiss: 0, output: 0 }
  const asTier = price => price?.reasoning === undefined
    ? { cacheHit: price?.cacheHit ?? 0, cacheMiss: price?.cacheMiss ?? 0, output: price?.output ?? 0 }
    : { cacheHit: price.cacheHit, cacheMiss: price.cacheMiss, output: price.output, reasoning: price.reasoning }
  // Before the peak era: bill at the then-current base price (historical accuracy).
  if (Number.isFinite(atMs) && atMs < Date.parse(LEGACY_BASE_BOUNDARY)) {
    const lb = base.legacyBase
    return lb === undefined ? asTier(base) : asTier(lb)
  }
  const peak = isPeakHour(atMs)
  // Before the repricing boundary: bill at the first peak/off-peak price. Only applies
  // when the entry provides a prior tier; deepseek-v4-pro did not change price in that
  // window and has no prior tier, so it uses the current peak/off-peak price.
  if (Number.isFinite(atMs) && atMs < Date.parse(FLASH_REPRICE_BOUNDARY)) {
    const prior = peak ? base.priorPeak : base.priorOffPeak
    if (prior !== undefined) return asTier(prior)
  }
  if (peak) {
    const p = base.peak
    return p === undefined ? asTier(base) : asTier(p)
  }
  const off = base.offPeak
  return off === undefined ? asTier(base) : asTier(off)
}

/**
 * USD cost of one call.
 * @param tokens - { input, output, cacheRead, cacheWrite, reasoning? } token counts per bucket.
 * @param entry - model price record.
 * @param atMs - billing instant.
 * @returns the USD cost (non-negative).
 */
export function costOf(tokens, entry, atMs) {
  const tier = tierFor(entry, atMs)
  const input = Math.max(0, Number(tokens?.input) || 0)
  const output = Math.max(0, Number(tokens?.output) || 0)
  const cacheRead = Math.max(0, Number(tokens?.cacheRead) || 0)
  const cacheWrite = Math.max(0, Number(tokens?.cacheWrite) || 0)
  const reasoning = Math.max(0, Number(tokens?.reasoning) || 0)
  const reasoningPrice = typeof tier.reasoning === 'number' ? tier.reasoning : 0
  return (input * tier.cacheMiss
    + output * tier.output
    + (cacheRead + cacheWrite) * tier.cacheHit
    + reasoning * reasoningPrice) / 1e6
}
