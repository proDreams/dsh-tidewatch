/**
 * dsh-tidewatch pure-module verification (node test/verify.mjs).
 *
 * All instants are fixed sample values used only to assert the peak-window and
 * billing math; nothing depends on the real clock. The suite covers four areas:
 *   1. pricing/peak math in lib/pricing.js;
 *   2. duplicated-constant parity between lib/client.js and lib/pricing.js, so a
 *      price or window change in one file cannot drift silently;
 *   3. the client bundle's i18n layer (dictionaries, fallback chain, formatting)
 *      and its time-zone slot builder, exercised by materializing the real
 *      __ModuleLoader__ bundle against a stub React and a fake plugin context;
 *   4. a repository-wide check that no Chinese copy remains outside the Chinese
 *      dictionary).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  isPeakHour, peakPhaseAt, costOf, priceEntryFor,
  DEFAULT_PEAK_WINDOWS, DEFAULT_PRICE_TABLE, LEGACY_BASE_BOUNDARY, FLASH_REPRICE_BOUNDARY,
  V4_PRO_RETIRE_BOUNDARY, MODEL_ALIASES,
} from '../lib/pricing.js'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const libDir = join(rootDir, 'lib')

/**
 * Extract a `const <name> = ...` literal from client.js and evaluate it (every
 * extracted constant is a pure object literal). The regex spans from the
 * declaration to the next blank line; extracted literals contain no blank lines.
 */
function extractClientConst(name) {
  const src = readFileSync(join(libDir, 'client.js'), 'utf8')
  const re = new RegExp('const ' + name + ' = ([\\s\\S]*?)\\r?\\n\\r?\\n')
  const m = re.exec(src)
  assert.ok(m !== null, `constant ${name} not found in client.js`)
  // eslint-disable-next-line no-new-func
  return Function('return (' + m[1] + ')')()
}

let passed = 0
const ok = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name) }
const okAsync = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name) }

console.log('[dsh-tidewatch] verify:')

// ── Duplicated-constant parity (guards against changing a price/window in one file only) ──
ok('client PEAK_WINDOWS matches pricing DEFAULT_PEAK_WINDOWS', () => {
  assert.deepEqual(extractClientConst('PEAK_WINDOWS'), DEFAULT_PEAK_WINDOWS)
})
ok('client DISPLAY_PRICES matches pricing DEFAULT_PRICE_TABLE for every tier', () => {
  const display = extractClientConst('DISPLAY_PRICES')
  const billing = DEFAULT_PRICE_TABLE.models
  const keys = ['offPeak', 'peak']
  for (const [id, entry] of Object.entries(display)) {
    const model = Object.keys(billing).find(k => k.includes(id) || id.includes(k))
    assert.ok(model !== undefined, `client price table has a model pricing does not: ${id}`)
    for (const tier of keys) {
      assert.deepEqual(entry[tier], billing[model][tier], `model ${id} differs in tier ${tier}`)
    }
  }
  assert.deepEqual(Object.keys(display).sort(), Object.keys(billing).sort(), 'model sets differ')
})
ok('client MODEL_ALIASES matches pricing MODEL_ALIASES', () => {
  assert.deepEqual(extractClientConst('MODEL_ALIASES'), MODEL_ALIASES)
})

// ── isPeakHour (UTC peak windows 01:00-04:00 / 06:00-10:00) ──
ok('UTC 07:00 is within the peak window (06:00-10:00)', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-19T07:00:00Z')), true)
})
ok('UTC 05:00 is off-peak', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-19T05:00:00Z')), false)
})
ok('UTC 12:00 is off-peak', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-19T12:00:00Z')), false)
})
ok('UTC 01:30 is within the peak window (01:00-04:00)', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-19T01:30:00Z')), true)
})
ok('UTC 03:59 is peak (half-open interval boundary)', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-19T03:59:59Z')), true)
})
ok('UTC 04:00 is off-peak (half-open interval boundary)', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-19T04:00:00Z')), false)
})

