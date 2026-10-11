/**
 * dsh-tidewatch browser bundle (single file, materialized through __ModuleLoader__).
 *
 * Renders a "peak / off-peak tide gauge": fixed to the right of the composer and
 * vertically centered on the composer card (self-contained anchor measurement, no
 * cross-plugin coupling); when a narrow window has no room it moves above the
 * composer and never covers it or the official stats bar below.
 *
 *  - Collapsed chip: state dot + phase (amber = peak / green = off-peak) +
 *    countdown to the next switch (hours:minutes; the panel adds seconds) + this
 *    session's cost in the selected currency;
 *  - Panel: the phase and a full countdown header over a "tide line" showing how
 *    much of the current phase has elapsed, the peak/off-peak window table in the
 *    viewer's own time zone, the active tier's rates, the token breakdown
 *    (input/cache/output/reasoning), the session cost with a per-model breakdown,
 *    and a currency switch.
 *
 * Visual direction: a harbor tide gauge. One saturated accent carries the phase;
 * labels are micro-caps, and every figure uses the shell's mono stack with tabular
 * numerals so the panel reads like an instrument rather than a generic card. The
 * panel surface is elevated glass from --dsw-alias-bg-layer-2 (never the flat
 * --dsw-alias-bg-overlay slab), with a scheme-aware fallback for hosts that ship no
 * theme layer. See the `css` block below for the token contract.
 *
 * Architecture: a two-component data bridge —
 *  - Probe (session-scoped slot conversation.composer.dock, renders null):
 *    subscribes to the session projection via useProjection('costUsage') and
 *    writes it into the module-level bridge store;
 *  - TideCard (root-level slot shell.overlay): subscribes to the bridge and
 *    renders the floating badge.
 *  (The root-level slot has no useProjection seat, hence the bridge.)
 *
 * Internationalization: every user-visible string lives in the `tidewatch`
 * locale namespace (zh/en/ru dictionaries below). On shells that provide the
 * `locale` service the plugin registers its dictionaries, offers Russian as a
 * selectable language, and reads copy through the framework `t` seat (so a
 * language switch re-renders immediately). On shells without that service it
 * falls back to a local lookup keyed by the browser language, so the card is
 * never hard-coded to one language. Formatting (money, tokens, clock times) goes
 * through Intl with the active locale, and the window table is rendered in the
 * viewer's IANA time zone while the peak/off-peak decision itself stays UTC.
 *
 * Pricing and display: the backend bills in USD; the client converts to CNY at
 * the fixed rate 6.67 (the implied rate between the official CNY and USD price
 * lists, adjusted 2026-09-10 with the V4.1 Flash price change). The default
 * currency follows the interface language (zh => CNY, otherwise USD) and an
 * explicit user choice is persisted in localStorage and only affects display.
 * All styles use --dsw-* theme variables and follow the global light/dark theme.
 * Peak windows and the price table are kept in sync with lib/pricing.js
 * (official 2026-08-17 peak/off-peak pricing; 2026-09-10 V4.1 Flash price,
 * legacy names routed to the new price by the alias table).
 */