// ── Weekend rule (official since 2026-08-23: Saturday/Sunday UTC are off-peak all day) ──
ok('Saturday 07:00 UTC (a weekday peak hour) → off-peak', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-22T07:00:00Z')), false)
})
ok('Sunday 07:00 UTC (a weekday peak hour) → off-peak', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-23T07:00:00Z')), false)
})
ok('Saturday 01:30 UTC (a weekday peak hour) → off-peak', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-22T01:30:00Z')), false)
})
ok('Monday 07:00 UTC → peak (back to the weekday window)', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-24T07:00:00Z')), true)
})
ok('Saturday 14:00 UTC phase: off-peak, next switch = Monday 01:00 into peak', () => {
  const ph = peakPhaseAt(Date.parse('2026-08-22T14:00:00Z'), DEFAULT_PEAK_WINDOWS)
  assert.equal(ph.inPeak, false)
  assert.equal(ph.nextAtMs, Date.parse('2026-08-24T01:00:00Z'))
  assert.equal(ph.nextIntoPeak, true)
})
ok('Sunday phase: off-peak, next switch = Monday 01:00 into peak', () => {
  const ph = peakPhaseAt(Date.parse('2026-08-23T08:00:00Z'), DEFAULT_PEAK_WINDOWS)
  assert.equal(ph.inPeak, false)
  assert.equal(ph.nextAtMs, Date.parse('2026-08-24T01:00:00Z'))
  assert.equal(ph.nextIntoPeak, true)
})

// ── peakPhaseAt (current phase + next switch) ──
ok('07:00 UTC phase and next switch (10:00 into off-peak)', () => {
  const ph = peakPhaseAt(Date.parse('2026-08-19T07:00:00Z'), DEFAULT_PEAK_WINDOWS)
  assert.equal(ph.inPeak, true)
  assert.equal(ph.nextAtMs, Date.parse('2026-08-19T10:00:00Z'))
  assert.equal(ph.nextIntoPeak, false)
})
ok('05:00 UTC phase and next switch (06:00 into peak)', () => {
  const ph = peakPhaseAt(Date.parse('2026-08-19T05:00:00Z'), DEFAULT_PEAK_WINDOWS)
  assert.equal(ph.inPeak, false)
  assert.equal(ph.nextAtMs, Date.parse('2026-08-19T06:00:00Z'))
  assert.equal(ph.nextIntoPeak, true)
})
ok('12:00 UTC phase and next switch (next day 01:00 into peak)', () => {
  const ph = peakPhaseAt(Date.parse('2026-08-19T12:00:00Z'), DEFAULT_PEAK_WINDOWS)
  assert.equal(ph.inPeak, false)
  assert.equal(ph.nextAtMs, Date.parse('2026-08-20T01:00:00Z'))
  assert.equal(ph.nextIntoPeak, true)
})

// ── priceEntryFor (model matching) ──
ok('deepseek-v4-flash hits the flash entry', () => {
  assert.equal(priceEntryFor('deepseek-v4-flash').offPeak.output, 0.6)
})
ok('deepseek-v4-flash-vision-exp hits the flash entry through the alias table', () => {
  assert.equal(priceEntryFor('deepseek-v4-flash-vision-exp').offPeak.output, 0.6)
})
ok('deepseek-v4.1-flash hits the flash entry through the alias table', () => {
  assert.equal(priceEntryFor('deepseek-v4.1-flash').offPeak.output, 0.6)
})
ok('deepseek-flash hits the flash entry directly', () => {
  assert.equal(priceEntryFor('deepseek-flash').offPeak.output, 0.6)
})
ok('deepseek-v4-pro hits the pro entry', () => {
  assert.equal(priceEntryFor('deepseek-v4-pro').offPeak.output, 1.98)
})
ok('pro bills at its own price before the official statement (2026-09-10)', () => {
  assert.equal(priceEntryFor('deepseek-v4-pro', Date.parse('2026-09-10T00:00:00Z')).offPeak.output, 1.98)
})
ok('pro still bills at its own price on the statement date (2026-09-14 04:00 UTC)', () => {
  assert.equal(priceEntryFor('deepseek-v4-pro', Date.parse('2026-09-14T04:00:00Z')).offPeak.output, 1.98)
})
ok('pro still bills at its own price far ahead (2027-01-01) pending official notice', () => {
  assert.equal(priceEntryFor('deepseek-v4-pro', Date.parse('2027-01-01T00:00:00Z')).offPeak.output, 1.98)
})
ok('V4_PRO_RETIRE_BOUNDARY is the sentinel value (no repricing date announced)', () => {
  assert.equal(Date.parse(V4_PRO_RETIRE_BOUNDARY), Date.UTC(9999, 11, 31))
})
ok('unknown models fall back to default (= flash price)', () => {
  assert.equal(priceEntryFor('gpt-999').offPeak.output, 0.6)
})

// ── costOf (USD per 1M tokens) ──
const flash = priceEntryFor('deepseek-flash')
const pro = priceEntryFor('deepseek-v4-pro')

// Current price (from 2026-09-10 04:00 UTC): peak 0.3/1.2, off-peak 0.15/0.6, cache hit 0.003
ok('current peak: 1M cache-miss input + 1M output = 0.3 + 1.2 = 1.5 USD', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-09-11T07:00:00Z'))
  assert.ok(Math.abs(c - 1.5) < 1e-9)
})
ok('current off-peak: 1M cache-miss input + 1M output = 0.15 + 0.6 = 0.75 USD', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-09-11T05:00:00Z'))
  assert.ok(Math.abs(c - 0.75) < 1e-9)
})
ok('cache reads/writes bill at the cache-hit price (current 0.003)', () => {
  const c = costOf({ input: 0, output: 0, cacheRead: 1e6, cacheWrite: 0 }, flash, Date.parse('2026-09-11T05:00:00Z'))
  assert.ok(Math.abs(c - 0.003) < 1e-9)
})

// ── First peak/off-peak price era (2026-08-16 16:00 UTC ~ 2026-09-10 04:00 UTC, historical accuracy) ──
ok('first era peak: 1M cache-miss input + 1M output = 0.44 + 1.32 = 1.76 USD', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-08-19T07:00:00Z'))
  assert.ok(Math.abs(c - 1.76) < 1e-9)
})
ok('first era off-peak: 1M cache-miss input + 1M output = 0.22 + 0.66 = 0.88 USD', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-08-19T05:00:00Z'))
  assert.ok(Math.abs(c - 0.88) < 1e-9)
})
ok('the instant before repricing (2026-09-10 03:59:59 UTC, peak) still bills 1.76', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-09-10T03:59:59Z'))
  assert.ok(Math.abs(c - 1.76) < 1e-9)
})
ok('from the repricing instant (2026-09-10 04:00:00 UTC, off-peak) the new off-peak price 0.75 applies', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-09-10T04:00:00Z'))
  assert.ok(Math.abs(c - 0.75) < 1e-9)
})
ok('FLASH_REPRICE_BOUNDARY = Beijing 2026-09-10 12:00', () => {
  assert.equal(Date.parse(FLASH_REPRICE_BOUNDARY), Date.parse('2026-09-10T04:00:00Z'))
})
ok('pro has no prior tier in the first peak era and keeps its current price (peak 1.32 + 3.96 = 5.28)', () => {
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, pro, Date.parse('2026-08-19T07:00:00Z'))
  assert.ok(Math.abs(c - 5.28) < 1e-9)
})

ok('before the peak era (2026-08-10) billing uses legacyBase', () => {
  assert.ok(Date.parse('2026-08-10T00:00:00Z') < Date.parse(LEGACY_BASE_BOUNDARY))
  const c = costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-08-10T00:00:00Z'))
  assert.ok(Math.abs(c - 0.14) < 1e-9)
})
ok('negative tokens are clamped to zero', () => {
  const c = costOf({ input: -5, output: -1, cacheRead: 0, cacheWrite: 0 }, flash, Date.parse('2026-09-11T05:00:00Z'))
  assert.equal(c, 0)
})

// ── Client bundle harness ────────────────────────────────────────────────
// client.js is a hand-written __ModuleLoader__ bundle with no exports of its own,
// so the suite materializes the real factory against a stub React and the local
// (non-primitive) code path. That exercises the shipped dictionaries, translators
// and time-zone helpers instead of a copy of them.

let loaderConfig = null
globalThis.window = {
  __ModuleLoader__: {
    load(config) { loaderConfig = config },
  },
}
await import(pathToFileURL(join(libDir, 'client.js')).href)
assert.ok(loaderConfig !== null, 'client.js did not register itself through __ModuleLoader__.load')
assert.equal(loaderConfig.id, 'dsh-tidewatch')