window.__ModuleLoader__.load({
  id: 'dsh-tidewatch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useCallback, useState, useEffect, useRef } = React
    const el = React.createElement

    // ── Official UI primitives (baseline modules shared by the web shell) ────
    // @deepseek-ai/dsh-client-ui-primitives is statically loaded by the web shell
    // and frozen into the module table, so a plugin require resolves to the same
    // instance (no second React copy, no dependency declaration needed). Older
    // shells lack that entry and the require throws; in that case the whole file
    // falls back to its own styles and logic and the plugin keeps working —
    // adopting the primitives never narrows compatibility.
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch { /* older shell without shared primitives: use the local implementation below */ }
    const PrimStateDot = primitives !== null && typeof primitives.StateDot === 'function' ? primitives.StateDot : null
    const PrimTag = primitives !== null && typeof primitives.Tag === 'function' ? primitives.Tag : null
    const PrimTooltip = primitives !== null && typeof primitives.Tooltip === 'function' ? primitives.Tooltip : null
    const primDismiss = primitives !== null && typeof primitives.useDismissOnOutsidePointer === 'function'
      ? primitives.useDismissOnOutsidePointer
      : null

    /**
     * State dot: official StateDot (peak = warning amber / off-peak = done green,
     * already aria-hidden); falls back to a local span.tw-dot without the primitive.
     */
    function PhaseDot({ inPeak, size }) {
      if (PrimStateDot !== null) return el(PrimStateDot, { state: inPeak ? 'warning' : 'done', size })
      return el('span', { className: 'tw-dot' })
    }

    /**
     * Read-only capsule tag: official Tag (peak = warning / off-peak = success /
     * model = outline); falls back to the local style classes without the primitive.
     */
    function PhaseTag({ tone, fallbackClass, children }) {
      if (PrimTag !== null) return el(PrimTag, { tone }, children)
      return el('span', { className: fallbackClass }, children)
    }

    /**
     * Hover hint: official Tooltip (clones the anchor, bubble adapts to the
     * viewport); without the primitive the anchor gets a native title instead.
     */
    function Tip({ label, node }) {
      if (PrimTooltip !== null) return el(PrimTooltip, { label, side: 'top' }, node)
      return React.cloneElement(node, { title: label })
    }

    /** Outside-pointer dismissal: same-signature local implementation (mousedown + contains). */
    function useFallbackDismiss(root, open, setOpen) {
      useEffect(() => {
        if (!open) return
        const onDown = e => {
          if (root.current !== null && !root.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [root, open, setOpen])
    }
    const useDismissOutside = primDismiss !== null ? primDismiss : useFallbackDismiss

    // ── Locale namespace and dictionaries ────────────────────────────────────
    // One namespace per plugin. `zh` is not "the" language of this plugin: it is
    // simply the Chinese column of the table, used only when the interface is
    // Chinese. New languages are added by appending a dictionary with the same
    // key set (verified by test/verify.mjs).

    /** Dictionary namespace owned by this plugin. */
    const NS = 'tidewatch'

    /** Simplified Chinese dictionary. */
    const zh = {
      'phase.peak': '峰期',
      'phase.offpeak': '谷期',
      'phase.peakActive': '峰期进行中',
      'phase.offpeakActive': '谷期进行中',
      'countdown.toPeak': '距峰期 {time}',
      'countdown.toOffpeak': '距谷期 {time}',
      'countdown.labelPeak': '距峰期',
      'countdown.labelOffpeak': '距谷期',
      'a11y.phaseProgress': '阶段进度：已过 {percent}%',
      'chip.tip': '点击展开 / 收起峰谷详情',
      'panel.slotsTitle': '官方峰谷时段',
      'panel.slotsLocal': '本地时间（{tz}）',
      'panel.slotsWeekendNote': '周六/周日（UTC）全天谷期',
      'slot.now': '现在',
      'slot.peak': '峰',
      'slot.offpeak': '谷',
      'panel.rateTitle': '当前档位',
      'panel.rateMeta': '{model} · {tier}',
      'tier.peak': '峰时',
      'tier.offpeak': '谷时',
      'price.input': '输入 · 未命中 / 缓存',
      'price.output': '输出',
      'price.perMillion': '/百万',
      'tokens.title': '本次会话 Token',
      'tokens.empty': '会话尚无模型调用',
      'tokens.input': '输入',
      'tokens.cache': '缓存(读+写)',
      'tokens.output': '输出（含推理）',
      'tokens.reasoning': '其中推理',
      'cost.title': '本次会话费用',
      'cost.modelRow': '输入 {input} · 输出 {output}',
      'cost.tip': '点击展开 / 收起分模型花费',
      'currency.label': '币种',
      'currency.cny': '¥ 人民币',
      'currency.usd': '$ 美元',
    }

    /** English dictionary (the fallback language of the locale chain). */
    const en = {
      'phase.peak': 'Peak',
      'phase.offpeak': 'Off-peak',
      'phase.peakActive': 'Peak hours in effect',
      'phase.offpeakActive': 'Off-peak hours in effect',
      'countdown.toPeak': 'to peak · {time}',
      'countdown.toOffpeak': 'until off-peak · {time}',
      'countdown.labelPeak': 'until peak',
      'countdown.labelOffpeak': 'until off-peak',
      'a11y.phaseProgress': 'Phase progress: {percent}% elapsed',
      'chip.tip': 'Click to expand or collapse peak details',
      'panel.slotsTitle': 'Peak & off-peak windows',
      'panel.slotsLocal': 'local time ({tz})',
      'panel.slotsWeekendNote': 'Weekends (UTC) are off-peak all day',
      'slot.now': 'now',
      'slot.peak': 'Peak',
      'slot.offpeak': 'Off',
      'panel.rateTitle': 'Rate',
      'panel.rateMeta': '{model} · {tier}',
      'tier.peak': 'peak',
      'tier.offpeak': 'off-peak',
      'price.input': 'Input · miss / cached',
      'price.output': 'Output',
      'price.perMillion': '/1M',
      'tokens.title': 'Session tokens',
      'tokens.empty': 'No model calls in this session yet',
      'tokens.input': 'Input',
      'tokens.cache': 'Cache (read + write)',
      'tokens.output': 'Output (incl. reasoning)',
      'tokens.reasoning': 'of which reasoning',
      'cost.title': 'Session cost',
      'cost.modelRow': 'in {input} · out {output}',
      'cost.tip': 'Click to expand or collapse per-model cost',
      'currency.label': 'Currency',
      'currency.cny': '¥ CNY',
      'currency.usd': '$ USD',
    }

    /** Russian dictionary (registered as a selectable language, falling back to English). */
    const ru = {
      'phase.peak': 'Пик',
      'phase.offpeak': 'Вне пика',
      'phase.peakActive': 'Пиковый период',
      'phase.offpeakActive': 'Непиковый период',
      'countdown.toPeak': 'до пика · {time}',
      'countdown.toOffpeak': 'до конца пика · {time}',
      'countdown.labelPeak': 'до пика',
      'countdown.labelOffpeak': 'до конца пика',
      'a11y.phaseProgress': 'Прогресс фазы: прошло {percent}%',
      'chip.tip': 'Нажмите, чтобы развернуть или свернуть подробности о пике',
      'panel.slotsTitle': 'Окна пика и непика',
      'panel.slotsLocal': 'местное время ({tz})',
      'panel.slotsWeekendNote': 'Выходные (UTC) — вне пика весь день',
      'slot.now': 'сейчас',
      'slot.peak': 'Пик',
      'slot.offpeak': 'Вне',
      'panel.rateTitle': 'Тариф',
      'panel.rateMeta': '{model} · {tier}',
      'tier.peak': 'пик',
      'tier.offpeak': 'непик',
      'price.input': 'Ввод · промах / кэш',
      'price.output': 'Вывод',
      'price.perMillion': '/1M',
      'tokens.title': 'Токены сессии',
      'tokens.empty': 'В этой сессии ещё не было вызовов модели',
      'tokens.input': 'Ввод',
      'tokens.cache': 'Кэш (чтение + запись)',
      'tokens.output': 'Вывод (вкл. рассуждения)',
      'tokens.reasoning': 'из них рассуждения',
      'cost.title': 'Стоимость сессии',
      'cost.modelRow': 'ввод {input} · вывод {output}',
      'cost.tip': 'Нажмите, чтобы развернуть или свернуть расходы по моделям',
      'currency.label': 'Валюта',
      'currency.cny': '¥ юань',
      'currency.usd': '$ доллар',
    }

    /** Shipped dictionaries by language id; the test suite enforces identical key sets. */
    const DICTS = { zh, en, ru }

    /**
     * Language pack offered to the shared catalog. Russian ships its own
     * dictionary here, so adding the language makes the whole card Russian; every
     * other namespace resolves through the declared `en` fallback.
     */
    const LANGUAGE_PACK = { id: 'ru', label: 'Русский', fallback: 'en' }

    /** BCP 47 tags handed to Intl for each shipped language. */
    const LOCALE_TAGS = { zh: 'zh-CN', en: 'en', ru: 'ru-RU' }

    // ── Locale service binding, lookup chain and fallback translator ─────────

    /** Locale service captured at apply time; null when the shell has none. */
    let localeService = null
    /** Framework-bound translator for this namespace; null without the locale service. */
    let boundTranslate = null

    /**
     * Adopt the shell's locale service: remember it and bind this namespace so the
     * card reads copy through the framework (fallback chain, `common` vocabulary
     * and live locale switches included).
     * @param locale - the client locale service.
     */
    function bindLocaleService(locale) {
      localeService = locale
      boundTranslate = locale.bind(NS)
    }

    /** Normalize any language tag to a shipped base id, defaulting to English. */
    function normalizeLocaleId(raw) {
      const base = String(raw ?? '').trim().toLowerCase().split(/[-_]/)[0]
      return base.length > 0 ? base : 'en'
    }

    /** Per-key fallback chain: the active language, then English. */
    function localeChain(id) {
      const base = normalizeLocaleId(id)
      return base === 'en' ? ['en'] : [base, 'en']
    }

    /** Intl tag for a language id (unknown ids are passed through to Intl). */
    function localeTagFor(id) {
      const base = normalizeLocaleId(id)
      return LOCALE_TAGS[base] !== undefined ? LOCALE_TAGS[base] : base
    }

    /**
     * Translate a key in an explicit language (pure): walks the language's
     * fallback chain, substitutes {name} placeholders, and returns the key itself
     * when nothing matches — the same contract as the framework translator.
     */
    function translateIn(localeId, key, params) {
      let template
      for (const candidate of localeChain(localeId)) {
        const dict = DICTS[candidate]
        if (dict !== undefined && Object.prototype.hasOwnProperty.call(dict, key)) {
          template = dict[key]
          break
        }
      }
      if (template === undefined) return key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)
    }

    /** Browser language, restricted to shipped dictionaries (Russian users get Russian). */
    function detectLocaleId() {
      try {
        if (typeof navigator !== 'undefined') {
          const list = Array.isArray(navigator.languages) && navigator.languages.length > 0
            ? navigator.languages
            : [navigator.language]
          for (const raw of list) {
            const id = normalizeLocaleId(raw)
            if (DICTS[id] !== undefined) return id
          }
        }
      } catch { /* ignore */ }
      return 'en'
    }

    /** Active interface language (fresh on every call; the card re-renders on switches). */
    function activeLocaleId() {
      if (localeService !== null) {
        try {
          return normalizeLocaleId(localeService.getLocale().active)
        } catch { /* ignore */ }
      }
      return detectLocaleId()
    }

    /** Translator used when no locale seat is available (older shells). */
    function translate(key, params) {
      return boundTranslate !== null ? boundTranslate(key, params) : translateIn(activeLocaleId(), key, params)
    }

    /** IANA time zone used for the window table: the viewer's own zone, or UTC. */
    const DISPLAY_TZ = detectTimeZone()

    function detectTimeZone() {
      try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
        if (typeof zone === 'string' && zone.length > 0) return zone
      } catch { /* ignore */ }
      return 'UTC'
    }

    // ── Constants: official peak windows (UTC hours, half-open) and prices (USD / 1M tokens) ──

    const PEAK_WINDOWS = [
      { start: 1, end: 4 },
      { start: 6, end: 10 },
    ]

    const DISPLAY_PRICES = {
      'deepseek-flash': {
        label: 'V4.1-Flash',
        offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
        peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
      },
      'deepseek-v4-pro': {
        label: 'V4-Pro',
        offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
        peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
      },
    }

    // Beijing-time slot table (Beijing = UTC+8, no DST). Official since 2026-08-23:
    // Saturday/Sunday (UTC calendar days) bill as off-peak all day with no switch.
    // The panel no longer hard-codes these rows: buildLocalSlots derives the same
    // schedule in the viewer's own time zone from PEAK_WINDOWS.
    /** Weekend check (UTC Saturday/Sunday): all-day off-peak, no phase switches. */
    function isWeekendUTC(atMs) {
      const day = new Date(atMs).getUTCDay()
      return day === 0 || day === 6
    }

    /** Fixed rate: implied official CNY/USD rate (adjusted to 6.67 on 2026-09-10 with the V4.1 Flash price). */
    const FIXED_FX = 6.67
    /**
     * V4 Pro repricing instant (sentinel = no effective date). The official pricing
     * footnote (2) and the 2026-09-10 changelog state that V4 Pro service continues
     * after 2026-09-14 with billing unchanged until further notice, so the sentinel
     * stays and pro always shows its own price list (symmetric with pricing.js).
     */
    const V4_PRO_RETIRE_AT = Date.parse('9999-12-31T00:00:00Z')
    const CURRENCY_KEY = 'dsh-tidewatch:currency'
    const EXPANDED_KEY = 'dsh-tidewatch:expanded'

    // ── Data bridge: session projection → floating overlay (the root slot has no useProjection seat) ──

    const bridge = {
      value: null,
      listeners: new Set(),
      set(value) {
        this.value = value
        for (const fn of [...this.listeners]) fn(value)
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
    }

    // ── Pure functions: peak decision / countdown / formatting ───────────────

    function isPeakHourUTC(atMs) {
      if (isWeekendUTC(atMs)) return false // weekends are off-peak all day
      const hour = new Date(atMs).getUTCHours()
      return PEAK_WINDOWS.some(w => hour >= w.start && hour < w.end)
    }

    /** Current phase and the next switch instant (UTC). Weekends have no switch, so the next one is Monday's first peak. */
    function nextPhase(atMs) {
      const hourAt = (dayOffset, hour) => {
        const d = new Date(atMs)
        d.setUTCDate(d.getUTCDate() + dayOffset)
        d.setUTCHours(hour, 0, 0, 0)
        return d.getTime()
      }
      const points = []
      // Collect from two days back to three days ahead: covers the Saturday/Sunday →
      // Monday peak span (a weekend's previous switch lands on Friday).
      for (let day = -2; day <= 3; day += 1) {
        const dow = new Date(hourAt(day, 0)).getUTCDay()
        if (dow === 0 || dow === 6) continue // no peak/off-peak switch on weekends
        for (const w of PEAK_WINDOWS) {
          points.push({ at: hourAt(day, w.start), intoPeak: true })
          points.push({ at: hourAt(w.end <= w.start ? day + 1 : day, w.end), intoPeak: false })
        }
      }
      const inPeak = isPeakHourUTC(atMs)
      let prev = null
      let next = null
      for (const p of points) {
        if (p.at <= atMs && (prev === null || p.at > prev.at)) prev = p
        if (p.at > atMs && (next === null || p.at < next.at)) next = p
      }
      if (prev === null || next === null) return null
      return { inPeak, prevAtMs: prev.at, nextAtMs: next.at, nextIntoPeak: next.intoPeak }
    }

    /** Cached two-digit integer formatter (locale digits, no grouping). */
    const twoDigitCache = new Map()
    function twoDigit(tag) {
      let fmt = twoDigitCache.get(tag)
      if (fmt === undefined) {
        try {
          fmt = new Intl.NumberFormat(tag, { minimumIntegerDigits: 2, useGrouping: false })
        } catch {
          fmt = new Intl.NumberFormat('en', { minimumIntegerDigits: 2, useGrouping: false })
        }
        twoDigitCache.set(tag, fmt)
      }
      return fmt
    }

    function fmtCountdown(ms, localeId) {
      const s = Math.max(0, Math.floor(ms / 1000))
      const tag = localeTagFor(localeId)
      const pad = n => twoDigit(tag).format(n)
      return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60)
    }

    /**
     * Collapsed countdown: hours:minutes (rounded up so it does not flicker every
     * second; the expanded panel carries second precision). Rounding up the total
     * minutes before splitting avoids 59:59.x becoming "00:60" instead of 01:00.
     */
    function fmtCountdownShort(ms, localeId) {
      const totalMin = Math.max(0, Math.ceil(ms / 60000))
      const tag = localeTagFor(localeId)
      const pad = n => twoDigit(tag).format(n)
      return pad(Math.floor(totalMin / 60)) + ':' + pad(totalMin % 60)
    }

    /** Cached currency formatter (locale-correct symbol placement and grouping). */
    const moneyCache = new Map()
    function moneyFormatter(tag, code, digits) {
      const key = tag + '|' + code + '|' + digits
      let fmt = moneyCache.get(key)
      if (fmt === undefined) {
        const options = {
          style: 'currency',
          currency: code,
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }
        try {
          fmt = new Intl.NumberFormat(tag, options)
        } catch {
          fmt = new Intl.NumberFormat('en', options)
        }
        moneyCache.set(key, fmt)
      }
      return fmt
    }

    /** Money display: CNY at 2 decimals (× fixed rate), USD at 4 decimals (raw). */
    function fmtMoney(usd, currency, localeId) {
      const tag = localeTagFor(localeId)
      const value = currency === 'usd' ? usd : usd * FIXED_FX
      return moneyFormatter(tag, currency === 'usd' ? 'USD' : 'CNY', currency === 'usd' ? 4 : 2).format(value)
    }

    /** Cached compact token formatter (localized: 1.5M / 1,5 млн). */
    const tokenCache = new Map()
    function fmtTokens(n, localeId) {
      const value = Math.max(0, Math.round(Number(n) || 0))
      const tag = localeTagFor(localeId)
      let fmt = tokenCache.get(tag)
      if (fmt === undefined) {
        const options = { notation: 'compact', maximumFractionDigits: 2 }
        try {
          fmt = new Intl.NumberFormat(tag, options)
        } catch {
          fmt = new Intl.NumberFormat('en', options)
        }
        tokenCache.set(tag, fmt)
      }
      return fmt.format(value)
    }

    // ── Time-zone helpers: the billing rule is UTC, the table is local ───────

    /** Cached zone-aware part formatter used to read wall-clock fields at an instant. */
    const tzPartsCache = new Map()
    function tzPartsFormatter(timeZone) {
      let fmt = tzPartsCache.get(timeZone)
      if (fmt === undefined) {
        const options = {
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }
        try {
          fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone })
        } catch {
          fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' })
        }
        tzPartsCache.set(timeZone, fmt)
      }
      return fmt
    }

    /** Offset of `timeZone` from UTC at `atMs`, in milliseconds (DST-aware). */
    function tzOffsetMs(atMs, timeZone) {
      try {
        const parts = tzPartsFormatter(timeZone).formatToParts(new Date(atMs))
        const read = type => {
          const part = parts.find(p => p.type === type)
          return part === undefined ? 0 : Number(part.value)
        }
        const asUTC = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'))
        return asUTC - atMs
      } catch {
        return 0
      }
    }

    /**
     * Local calendar day containing `atMs` in `timeZone`, as UTC instants.
     * The day length is a nominal 24h: across a DST switch the bounds can be off
     * by the shift, which only trims or pads the table's outermost row.
     */
    function localDayBounds(atMs, timeZone) {
      const offset = tzOffsetMs(atMs, timeZone)
      const start = Math.floor((atMs + offset) / 86400000) * 86400000 - offset
      return { start, end: start + 86400000 }
    }

    /** Cached localized clock formatter for a zone. */
    const clockCache = new Map()
    function clockFormatter(tag, timeZone) {
      const key = tag + '|' + timeZone
      let fmt = clockCache.get(key)
      if (fmt === undefined) {
        const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
        try {
          fmt = new Intl.DateTimeFormat(tag, { ...options, timeZone })
        } catch {
          fmt = new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' })
        }
        clockCache.set(key, fmt)
      }
      return fmt
    }

    /** Clock label for an instant in the display zone. */
    function fmtClock(atMs, timeZone, localeId) {
      return clockFormatter(localeTagFor(localeId), timeZone).format(new Date(atMs))
    }

    /** Same, but a segment ending exactly at the day bound reads as the localized 24:00. */
    function fmtClockEnd(endMs, dayEnd, timeZone, localeId) {
      if (endMs === dayEnd) {
        const tag = localeTagFor(localeId)
        return twoDigit(tag).format(24) + ':' + twoDigit(tag).format(0)
      }
      return fmtClock(endMs, timeZone, localeId)
    }

    /**
     * Peak/off-peak rows for the local calendar day containing `atMs`, expressed in
     * `timeZone`. Boundaries come from the UTC windows; weekend UTC days contribute
     * none (they are off-peak with no switch), so a day overlapping a UTC weekend
     * simply shows a longer off-peak row. Returns the day bounds plus contiguous
     * segments, each tagged with its phase.
     */
    function buildLocalSlots(atMs, timeZone) {
      const bounds = localDayBounds(atMs, timeZone)
      const hourAt = (dayOffset, hour) => {
        const d = new Date(atMs)
        d.setUTCDate(d.getUTCDate() + dayOffset)
        d.setUTCHours(hour, 0, 0, 0)
        return d.getTime()
      }
      const points = []
      for (let day = -1; day <= 1; day += 1) {
        const dow = new Date(hourAt(day, 0)).getUTCDay()
        if (dow === 0 || dow === 6) continue // weekends: off-peak, no switch
        for (const w of PEAK_WINDOWS) {
          points.push({ at: hourAt(day, w.start), intoPeak: true })
          points.push({ at: hourAt(w.end <= w.start ? day + 1 : day, w.end), intoPeak: false })
        }
      }
      const inner = points
        .filter(p => p.at > bounds.start && p.at < bounds.end)
        .sort((a, b) => a.at - b.at)
      const segments = []
      let cursor = bounds.start
      let peak = isPeakHourUTC(cursor) // phase at the day's first instant, tested directly in UTC
      for (const p of inner) {
        if (p.at > cursor) segments.push({ start: cursor, end: p.at, peak })
        cursor = p.at
        peak = p.intoPeak
      }
      if (cursor < bounds.end) segments.push({ start: cursor, end: bounds.end, peak })
      return { dayStart: bounds.start, dayEnd: bounds.end, segments }
    }

    /** Old model names → current model key (V4.1 Flash renamed 2026-09-10; old names route to the new price). */
    const MODEL_ALIASES = {
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
      'deepseek-v4.1-flash': 'deepseek-flash',
    }

    /** Model-name normalization (identical to lib/pricing.js; old names map through the alias table). */
    function priceEntryForModel(model, atMs) {
      const normalize = s => String(s ?? '').toLowerCase().replace(/[\s\-_.()（）]/g, '')
      let id = normalize(model)
      for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
        if (id === normalize(alias)) {
          id = normalize(target)
          break
        }
      }
      // V4 Pro repricing route: never taken while the sentinel holds (symmetric with pricing.js).
      if (id === normalize('deepseek-v4-pro') && Number.isFinite(atMs) && atMs >= V4_PRO_RETIRE_AT) {
        id = 'deepseekflash'
      }
      if (id.length > 0 && Object.prototype.hasOwnProperty.call(DISPLAY_PRICES, id)) return id
      for (const key of Object.keys(DISPLAY_PRICES)) {
        if (id.includes(normalize(key))) return key
      }
      return 'deepseek-flash'
    }

    /** Default display currency for a language: Chinese interface → CNY, everything else → USD. */
    function resolveCurrencyDefault(localeId) {
      return normalizeLocaleId(localeId) === 'zh' ? 'cny' : 'usd'
    }

    /** Whether the user has already made an explicit currency choice. */
    function hasStoredCurrency() {
      try {
        const v = localStorage.getItem(CURRENCY_KEY)
        return v === 'usd' || v === 'cny'
      } catch {
        return false
      }
    }

    function loadCurrency(localeId) {
      try {
        const v = localStorage.getItem(CURRENCY_KEY)
        if (v === 'usd' || v === 'cny') return v
      } catch { /* ignore */ }
      return resolveCurrencyDefault(localeId)
    }

    // ── Styles ───────────────────────────────────────────────────────────────
    // Direction: a harbor tide gauge. One saturated accent carries the phase
    // (amber = peak, green = off-peak) and everything else stays quiet; figures use
    // the shell's mono stack so the panel reads like an instrument. Every token
    // prefers a --dsw-* shell variable and keeps a scheme-aware fallback, so the
    // card is correct in the DSH shell and in a bare host without the theme layer.

    const CSS_TAG_ID = 'dsh-tidewatch'
    const css = [
      '/* dsh-tidewatch: peak/off-peak tide gauge */',
      // Tokens (light fallbacks first, dark overrides further down)
      '.tw-root{--tw-mono:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);--tw-surface:var(--dsw-alias-bg-layer-2,#fff);--tw-inset:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));--tw-line:var(--dsw-alias-border-l2,rgba(0,0,0,.12));--tw-line-strong:var(--dsw-alias-border-l3,rgba(0,0,0,.2));--tw-text:var(--dsw-alias-label-primary,#0f1115);--tw-muted:var(--dsw-alias-label-secondary,#61666b);--tw-faint:var(--dsw-alias-label-tertiary,#81858c);--tw-peak:var(--dsw-alias-state-warn-primary,#f59e0b);--tw-peak-soft:var(--dsw-alias-state-warn-tertiary,#fef5e7);--tw-off:var(--dsw-alias-state-success-primary,#22c55e);--tw-off-soft:var(--dsw-alias-state-success-tertiary,#e6faed);--tw-accent:var(--tw-peak);--tw-ring:var(--dsw-alias-state-business-primary,#4d9fff);--tw-shadow:0 20px 44px rgba(15,17,21,.16),0 2px 8px rgba(15,17,21,.08),inset 0 1px 0 rgba(255,255,255,.65);position:fixed;z-index:1001;pointer-events:auto;font-family:var(--dsw-font-family,inherit)}',
      '.tw-root.offpeak{--tw-accent:var(--tw-off)}',
      '@media (prefers-color-scheme:dark){.tw-root{--tw-surface:var(--dsw-alias-bg-layer-2,#26262a);--tw-inset:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));--tw-line:var(--dsw-alias-border-l2,rgba(255,255,255,.12));--tw-line-strong:var(--dsw-alias-border-l3,rgba(255,255,255,.18));--tw-text:var(--dsw-alias-label-primary,#f1f3f5);--tw-muted:var(--dsw-alias-label-secondary,#cfd3d6);--tw-faint:var(--dsw-alias-label-tertiary,#a3a8b0);--tw-peak-soft:var(--dsw-alias-state-warn-tertiary,#2a2113);--tw-off-soft:var(--dsw-alias-state-success-tertiary,#132a1d);--tw-shadow:0 22px 56px rgba(0,0,0,.6),0 2px 10px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.05)}}',
      'body[data-ds-dark-theme] .tw-root{--tw-surface:var(--dsw-alias-bg-layer-2,#26262a);--tw-inset:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));--tw-line:var(--dsw-alias-border-l2,rgba(255,255,255,.12));--tw-line-strong:var(--dsw-alias-border-l3,rgba(255,255,255,.18));--tw-text:var(--dsw-alias-label-primary,#f1f3f5);--tw-muted:var(--dsw-alias-label-secondary,#cfd3d6);--tw-faint:var(--dsw-alias-label-tertiary,#a3a8b0);--tw-peak-soft:var(--dsw-alias-state-warn-tertiary,#2a2113);--tw-off-soft:var(--dsw-alias-state-success-tertiary,#132a1d);--tw-shadow:0 22px 56px rgba(0,0,0,.6),0 2px 10px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.05)}',
      // Collapsed chip
      '.tw-chip{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 12px;border:1px solid var(--tw-line);border-radius:999px;background:var(--tw-surface);color:var(--tw-text);font-family:inherit;font-size:11.5px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;user-select:none;box-shadow:var(--tw-shadow);transition:border-color .16s ease,transform .16s ease;corner-shape:var(--dsw-corner-shape,round)}',
      '.tw-chip:hover{border-color:var(--tw-line-strong);transform:translateY(-1px)}',
      '.tw-chip:active{transform:translateY(0)}',
      '.tw-chip:focus-visible{outline:2px solid var(--tw-ring);outline-offset:2px}',
      '.tw-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--tw-accent);color:var(--tw-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--tw-accent) 20%,transparent)}',
      '.tw-chip-phase{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--tw-muted);color:color-mix(in srgb,var(--tw-accent) 64%,var(--tw-text))}',
      '.tw-chip-count{font-family:var(--tw-mono);font-size:10.5px;color:var(--tw-muted);font-variant-numeric:tabular-nums}',
      '.tw-chip-sep{flex:none;width:1px;height:12px;background:var(--tw-line)}',
      '.tw-chip-cost{font-family:var(--tw-mono);font-size:11.5px;font-weight:600;color:var(--tw-text);font-variant-numeric:tabular-nums}',
      // Panel shell: dark glass with a phase-tinted top edge
      '.tw-panel{position:absolute;right:0;bottom:calc(100% + 10px);z-index:1002;width:330px;max-width:calc(100vw - 24px);max-height:min(calc(100vh - 130px),560px);box-sizing:border-box;padding:11px 12px 10px;border:1px solid var(--tw-line);border-radius:18px;background:var(--tw-surface);background:color-mix(in srgb,var(--tw-surface) 90%,transparent);-webkit-backdrop-filter:blur(20px) saturate(1.4);backdrop-filter:blur(20px) saturate(1.4);box-shadow:var(--tw-shadow);color:var(--tw-text);font-size:12px;text-align:left;white-space:normal;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;corner-shape:var(--dsw-corner-shape,round)}',
      '.tw-panel{scrollbar-width:thin;scrollbar-color:var(--tw-line) transparent}',
      '.tw-panel::-webkit-scrollbar{width:6px}',
      '.tw-panel::-webkit-scrollbar-track{background:transparent}',
      '.tw-panel::-webkit-scrollbar-thumb{background:var(--tw-line);border-radius:3px}',
      '.tw-panel::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--tw-accent),color-mix(in srgb,var(--tw-accent) 12%,transparent) 68%,transparent);pointer-events:none}',
      '.tw-panel-in{animation:tw-rise .18s cubic-bezier(.2,.8,.3,1)}',
      '@keyframes tw-rise{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}',
      // Header: phase and countdown, then the tide line
      '.tw-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.tw-phase{display:inline-flex;align-items:center;gap:7px;padding-top:3px;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--tw-muted);color:color-mix(in srgb,var(--tw-accent) 64%,var(--tw-text));line-height:1.4}',
      '.tw-timer{display:flex;flex-direction:column;align-items:flex-end;gap:1px}',
      '.tw-eyebrow{font-size:9.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--tw-faint);line-height:1.5}',
      '.tw-count{font-family:var(--tw-mono);font-size:15px;font-weight:700;letter-spacing:-.02em;line-height:1.15;color:var(--tw-text);font-variant-numeric:tabular-nums}',
      '.tw-tide{position:relative;height:5px;margin:8px 0 2px;border-radius:999px;background:var(--tw-inset)}',
      '.tw-tide-fill{position:absolute;top:0;bottom:0;left:0;border-radius:999px;background:var(--tw-accent);background:linear-gradient(90deg,color-mix(in srgb,var(--tw-accent) 45%,transparent),var(--tw-accent));transition:width .9s linear}',
      '.tw-tide-knob{position:absolute;top:50%;width:11px;height:11px;border-radius:50%;background:var(--tw-accent);border:2px solid var(--tw-surface);transform:translate(-50%,-50%);box-shadow:0 0 0 3px color-mix(in srgb,var(--tw-accent) 16%,transparent);transition:left .9s linear}',
      '@media (prefers-reduced-motion:reduce){.tw-tide-fill,.tw-tide-knob{transition:none}.tw-panel-in{animation:none}}',
      // Section headers
      '.tw-sec{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:9px 0 5px}',
      '.tw-sec-title{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--tw-muted);white-space:nowrap}',
      '.tw-sec-meta{flex:0 1 auto;min-width:0;max-width:55%;font-family:var(--tw-mono);font-size:9.5px;color:var(--tw-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tw-note{margin:-2px 0 5px;font-size:10px;color:var(--tw-faint);line-height:1.45}',
      // Tide table
      '.tw-rows{display:flex;flex-direction:column;gap:1px}',
      '.tw-row{position:relative;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:2px 9px;border-radius:8px}',
      '.tw-row.now{background:var(--tw-inset)}',
      '.tw-row.now::before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:2px;border-radius:2px;background:var(--tw-accent)}',
      '.tw-time{font-family:var(--tw-mono);font-size:11px;letter-spacing:-.01em;color:var(--tw-muted);font-variant-numeric:tabular-nums}',
      '.tw-row.now .tw-time{color:var(--tw-text);font-weight:600}',
      '.tw-row-right{display:inline-flex;align-items:center;gap:7px}',
      '.tw-now{font-size:9.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--tw-muted);color:color-mix(in srgb,var(--tw-accent) 64%,var(--tw-text))}',
      '.tw-pill{font-family:var(--tw-mono);font-size:9.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;padding:2.5px 7px;border-radius:6px;color:var(--tw-text);line-height:1.35}',
      '.tw-pill.peak{background:var(--tw-peak-soft);color:color-mix(in srgb,var(--tw-peak) 70%,var(--tw-text))}',
      '.tw-pill.offpeak{background:var(--tw-off-soft);color:color-mix(in srgb,var(--tw-off) 62%,var(--tw-text))}',
      // Active tier rates
      '.tw-rate{display:flex;flex-direction:column;gap:4px;margin-top:1px;padding:7px 10px;border-radius:11px;background:var(--tw-inset)}',
      '.tw-rate-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px}',
      '.tw-rate-label{font-size:11px;color:var(--tw-muted)}',
      '.tw-rate-val{font-family:var(--tw-mono);font-size:11.5px;font-weight:600;color:var(--tw-text);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.tw-unit{font-weight:500;color:var(--tw-faint)}',
      // Token breakdown
      '.tw-tokens{display:flex;flex-direction:column;gap:2px}',
      '.tw-token-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:0 9px}',
      '.tw-token-label{font-size:11px;color:var(--tw-muted)}',
      '.tw-token-row.sub .tw-token-label{padding-left:11px;color:var(--tw-faint)}',
      '.tw-token-val{font-family:var(--tw-mono);font-size:11.5px;font-weight:600;color:var(--tw-text);font-variant-numeric:tabular-nums}',
      '.tw-empty{padding:2px 9px 4px;font-size:11px;color:var(--tw-faint)}',
      // Session cost footer
      '.tw-total{position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;box-sizing:border-box;margin-top:9px;padding:8px 12px 8px 14px;border:0;border-radius:12px;background:var(--tw-inset);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background .16s ease}',
      '.tw-total::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:2.5px;border-radius:2px;background:var(--tw-accent)}',
      '.tw-total:hover{background:var(--tw-inset);background:color-mix(in srgb,var(--tw-accent) 12%,var(--tw-inset))}',
      '.tw-total:focus-visible{outline:2px solid var(--tw-ring);outline-offset:2px}',
      '.tw-total-label{display:inline-flex;align-items:center;gap:7px;font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--tw-muted)}',
      '.tw-chev{flex:none;width:8px;height:10px;color:var(--tw-faint);transition:transform .18s ease}',
      '.tw-total.open .tw-chev{transform:rotate(90deg)}',
      '.tw-total-val{font-family:var(--tw-mono);font-size:18px;font-weight:700;letter-spacing:-.02em;color:var(--tw-text);font-variant-numeric:tabular-nums}',
      '.tw-models{display:flex;flex-direction:column;gap:5px;margin-top:7px;padding:0 2px}',
      '.tw-model-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px}',
      '.tw-model-name{display:inline-flex;align-items:center;gap:7px;color:var(--tw-muted)}',
      '.tw-model-tag{font-family:var(--tw-mono);font-size:9.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:2.5px 6px;border-radius:6px;color:var(--tw-muted);background:var(--tw-inset);white-space:nowrap}',
      '.tw-model-val{font-family:var(--tw-mono);font-weight:600;color:var(--tw-text);font-variant-numeric:tabular-nums}',
      // Currency segmented control
      '.tw-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px}',
      '.tw-foot-label{font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--tw-faint)}',
      '.tw-seg{display:inline-flex;gap:2px;padding:2px;border-radius:10px;background:var(--tw-inset)}',
      '.tw-seg-btn{font-family:var(--tw-mono);font-size:10.5px;font-weight:600;letter-spacing:.02em;line-height:1;color:var(--tw-muted);background:transparent;border:0;border-radius:8px;padding:5px 10px;cursor:pointer;transition:background .16s ease,color .16s ease}',
      '.tw-seg-btn:hover{color:var(--tw-text)}',
      '.tw-seg-btn[aria-pressed="true"]{background:var(--tw-surface);color:var(--tw-text);box-shadow:0 1px 4px rgba(0,0,0,.22)}',
      '.tw-seg-btn:focus-visible{outline:2px solid var(--tw-ring);outline-offset:1px}',
    ].join('\n')

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', CSS_TAG_ID)
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ── Floating placement: anchored right of the composer, vertically centered; moved above it when there is no room ──

    /**
     * Height budget for the expanded panel: the free space between the chip's top edge
     * and the viewport edge above it, clamped to a usable range. A fixed `100vh`
     * reserve would either clip the panel on a short viewport or force a scrollbar
     * while unused space is still available above the composer.
     * @param viewportHeight - window.innerHeight.
     * @param bottom - the chip's CSS `bottom` offset (distance from the viewport bottom).
     * @param chipHeight - the chip's rendered height.
     * @returns the panel's max-height in px (220..620).
     */
    function panelHeightBudget(viewportHeight, bottom, chipHeight) {
      const chipTop = viewportHeight - bottom - chipHeight
      return Math.round(Math.min(620, Math.max(220, chipTop - 20)))
    }

    function usePlacement(rootRef) {
      const [pos, setPos] = useState({ right: 16, bottom: 96 })
      useEffect(() => {
        let raf = 0
        function setPosIfChanged(next) {
          setPos(prev => (prev.right === next.right && prev.bottom === next.bottom && prev.maxPanel === next.maxPanel
            ? prev
            : next))
        }
        function measure() {
          cancelAnimationFrame(raf)
          raf = requestAnimationFrame(() => {
            const card = document.querySelector('[data-composer-card]')
            const GAP = 12
            const EDGE = 16
            const W = rootRef.current !== null ? rootRef.current.offsetWidth : 200
            const H = rootRef.current !== null ? rootRef.current.offsetHeight : 24
            if (!card) {
              const fallbackBottom = 96
              setPosIfChanged({ right: EDGE, bottom: fallbackBottom, maxPanel: panelHeightBudget(window.innerHeight, fallbackBottom, H) })
              return
            }
            const r = card.getBoundingClientRect()
            // Badge left edge = card right edge + GAP, so `right` must subtract both
            // GAP and the badge width W: aligning only the right edges would let a
            // 200px badge expand leftwards into the composer card (the root cause of
            // the earlier "fullscreen badge covers the composer" bug).
            const right = window.innerWidth - r.right - GAP - W
            // Vertically centered on the composer card: the card's center is the
            // badge's center. The official stats bar renders below the card
            // (conversation.composer.dock), and the badge stays within the card's
            // vertical span, covering neither the composer nor the send button.
            const centerY = r.top + r.height / 2
            const verticalOK = H <= r.height + 1
              && centerY - H / 2 >= EDGE
              && centerY + H / 2 <= window.innerHeight - EDGE
            // The expanded panel opens upwards from the chip, so its height budget is
            // measured from the chip's real top edge (not a fixed 100vh reserve): on a
            // short viewport a fixed reserve would either clip the panel or force a
            // scrollbar while there is still unused space above the composer.
            const bottom = right >= EDGE && verticalOK
              // Fits horizontally and stays in the viewport when centered: hug the
              // card's right edge, vertically centered (no overlap with sibling
              // floating widgets). bottom = viewport height - badge bottom y, where
              // badge bottom y = card center + half the badge height.
              ? window.innerHeight - centerY - H / 2
              // No room: move above the composer, hugging the viewport's right edge —
              // clear of the usual fallback spot of sibling floating widgets (the
              // viewport's left side) and still not covering the composer.
              : Math.max(EDGE, window.innerHeight - r.top + GAP)
            setPosIfChanged({
              right: right >= EDGE && verticalOK ? right : EDGE,
              bottom,
              maxPanel: panelHeightBudget(window.innerHeight, bottom, H),
            })
          })
        }
        measure()
        window.addEventListener('resize', measure)
        const ro = new ResizeObserver(measure)
        const overlayEl = document.querySelector('[data-shell-overlay]')
        const frameEl = overlayEl && overlayEl.parentElement
        if (frameEl && frameEl.firstElementChild) ro.observe(frameEl.firstElementChild)
        const mo = new MutationObserver(measure)
        mo.observe(document.body, { childList: true, subtree: true })
        return () => {
          cancelAnimationFrame(raf)
          window.removeEventListener('resize', measure)
          ro.disconnect()
          mo.disconnect()
        }
      }, [])
      return pos
    }

    // ── Data probe (session slot): subscribes to the projection, renders null ──

    function Probe(props) {
      const sessionId = props.sessionId
      const usage = props.useProjection ? props.useProjection('costUsage') : undefined
      // Session slots render with sessionId as the React key: a session switch
      // unmounts and remounts the component. On mount, first clear the bridge
      // ownership (a new session has no new projection value before its first
      // call, so a stale amount from the previous session would otherwise linger),
      // then the effect below writes the current session's value and owner id.
      useEffect(() => {
        bridge.set({ sessionId: undefined, usage: null })
      }, [])
      // Depends on sessionId + usage: either change rewrites the bridge together
      // with the owning session id.
      useEffect(() => {
        bridge.set({ sessionId, usage: usage ?? null })
      }, [sessionId, usage])
      return null
    }

    // ── Bridge ownership ─────────────────────────────────────────────────────
    // The sessions list snapshot carries no `current` field on this shell (it is
    // { ids, byId, phase, projectionsBySession }), so `s.current` is always
    // undefined and the ownership check below discarded every real value — the
    // card rendered its phase and countdown but a permanent 0 cost. The current
    // session is the one the main view retains; when the list cannot tell, the
    // card trusts the probe, which clears the bridge on mount, so a session
    // switch still cannot show a stale amount.

    /** Session id the main view retains, or undefined when the list cannot tell. */
    function sessionListCurrentId(state) {
      const rows = state && state.byId ? Object.values(state.byId) : []
      for (const row of rows) {
        if (row && row.retainedBy && (row.retainedBy.mainView ?? 0) > 0) return row.sessionId
      }
      return undefined
    }

    // ── Floating badge (shell.overlay): subscribes to the bridge and renders ──

    function TideCard(props) {
      // Framework translator seat when the locale plugin registered this namespace;
      // the local translator otherwise (older shells).
      const t = typeof props.t === 'function' ? props.t : translate
      const localeId = activeLocaleId()
      const [snap, setSnap] = useState(bridge.value)
      // Active session id (root slot standard kit): the bridge ownership check.
      const currentSessionId = props.useSessions ? props.useSessions(sessionListCurrentId) : undefined
      const usage = snap !== null && (currentSessionId === undefined || snap.sessionId === currentSessionId) ? snap.usage : null
      const [now, setNow] = useState(() => Date.now())
      const [expanded, setExpanded] = useState(() => {
        try { return localStorage.getItem(EXPANDED_KEY) === '1' } catch { return false }
      })
      const [currency, setCurrency] = useState(() => loadCurrency(localeId))
      const [costOpen, setCostOpen] = useState(false)
      const rootRef = useRef(null)

      useEffect(() => bridge.subscribe(setSnap), [])
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [])
      // While the user has made no explicit choice, the default currency follows
      // the interface language (Chinese → CNY, otherwise USD).
      useEffect(() => {
        if (!hasStoredCurrency()) setCurrency(resolveCurrencyDefault(localeId))
      }, [localeId])
      /** Expanded-state write (with localStorage persistence): shared by toggles and outside dismissal. */
      const applyExpanded = useCallback(next => {
        setExpanded(next)
        try { localStorage.setItem(EXPANDED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      }, [])
      // Outside dismissal: the official useDismissOnOutsidePointer (pointerdown)
      // when available, otherwise the same-signature local implementation; both
      // attach listeners only while expanded.
      useDismissOutside(rootRef, expanded, applyExpanded)

      const pos = usePlacement(rootRef)
      const phase = nextPhase(now)
      const inPeak = phase !== null && phase.inPeak
      const countdown = phase === null ? 0 : Math.max(0, phase.nextAtMs - now)
      const countdownKey = phase !== null && phase.nextIntoPeak ? 'countdown.toPeak' : 'countdown.toOffpeak'
      const costUsd = Number(usage?.cost) || 0
      const schedule = buildLocalSlots(now, DISPLAY_TZ)
      const weekendNow = isWeekendUTC(now)

      const toggle = () => applyExpanded(!expanded)

      const setCurrencyPersist = next => {
        setCurrency(next)
        try { localStorage.setItem(CURRENCY_KEY, next) } catch { /* ignore */ }
      }

      // Active model: prefer the projection view's model (the model in use, tracked
      // live from request/header updates); with no request history fall back to the
      // first byModel key, then to flash.
      const modelKeys = usage?.byModel !== undefined ? Object.keys(usage.byModel) : []
      const activeModel = typeof usage?.model === 'string' && usage.model.length > 0 ? usage.model : (modelKeys[0] ?? 'deepseek-flash')
      const modelKey = priceEntryForModel(activeModel, now)
      const price = DISPLAY_PRICES[modelKey]
      const tier = inPeak ? price.peak : price.offPeak
      const input = Number(usage?.input) || 0
      const cache = (Number(usage?.cacheRead) || 0) + (Number(usage?.cacheWrite) || 0)
      const output = Number(usage?.output) || 0
      const reasoning = Number(usage?.reasoning) || 0

      // Tide line: how far the current phase has already run.
      const progress = phase !== null && phase.nextAtMs > phase.prevAtMs
        ? Math.min(1, Math.max(0, (now - phase.prevAtMs) / (phase.nextAtMs - phase.prevAtMs)))
        : 0
      const progressPct = Math.round(progress * 100)
      const countdownLabelKey = phase !== null && phase.nextIntoPeak ? 'countdown.labelPeak' : 'countdown.labelOffpeak'

      // Collapsed chip: wrapped in the official Tooltip (Tip degrades to a native title without the primitive).
      const chip = el('button', {
        type: 'button',
        className: 'tw-chip',
        onClick: toggle,
        'aria-expanded': expanded,
      },
        el(PhaseDot, { inPeak, size: 8 }),
        el('span', { className: 'tw-chip-phase' }, t(inPeak ? 'phase.peak' : 'phase.offpeak')),
        el('span', { className: 'tw-chip-count' }, t(countdownKey, { time: fmtCountdownShort(countdown, localeId) })),
        el('span', { className: 'tw-chip-sep' }),
        el('span', { className: 'tw-chip-cost' }, fmtMoney(costUsd, currency, localeId)))

      return el('div', {
        ref: rootRef,
        className: 'tw-root' + (inPeak ? ' peak' : ' offpeak'),
        style: { right: pos.right, bottom: pos.bottom },
      },
        el(Tip, { label: t('chip.tip'), node: chip }),
        expanded ? el('div', {
          className: 'tw-panel tw-panel-in',
          role: 'group',
          'aria-label': t('panel.slotsTitle'),
          // Height budget measured from the chip's real top edge (fallback in the CSS
          // before the first measurement lands).
          style: pos.maxPanel !== undefined ? { maxHeight: pos.maxPanel + 'px' } : undefined,
        },
          // Header: current phase + countdown to the next switch
          el('div', { className: 'tw-head' },
            el('span', { className: 'tw-phase' },
              el(PhaseDot, { inPeak, size: 8 }),
              el('span', null, t(inPeak ? 'phase.peakActive' : 'phase.offpeakActive'))),
            el('span', { className: 'tw-timer' },
              el('span', { className: 'tw-eyebrow' }, t(countdownLabelKey)),
              el('span', { className: 'tw-count' }, fmtCountdown(countdown, localeId)))),
          // Tide line: elapsed share of the current phase
          el('div', {
            className: 'tw-tide',
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': progressPct,
            'aria-label': t('a11y.phaseProgress', { percent: progressPct }),
          },
            el('div', { className: 'tw-tide-fill', style: { width: progressPct + '%' } }),
            el('div', { className: 'tw-tide-knob', style: { left: 'clamp(5px,' + progressPct + '%,calc(100% - 5px))' } })),
          // Window table, rendered in the viewer's own time zone
          el('div', { className: 'tw-sec' },
            el('span', { className: 'tw-sec-title' }, t('panel.slotsTitle')),
            el('span', { className: 'tw-sec-meta' }, t('panel.slotsLocal', { tz: DISPLAY_TZ }))),
          weekendNow ? el('div', { className: 'tw-note' }, t('panel.slotsWeekendNote')) : null,
          el('div', { className: 'tw-rows' },
            schedule.segments.map(seg => {
              const isNow = now >= seg.start && now < seg.end
              const tone = seg.peak ? 'peak' : 'offpeak'
              return el('div', {
                key: String(seg.start) + ':' + String(seg.end),
                className: 'tw-row' + (isNow ? ' now' : ''),
              },
                el('span', { className: 'tw-time' },
                  fmtClock(seg.start, DISPLAY_TZ, localeId) + ' – ' + fmtClockEnd(seg.end, schedule.dayEnd, DISPLAY_TZ, localeId)),
                el('span', { className: 'tw-row-right' },
                  isNow ? el('span', { className: 'tw-now' }, t('slot.now')) : null,
                  el('span', { className: 'tw-pill ' + tone }, t(seg.peak ? 'slot.peak' : 'slot.offpeak'))))
            })),
          // Active tier rates
          el('div', { className: 'tw-sec' },
            el('span', { className: 'tw-sec-title' }, t('panel.rateTitle')),
            el('span', { className: 'tw-sec-meta' }, t('panel.rateMeta', { model: price.label, tier: t(inPeak ? 'tier.peak' : 'tier.offpeak') }))),
          el('div', { className: 'tw-rate' },
            el('div', { className: 'tw-rate-row' },
              el('span', { className: 'tw-rate-label' }, t('price.input')),
              el('span', { className: 'tw-rate-val' },
                fmtMoney(tier.cacheMiss, currency, localeId) + ' / ' + fmtMoney(tier.cacheHit, currency, localeId),
                el('span', { className: 'tw-unit' }, t('price.perMillion')))),
            el('div', { className: 'tw-rate-row' },
              el('span', { className: 'tw-rate-label' }, t('price.output')),
              el('span', { className: 'tw-rate-val' },
                fmtMoney(tier.output, currency, localeId),
                el('span', { className: 'tw-unit' }, t('price.perMillion'))))),
          // Token breakdown
          el('div', { className: 'tw-sec' }, el('span', { className: 'tw-sec-title' }, t('tokens.title'))),
          usage === undefined || (input + cache + output + reasoning) === 0
            ? el('div', { className: 'tw-empty' }, t('tokens.empty'))
            : el('div', { className: 'tw-tokens' },
                el('div', { className: 'tw-token-row' },
                  el('span', { className: 'tw-token-label' }, t('tokens.input')),
                  el('span', { className: 'tw-token-val' }, fmtTokens(input, localeId))),
                el('div', { className: 'tw-token-row' },
                  el('span', { className: 'tw-token-label' }, t('tokens.cache')),
                  el('span', { className: 'tw-token-val' }, fmtTokens(cache, localeId))),
                el('div', { className: 'tw-token-row' },
                  el('span', { className: 'tw-token-label' }, t('tokens.output')),
                  el('span', { className: 'tw-token-val' }, fmtTokens(output, localeId))),
                reasoning > 0 ? el('div', { className: 'tw-token-row sub' },
                  el('span', { className: 'tw-token-label' }, t('tokens.reasoning')),
                  el('span', { className: 'tw-token-val' }, fmtTokens(reasoning, localeId))) : null),
          // Session cost (click to expand the per-model breakdown) + currency switch.
          // Deliberately no Tooltip seat here. The official Tooltip renders its bubble
          // as a sibling span with position:fixed, and this panel is both a scroll
          // container (overflow-y) and a containing block for fixed descendants
          // (backdrop-filter), so the bubble would resolve in panel coordinates and
          // inflate the panel's scrollable overflow — a scrollbar with nothing to
          // scroll plus a layout shift. A native title keeps the hint with no layout
          // impact. Do not wrap in-panel content in Tip without removing the panel's
          // backdrop-filter first.
          el('button', {
            type: 'button',
            className: 'tw-total' + (costOpen ? ' open' : ''),
            onClick: () => setCostOpen(v => !v),
            'aria-expanded': costOpen,
            title: t('cost.tip'),
          },
            el('span', { className: 'tw-total-label' },
              el('svg', { className: 'tw-chev', viewBox: '0 0 8 10', 'aria-hidden': 'true' },
                el('path', {
                  d: 'M1 1l6 4-6 4',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: '1.8',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                })),
              el('span', null, t('cost.title'))),
            el('span', { className: 'tw-total-val' }, fmtMoney(costUsd, currency, localeId))),
          costOpen ? el('div', { className: 'tw-models' },
            Object.entries(usage?.byModel ?? {}).length === 0
              ? el('div', { className: 'tw-model-row' },
                  el('span', { className: 'tw-model-name' }, t('tokens.empty')),
                  el('span', { className: 'tw-model-val' }, fmtMoney(0, currency, localeId)))
              : Object.entries(usage.byModel)
                  .sort((a, b) => (b[1].cost ?? 0) - (a[1].cost ?? 0))
                  .map(([id, bucket]) => {
                    const entry = DISPLAY_PRICES[priceEntryForModel(id, now)]
                    const label = entry !== undefined ? entry.label : id
                    return el('div', { key: id, className: 'tw-model-row' },
                      el('span', { className: 'tw-model-name' },
                        el(PhaseTag, { tone: 'outline', fallbackClass: 'tw-model-tag' }, label),
                        el('span', null, t('cost.modelRow', {
                          input: fmtTokens(bucket.input, localeId),
                          output: fmtTokens(bucket.output, localeId),
                        }))),
                      el('span', { className: 'tw-model-val' }, fmtMoney(bucket.cost ?? 0, currency, localeId)))
                  })) : null,
          el('div', { className: 'tw-foot' },
            el('span', { className: 'tw-foot-label' }, t('currency.label')),
            el('span', { className: 'tw-seg', role: 'group', 'aria-label': t('currency.label') },
              el('button', {
                type: 'button',
                className: 'tw-seg-btn',
                'aria-pressed': currency === 'cny',
                onClick: () => setCurrencyPersist('cny'),
              }, t('currency.cny')),
              el('button', {
                type: 'button',
                className: 'tw-seg-btn',
                'aria-pressed': currency === 'usd',
                onClick: () => setCurrencyPersist('usd'),
              }, t('currency.usd')))))
          : null)
    }

    // ── Plugin body ──────────────────────────────────────────────────────────

    // No RPC: UI + session projection only, so no contribution descriptors.
    const CONTRIBUTION = { package: 'dsh-tidewatch', descriptors: [] }
    const inject = ['remote']

    /**
     * Register this plugin's dictionaries and offer its language pack to the shared
     * catalog. Called as soon as the locale service exists; every registration is
     * released through ctx.effect.
     * @param ctx - client plugin context.
     * @param locale - the locale service.
     */
    function setupLocale(ctx, locale) {
      bindLocaleService(locale)
      ctx.effect(() => locale.register(NS, 'zh', zh), 'dsh-tidewatch: zh dictionary')
      ctx.effect(() => locale.register(NS, 'en', en), 'dsh-tidewatch: en dictionary')
      ctx.effect(() => locale.register(NS, LANGUAGE_PACK.id, ru), 'dsh-tidewatch: ru dictionary')
      ctx.effect(() => {
        let dispose = null
        try {
          const known = locale.getLocale().locales.some(item => normalizeLocaleId(item.id) === normalizeLocaleId(LANGUAGE_PACK.id))
          if (!known) dispose = locale.addLanguage(LANGUAGE_PACK)
        } catch (error) {
          console.warn('[dsh-tidewatch] language pack registration skipped:', error)
        }
        return () => { if (dispose !== null) dispose() }
      }, 'dsh-tidewatch: language pack')
    }

    async function apply(ctx) {
      try {
        const remote = ctx.remote
        if (remote !== undefined && typeof remote.$mount === 'function') {
          const unmount = await remote.$mount(CONTRIBUTION)
          ctx.effect(() => () => { unmount() }, 'dsh-tidewatch: contribution unmount')
        }
      } catch (error) {
        console.warn('[dsh-tidewatch] contribution mount skipped:', error)
      }

      // i18n: adopt the locale service (immediately-available on modern shells;
      // awaited through optional injection otherwise) and register the dictionaries.
      // `localized` is decided by the eager check alone: the `locale` seat may be
      // declared on a slot only when the locale face is already installed, and an
      // entry declaring a namespace without that face makes slot assembly throw — so
      // a late-arriving service registers dictionaries but keeps the local fallback.
      const locale = ctx.get('locale')
      const localized = locale !== undefined
      if (localized) setupLocale(ctx, locale)
      else ctx.inject(['locale'], scope => setupLocale(scope, scope.locale))

      const slots = ctx.get('slots')
      if (slots === undefined) {
        console.warn('[dsh-tidewatch] slots unavailable, tide card not mounted')
        return
      }
      // Data probe: session-scoped slot (provides the useProjection seat), renders null.
      // slots.inject waits for the host declaration and unloads automatically when it disappears.
      slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'dsh-tidewatch-probe', order: 100, inject: () => ({}) },
        Probe,
      ))
      // Floating badge: root-level overlay slot (fixed positioning, own anchor measurement, zero coupling with other plugins).
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'dsh-tidewatch', order: 101, ...(localized ? { locale: NS } : {}) },
        TideCard,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    // Non-enumerable internals for test/verify.mjs (pure helpers and dictionaries);
    // the host plugin loader only reads apply/inject, and enumerating exports stays clean.
    Object.defineProperty(exports, '__internal', {
      value: {
        NS,
        DICTS,
        LANGUAGE_PACK,
        PEAK_WINDOWS,
        DISPLAY_PRICES,
        MODEL_ALIASES,
        bridge,
        sessionListCurrentId,
        nextPhase,
        panelHeightBudget,
        translateIn,
        normalizeLocaleId,
        localeTagFor,
        resolveCurrencyDefault,
        detectTimeZone: () => DISPLAY_TZ,
        tzOffsetMs,
        localDayBounds,
        buildLocalSlots,
        fmtClock,
        fmtClockEnd,
        fmtCountdown,
        fmtCountdownShort,
        fmtMoney,
        fmtTokens,
      },
      enumerable: false,
    })
    return module.exports
  },
})