const reactStub = {
  createElement: () => null,
  cloneElement: () => null,
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: fn => fn,
}
/** Stub require: React resolves; the UI primitives package is absent on purpose (fallback path). */
const requireStub = spec => {
  if (spec === 'react') return reactStub
  throw new Error('unexpected require in the test harness: ' + spec)
}
const client = loaderConfig.factory(requireStub)
const I = client.__internal
assert.ok(I !== undefined, 'client bundle does not expose __internal test hooks')

/** Fake plugin context: records locale/slot registrations and runs effects eagerly. */
function makeFakeEnv({ withLocale = true } = {}) {
  const registered = []
  const languages = []
  const slots = []
  const locale = {
    getLocale: () => ({ active: 'en', locales: [{ id: 'zh' }, { id: 'en' }], revision: 1 }),
    bind: ns => (key, params) => I.translateIn('en', key, params),
    register(ns, localeOrDicts, dict) {
      if (typeof localeOrDicts === 'string') registered.push({ ns, locale: localeOrDicts, dict })
      else for (const [id, entries] of Object.entries(localeOrDicts)) registered.push({ ns, locale: id, dict: entries })
      return () => {}
    },
    addLanguage(input) { languages.push(input); return () => {} },
    subscribe: () => () => {},
  }
  const slotsService = {
    inject(_name, factory) { factory() },
    register(spec, component) { slots.push({ spec, component }); return () => {} },
  }
  const ctx = {
    remote: { $mount: async () => () => {} },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    get(name) {
      if (name === 'locale') return withLocale ? locale : undefined
      if (name === 'slots') return slotsService
      return undefined
    },
    inject(deps, callback) {
      if (withLocale) return // services already present: the eager branch ran
      if (deps.includes('locale')) callback({ locale, effect: ctx.effect })
    },
  }
  return { ctx, registered, languages, slots, locale }
}

// ── Dictionaries ──
const dictIds = Object.keys(I.DICTS)
ok('the plugin ships zh, en and ru dictionaries', () => {
  assert.deepEqual(dictIds.sort(), ['en', 'ru', 'zh'])
})
ok('every dictionary carries exactly the same key set', () => {
  const reference = Object.keys(I.DICTS.en).sort()
  assert.ok(reference.length > 0, 'the en dictionary is empty')
  for (const id of dictIds) {
    assert.deepEqual(Object.keys(I.DICTS[id]).sort(), reference, `dictionary ${id} differs in its key set`)
  }
})
ok('en and ru dictionaries contain no Chinese characters', () => {
  const cjk = /[\u4e00-\u9fff]/
  for (const id of ['en', 'ru']) {
    for (const [key, value] of Object.entries(I.DICTS[id])) {
      assert.ok(!cjk.test(value), `dictionary ${id} key ${key} still contains Chinese: ${value}`)
    }
  }
})
ok('every key is a non-empty string in every language', () => {
  for (const id of dictIds) {
    for (const [key, value] of Object.entries(I.DICTS[id])) {
      assert.equal(typeof value, 'string', `dictionary ${id} key ${key} is not a string`)
      assert.ok(value.trim().length > 0, `dictionary ${id} key ${key} is empty`)
    }
  }
})

// ── Translation: lookup, fallback chain, interpolation ──
ok('translateIn resolves each shipped language', () => {
  assert.equal(I.translateIn('en', 'phase.peak'), 'Peak')
  assert.equal(I.translateIn('ru', 'phase.peak'), 'Пик')
  assert.equal(I.translateIn('zh', 'phase.peak'), '\u5cf0\u671f')
})
ok('translateIn falls back to English for a language without a dictionary', () => {
  assert.equal(I.translateIn('de', 'phase.peak'), 'Peak')
  assert.equal(I.translateIn('de', 'cost.title'), I.DICTS.en['cost.title'])
})
ok('translateIn normalizes regional tags (ru-RU, zh-Hans, EN)', () => {
  assert.equal(I.translateIn('ru-RU', 'phase.peak'), 'Пик')
  assert.equal(I.translateIn('zh-Hans', 'phase.peak'), '\u5cf0\u671f')
  assert.equal(I.translateIn('EN', 'phase.peak'), 'Peak')
})
ok('translateIn substitutes {placeholders}', () => {
  assert.equal(I.translateIn('en', 'countdown.toPeak', { time: '01:23' }), 'to peak · 01:23')
  assert.equal(I.translateIn('ru', 'countdown.toPeak', { time: '01:23' }), 'до пика · 01:23')
  assert.equal(I.translateIn('en', 'cost.modelRow', { input: '1.5M', output: '12K' }), 'in 1.5M · out 12K')
})
ok('translateIn keeps unknown keys and unknown placeholders intact', () => {
  assert.equal(I.translateIn('en', 'no.such.key'), 'no.such.key')
  assert.equal(I.translateIn('en', 'countdown.toPeak', { other: 'x' }), 'to peak · {time}')
})
ok('normalizeLocaleId and localeTagFor handle tags and unknown ids', () => {
  assert.equal(I.normalizeLocaleId('ru-RU'), 'ru')
  assert.equal(I.normalizeLocaleId(''), 'en')
  assert.equal(I.normalizeLocaleId(undefined), 'en')
  assert.equal(I.localeTagFor('zh'), 'zh-CN')
  assert.equal(I.localeTagFor('ru'), 'ru-RU')
  assert.equal(I.localeTagFor('en'), 'en')
  assert.equal(I.localeTagFor('de-AT'), 'de')
})

// ── Locale-aware formatting ──
ok('fmtMoney formats USD at 4 decimals and CNY at the fixed rate', () => {
  assert.ok(I.fmtMoney(1, 'usd', 'en').includes('1.0000'))
  assert.ok(I.fmtMoney(1, 'usd', 'en').includes('$'))
  assert.ok(I.fmtMoney(1, 'cny', 'zh').includes('6.67'))
  assert.ok(I.fmtMoney(1, 'cny', 'en').includes('¥'))
})
ok('fmtMoney follows the locale number format (Russian decimal comma)', () => {
  assert.ok(I.fmtMoney(1, 'cny', 'ru').includes('6,67'), I.fmtMoney(1, 'cny', 'ru'))
  assert.ok(I.fmtMoney(1, 'usd', 'ru').includes('1,0000'), I.fmtMoney(1, 'usd', 'ru'))
})
ok('fmtTokens uses locale compact notation', () => {
  assert.equal(I.fmtTokens(1500000, 'en'), '1.5M')
  assert.ok(I.fmtTokens(1500000, 'zh').includes('150'), I.fmtTokens(1500000, 'zh'))
  assert.ok(I.fmtTokens(1500000, 'ru').includes('млн'), I.fmtTokens(1500000, 'ru'))
  assert.equal(I.fmtTokens(999, 'en'), '999')
  assert.equal(I.fmtTokens(-10, 'en'), '0')
})
ok('countdowns are zero-padded and split hh:mm:ss / hh:mm', () => {
  assert.equal(I.fmtCountdown(3723000, 'en'), '01:02:03')
  assert.equal(I.fmtCountdownShort(3720000, 'en'), '01:02')
  // 59:59.x rounds up to the next whole minute rather than producing "00:60".
  assert.equal(I.fmtCountdownShort(3599999, 'en'), '01:00')
  assert.equal(I.fmtCountdown(0, 'en'), '00:00:00')
})

// ── Time-zone helpers and the local window table ──
function wall(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms))
}
/** Compact shape of the schedule in a zone, with the day end read as 24:00. */
function slotShape(schedule, timeZone) {
  return schedule.segments
    .map(seg => wall(seg.start, timeZone) + '-' + (seg.end === schedule.dayEnd ? '24:00' : wall(seg.end, timeZone)) + ':' + (seg.peak ? 'peak' : 'off'))
    .join(' | ')
}

ok('tzOffsetMs is DST-aware', () => {
  assert.equal(I.tzOffsetMs(Date.parse('2026-01-15T12:00:00Z'), 'Europe/Moscow'), 3 * 3600 * 1000)
  assert.equal(I.tzOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'Europe/Moscow'), 3 * 3600 * 1000)
  assert.equal(I.tzOffsetMs(Date.parse('2026-01-15T12:00:00Z'), 'America/Los_Angeles'), -8 * 3600 * 1000)
  assert.equal(I.tzOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'America/Los_Angeles'), -7 * 3600 * 1000)
  assert.equal(I.tzOffsetMs(Date.parse('2026-01-15T12:00:00Z'), 'UTC'), 0)
})
ok('localDayBounds returns the local midnight for a zone', () => {
  const utc = I.localDayBounds(Date.parse('2026-09-11T12:00:00Z'), 'UTC')
  assert.equal(utc.start, Date.parse('2026-09-11T00:00:00Z'))
  assert.equal(utc.end - utc.start, 86400000)
  const moscow = I.localDayBounds(Date.parse('2026-09-11T12:00:00Z'), 'Europe/Moscow')
  assert.equal(moscow.start, Date.parse('2026-09-10T21:00:00Z'))
})
ok('UTC weekday table = the raw peak windows', () => {
  const schedule = I.buildLocalSlots(Date.parse('2026-09-11T12:00:00Z'), 'UTC')
  assert.equal(slotShape(schedule, 'UTC'),
    '00:00-01:00:off | 01:00-04:00:peak | 04:00-06:00:off | 06:00-10:00:peak | 10:00-24:00:off')
})
ok('Asia/Shanghai table reproduces the former hard-coded Beijing slots', () => {
  const schedule = I.buildLocalSlots(Date.parse('2026-09-11T12:00:00Z'), 'Asia/Shanghai')
  assert.equal(slotShape(schedule, 'Asia/Shanghai'),
    '00:00-09:00:off | 09:00-12:00:peak | 12:00-14:00:off | 14:00-18:00:peak | 18:00-24:00:off')
})
ok('Europe/Moscow table shifts the windows into local time', () => {
  const schedule = I.buildLocalSlots(Date.parse('2026-09-11T12:00:00Z'), 'Europe/Moscow')
  assert.equal(slotShape(schedule, 'Europe/Moscow'),
    '00:00-04:00:off | 04:00-07:00:peak | 07:00-09:00:off | 09:00-13:00:peak | 13:00-24:00:off')
})
ok('a day whose first instant is already in peak keeps that phase', () => {
  const schedule = I.buildLocalSlots(Date.parse('2026-01-15T20:00:00Z'), 'America/Los_Angeles')
  assert.equal(slotShape(schedule, 'America/Los_Angeles'),
    '00:00-02:00:peak | 02:00-17:00:off | 17:00-20:00:peak | 20:00-22:00:off | 22:00-24:00:peak')
})
ok('a UTC weekend day collapses to a single off-peak row', () => {
  const schedule = I.buildLocalSlots(Date.parse('2026-09-12T12:00:00Z'), 'UTC')
  assert.equal(slotShape(schedule, 'UTC'), '00:00-24:00:off')
  assert.equal(schedule.segments.length, 1)
})
ok('a local Saturday in Asia/Shanghai is off-peak all day', () => {
  const schedule = I.buildLocalSlots(Date.parse('2026-09-12T12:00:00Z'), 'Asia/Shanghai')
  assert.equal(slotShape(schedule, 'Asia/Shanghai'), '00:00-24:00:off')
})
ok('segments tile the whole day without gaps or overlaps', () => {
  for (const zone of ['UTC', 'Asia/Shanghai', 'Europe/Moscow', 'America/Los_Angeles', 'Asia/Kathmandu']) {
    for (const at of ['2026-09-11T12:00:00Z', '2026-09-12T12:00:00Z', '2026-01-15T20:00:00Z', '2026-07-15T20:00:00Z']) {
      const schedule = I.buildLocalSlots(Date.parse(at), zone)
      assert.equal(schedule.segments[0].start, schedule.dayStart, `${zone} @ ${at}: first segment does not start at the day bound`)
      assert.equal(schedule.segments[schedule.segments.length - 1].end, schedule.dayEnd, `${zone} @ ${at}: last segment does not end at the day bound`)
      for (let i = 1; i < schedule.segments.length; i += 1) {
        assert.equal(schedule.segments[i].start, schedule.segments[i - 1].end, `${zone} @ ${at}: gap or overlap at segment ${i}`)
        assert.notEqual(schedule.segments[i].peak, schedule.segments[i - 1].peak, `${zone} @ ${at}: adjacent segments share a phase`)
      }
    }
  }
})
ok('nextPhase reports the current phase bounds for the tide line', () => {
  const offpeak = I.nextPhase(Date.parse('2026-09-11T05:00:00Z'))
  assert.equal(offpeak.inPeak, false)
  assert.equal(offpeak.prevAtMs, Date.parse('2026-09-11T04:00:00Z'))
  assert.equal(offpeak.nextAtMs, Date.parse('2026-09-11T06:00:00Z'))
  assert.equal(offpeak.nextIntoPeak, true)
  const peak = I.nextPhase(Date.parse('2026-09-11T07:00:00Z'))
  assert.equal(peak.inPeak, true)
  assert.equal(peak.prevAtMs, Date.parse('2026-09-11T06:00:00Z'))
  assert.equal(peak.nextAtMs, Date.parse('2026-09-11T10:00:00Z'))
  assert.equal(peak.nextIntoPeak, false)
})
ok('nextPhase spans a weekend from Friday off-peak to Monday peak', () => {
  const weekend = I.nextPhase(Date.parse('2026-09-12T12:00:00Z'))
  assert.equal(weekend.inPeak, false)
  assert.equal(weekend.prevAtMs, Date.parse('2026-09-11T10:00:00Z'))
  assert.equal(weekend.nextAtMs, Date.parse('2026-09-14T01:00:00Z'))
  assert.ok(weekend.nextAtMs > weekend.prevAtMs)
})
ok('panelHeightBudget tracks the space above the chip and clamps it', () => {
  // 583px-tall viewport (a phone), chip offset 96px, chip 28px tall → 439px of room.
  assert.equal(I.panelHeightBudget(583, 96, 28), 439)
  // Never collapses below a legible minimum, never grows without bound.
  assert.equal(I.panelHeightBudget(300, 96, 28), 220)
  assert.equal(I.panelHeightBudget(2000, 100, 28), 620)
  assert.ok(I.panelHeightBudget(0, 500, 40) >= 220)
})
ok('fmtClock/fmtClockEnd read the zone wall clock and the localized 24:00', () => {
  const at = Date.parse('2026-09-11T04:00:00Z')
  assert.equal(I.fmtClock(at, 'Europe/Moscow', 'en'), '07:00')
  assert.equal(I.fmtClock(at, 'UTC', 'en'), '04:00')
  const bounds = I.localDayBounds(at, 'UTC')
  assert.equal(I.fmtClockEnd(bounds.end, bounds.end, 'UTC', 'en'), '24:00')
})

// ── apply(): locale registration and slot wiring ──
await okAsync('apply registers zh/en/ru dictionaries and offers the ru language pack', async () => {
  const env = makeFakeEnv({ withLocale: true })
  await client.apply(env.ctx)
  assert.deepEqual(env.registered.map(r => r.locale).sort(), ['en', 'ru', 'zh'])
  for (const entry of env.registered) {
    assert.equal(entry.ns, I.NS)
    assert.deepEqual(entry.dict, I.DICTS[entry.locale], `registered ${entry.locale} dictionary is not the shipped one`)
  }
  assert.deepEqual(env.languages, [I.LANGUAGE_PACK])
  assert.deepEqual(I.LANGUAGE_PACK, { id: 'ru', label: 'Русский', fallback: 'en' })
})
await okAsync('apply declares the locale namespace on the badge slot when the locale service exists', async () => {
  const env = makeFakeEnv({ withLocale: true })
  await client.apply(env.ctx)
  const badge = env.slots.find(s => s.spec.name === 'shell.overlay')
  const probe = env.slots.find(s => s.spec.name === 'conversation.composer.dock')
  assert.ok(badge !== undefined && probe !== undefined, 'both slots must be registered')
  assert.equal(badge.spec.locale, I.NS)
  assert.equal(probe.spec.locale, undefined)
  assert.equal(typeof badge.component, 'function')
  assert.equal(typeof probe.component, 'function')
})
await okAsync('apply still registers dictionaries through optional injection without a locale service', async () => {
  const env = makeFakeEnv({ withLocale: false })
  await client.apply(env.ctx)
  assert.deepEqual(env.registered.map(r => r.locale).sort(), ['en', 'ru', 'zh'])
  assert.deepEqual(env.languages, [I.LANGUAGE_PACK])
  const badge = env.slots.find(s => s.spec.name === 'shell.overlay')
  // No locale face: declaring a namespace would make slot assembly throw, so it must be omitted.
  assert.equal(badge.spec.locale, undefined)
})

// ── Bridge ownership (the sessions list publishes no `current`) ──────────────
ok('the card never selects a `current` field off the sessions snapshot', () => {
  // Regression guard: on shells whose sessions-list snapshot carries no `current`
  // this selection is always undefined, the ownership check never matches the
  // probe's real session id, and the displayed cost is pinned to 0.
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.ok(
    !/useSessions\(s\s*=>\s*s\.current\)/.test(source),
    'client.js must not select `s.current` from the sessions list',
  )
  assert.ok(source.includes('useSessions(sessionListCurrentId)'), 'the card must resolve its owner through sessionListCurrentId')
})

ok('bridge ownership resolves the session the main view retains', () => {
  const snapshot = {
    ids: ['session-a', 'session-b'],
    byId: {
      'session-a': { sessionId: 'session-a', retainedBy: { mainView: 0 } },
      'session-b': { sessionId: 'session-b', retainedBy: { mainView: 1 } },
    },
    phase: 'ready',
    projectionsBySession: {},
  }
  assert.equal(I.sessionListCurrentId(snapshot), 'session-b')
})

ok('bridge ownership reports "unknown" instead of a false owner', () => {
  // The shell snapshot is { ids, byId, phase, projectionsBySession }: an empty
  // list, an absent snapshot and a released main view must all read as unknown so
  // the card can trust the probe rather than discard every value.
  assert.equal(I.sessionListCurrentId({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} }), undefined)
  assert.equal(I.sessionListCurrentId(undefined), undefined)
  assert.equal(I.sessionListCurrentId({ ids: ['session-a'], byId: { 'session-a': { sessionId: 'session-a' } } }), undefined)
})

// ── No Chinese copy outside the Chinese dictionary ──
ok('no Chinese remains in the code, metadata, docs or scripts', () => {
  const cjk = /[\u4e00-\u9fff]/
  const clientSrc = readFileSync(join(libDir, 'client.js'), 'utf8')
    // The zh dictionary is the Chinese column of the locale table and must keep Chinese.
    .replace(/const zh = \{[\s\S]*?\n    \}\n/, '')
  const scanned = [
    { path: 'lib/client.js', text: clientSrc },
    { path: 'lib/index.js', text: readFileSync(join(libDir, 'index.js'), 'utf8') },
    { path: 'lib/pricing.js', text: readFileSync(join(libDir, 'pricing.js'), 'utf8') },
    { path: 'docs/PORTING.md', text: readFileSync(join(rootDir, 'docs', 'PORTING.md'), 'utf8') },
    { path: 'README.md', text: readFileSync(join(rootDir, 'README.md'), 'utf8') },
    { path: 'README-RU.md', text: readFileSync(join(rootDir, 'README-RU.md'), 'utf8') },
    { path: 'CHANGELOG.md', text: readFileSync(join(rootDir, 'CHANGELOG.md'), 'utf8') },
    { path: 'scripts/build.sh', text: readFileSync(join(rootDir, 'scripts/build.sh'), 'utf8') },
    { path: 'package.json', text: readFileSync(join(rootDir, 'package.json'), 'utf8') },
    { path: 'test/verify.mjs', text: readFileSync(join(rootDir, 'test', 'verify.mjs'), 'utf8') },
    { path: 'cordis.patch.yml', text: readFileSync(join(rootDir, 'cordis.patch.yml'), 'utf8') },
  ]
  for (const file of scanned) {
    const line = file.text.split('\n').findIndex(l => cjk.test(l))
    assert.equal(line, -1, `${file.path}:${line + 1} still contains Chinese: ${file.text.split('\n')[line]}`)
  }
})

console.log(`[dsh-tidewatch] verify: ${passed} passed`)
