# dsh-tidewatch: portable core, DSH wiring and maintenance runbook

> Two audiences: whoever maintains this plugin (the runbook at the end), and whoever wants to reuse the peak/off-peak
> and billing core in another host. One rule serves both: **all billing and peak/off-peak math lives in pure functions,
> and the host only feeds usage events.**

## 1. The portable core: lib/pricing.js (zero dependencies)

The plugin's "brain" depends on no cordis / DSH runtime at all:

| Export | Purpose |
|---|---|
| `isPeakHour(atMs)` | Whether an instant is in a peak window (UTC windows; weekends are off-peak all day) |
| `peakPhaseAt(atMs)` | Current phase + next switch instant (countdown data source) |
| `tierFor(entry, atMs)` | Pick the tier by instant across three price eras: base (legacyBase) / first peak era (priorPeak, priorOffPeak) / current peak era (peak, offPeak) |
| `costOf(tokens, entry, atMs)` | USD cost of one call |
| `priceEntryFor(model, atMs)` | Normalized model-name matching + alias table (MODEL_ALIASES) → price entry; falls back to `default` |
| `DEFAULT_PEAK_WINDOWS` | Peak windows (UTC hours, half-open) |
| `DEFAULT_PRICE_TABLE` | Official price list (a price change touches only this) |
| `MODEL_ALIASES` | Legacy / transitional model names → current model key |
| `LEGACY_BASE_BOUNDARY` | Start of the peak era (earlier calls bill at legacyBase) |
| `FLASH_REPRICE_BOUNDARY` | V4.1 Flash repricing boundary (earlier calls use the prior tier) |
| `V4_PRO_RETIRE_BOUNDARY` | V4 Pro repricing boundary, currently a sentinel (official billing unchanged) |

Any host only has to "pick the price entry by the call instant, then compute the cost":

```js
const entry = priceEntryFor(model, event.time)   // model → price entry (with historical tiers)
const usd = costOf({ input, output, cacheRead, cacheWrite, reasoning }, entry, event.time)
```

and it gets the same USD cost basis as the official bill.

## 2. How the card is wired into DeepSeek Harness

- **Host** (`lib/index.js`): `ctx.inject(['sessionProjections'])` registers the `costUsage` projection. It folds the
  session event stream (`request/header`, `assistant/chunk` usage, `assistant/message`) into token buckets plus a USD
  cost, billing every call by its own event instant. The `wire.view` block is what makes the projection visible to the
  browser; without it the projection stays host-only and the card reads zero forever.
- **Client** (`lib/client.js`): two slot seats with different jobs —
    - `conversation.composer.dock` (session scope) mounts `Probe`, which renders `null` and exists only to obtain the
      `useProjection` seat, writing the value into a module-level bridge store;
    - `shell.overlay` (root scope) mounts the floating `TideCard`, which subscribes to that bridge. A root-level slot has
      no projection seat, which is exactly why there are two components.
- **Client, optional**: the front end prefers `require('@deepseek-ai/dsh-client-ui-primitives')` (a baseline module in the
  shell's shared module table) for `StateDot` / `Tag` / `Tooltip` / `useDismissOnOutsidePointer`, and degrades to the
  built-in implementations when that require throws.

## 3. The i18n layer

All copy lives in the `tidewatch` locale namespace as flat `key → template` dictionaries (`{name}` placeholders), shipped
for `zh`, `en` and `ru` with an identical key set (enforced by the test suite). Three pieces make it work:

1. **A dictionary per language** plus a lookup that walks a fallback chain (active language → English) and substitutes
   `{name}` placeholders; an unknown key returns the key itself. `translateIn(localeId, key, params)` is the pure
   reference implementation.
2. **A live language source.** The card declares its namespace on the slot
   (`slots.register({ ..., locale: NS }, TideCard)`), so the framework injects a `t` seat and re-renders the outlet on
   every switch. Without the locale service the card falls back to the browser language and translates through
   `translateIn`.
3. **Language-aware formatting**, never string concatenation: `Intl.NumberFormat` for money (symbol placement, decimal
   separator, grouping) and compact token counts, and `Intl.NumberFormat` with `minimumIntegerDigits` for countdowns.

Two further notes:

- The language pack is optional: DSH ships only `zh` and `en`, so the plugin offers `ru` itself
  (`addLanguage({ id: 'ru', label: 'Русский', fallback: 'en' })`).
- The window table is **display-only localization**. `buildLocalSlots(atMs, timeZone)` maps the UTC windows onto the
  viewer's calendar day via `Intl.DateTimeFormat.formatToParts` (offset lookup) and emits contiguous phase segments;
  `localDayBounds` finds the local midnight.

## 4. Host interface mapping

| DSH concept | Purpose | Substitute in another host |
|---|---|---|
| `sessionProjections.register` | Session-level event folding (request/header, assistant/chunk usage) | The host's own streaming event hook |
| `useProjection('costUsage')` | Front-end subscription to the projection view | State management / an observable store |
| `ctx.locale` + `locale: NS` on a slot | Dictionary registration and the injected `t` seat | Any i18n runtime + observable active language |
| `conversation.composer.dock` / `shell.overlay` slots | Data-probe seat / root overlay seat | A container node near the input + a global overlay |
| `@deepseek-ai/dsh-client-ui-primitives` | Official shared UI primitives (module-table baseline) | The host's own widget library, or this plugin's built-ins |
| `--dsw-*` CSS variables | Theme following | Host theme variables or hard-coded light/dark pairs |

### Design tokens

The card is styled as a harbor tide gauge: a single saturated phase accent (amber = peak, green = off-peak), micro-caps
labels, and every figure in the host's mono stack (`--ds-font-family-code`) with tabular numerals. It reads its whole
palette from `--dsw-*` variables, and each plugin-local token (`--tw-surface`, `--tw-inset`, `--tw-line`, `--tw-text`,
`--tw-muted`, `--tw-faint`, `--tw-peak-soft`, `--tw-off-soft`) carries a **scheme-aware fallback**: light values by
default, dark values under `@media (prefers-color-scheme: dark)` and under `body[data-ds-dark-theme]`. That keeps the card
correct both inside DSH and on a host with no theme layer, and it avoids two classic mistakes — a hard-coded dark slab on a
light UI, and low-contrast accent text (the accent is mixed toward the text colour for anything that must be read, while
bars, dots and fills keep the pure accent). The panel deliberately uses `--dsw-alias-bg-layer-2`, not
`--dsw-alias-bg-overlay`: in the dark theme the latter is a flat mid-grey slab that reads as dead space behind dense
content.

## 5. Runbook and pitfalls

- **Changing prices — the one recurring task.** Update both `lib/pricing.js` (billing) and `DISPLAY_PRICES` in
  `lib/client.js` (display), and add the superseded tier as another historical era following the `priorPeak` /
  `priorOffPeak` example. Missing either half, or skipping the historical tier, silently reprices every replayed session.
  The test suite asserts that the two constant sets stay in sync.
- **Decide the phase in UTC.** The official windows are defined in UTC (01:00–04:00, 06:00–10:00); never judge in the
  browser's local zone, only render locally.
- **Bill by the event instant.** Use the instant attached to each call, not "now" recomputed for past calls, or amounts
  drift across phase switches and price changes.
- **Cache buckets.** `cacheReadTokens` / `cacheWriteTokens` bill at the cache-hit price; do not merge them into the
  cache-miss input bucket.
- **Half-open intervals.** Windows are `[start, end)`, so exactly 04:00:00 is off-peak.
- **Weekend rule.** Since 2026-08-23 Saturday and Sunday (UTC calendar days) are off-peak all day, and switch-point
  computation must skip weekends.
- **One dictionary key set.** Add a key to every dictionary or the suite fails; never concatenate translated fragments to
  build a sentence — use a `{placeholder}` template so each language controls word order.
- **Panel height.** The expanded panel's budget is measured from the badge's real top edge (`panelHeightBudget`) and
  applied inline; the CSS value is only a fallback for the first frame. Do not reintroduce a fixed `100vh` reserve — on a
  phone it either clips the panel or adds a scrollbar while space is still free.
- **Never put a `position: fixed` tooltip inside the panel.** The panel is both a scroll container (`overflow-y`) and —
  because of `backdrop-filter` — a containing block for fixed descendants, so a fixed bubble resolves in panel coordinates
  and inflates the scrollable overflow into a scrollbar with nothing to scroll (plus a layout shift). The DSH Tooltip
  renders exactly such a bubble as a sibling span, which is why the session-cost row uses a native `title`. Remove the
  panel's `backdrop-filter` before reintroducing an in-panel tooltip.
- **The sessions list publishes no `current`.** `useSessions` resolves to `ctx.sessions.list`, whose snapshot is
  `{ ids, byId, phase, projectionsBySession }`; selecting `s.current` is always `undefined`, so a strict ownership check
  silently discards every bridged value — which is what pinned the session cost to zero on dsh `0.2.0-rc.2`. Resolve the
  owner from the row the main view retains (`retainedBy.mainView`, see `sessionListCurrentId`) and keep the check tolerant;
  the probe clears the bridge on mount, so a session switch still cannot show a stale amount. Three regression checks in
  the suite guard this.

## 6. Where the checks live

`node test/verify.mjs` is the single source of truth for the checked behaviour: peak windows, billing eras, duplicated
constants, dictionary parity, translation and formatting, time zones, the panel height budget and the no-Chinese guard. Run
it — this file deliberately does not repeat the list, so the two cannot drift apart.

## 7. Releasing

Releases are cut from a version tag; `.github/workflows/release.yml` does the rest:

1. Bump `version` in `package.json`.
2. Add a matching section to `CHANGELOG.md` — the heading must be exactly `## v. <version>` (for example `## v. 2.1.0`).
   The workflow copies that section into the Release body verbatim, and fails the run if it is missing.
3. Commit, then tag and push:

   ```sh
   git tag v2.1.0
   git push origin v2.1.0
   ```

The workflow verifies that the tag matches `package.json`, runs `npm run check` and `npm test`, builds the tarball with
`npm pack`, and creates the GitHub Release with `dsh-tidewatch-<version>.tgz` attached. That tarball is what the README
offers as the pinned install URL.

There is no npm publish, deliberately. The npm name `dsh-tidewatch` belongs to the original author (1.0.6, 2026-08-22), so
publishing would force a rename or a scope and change the string users type for no functional gain: DeepSeek Harness
installs any pnpm spec, including a git tag (`github:proDreams/dsh-tidewatch#v2.0.0`) or the release tarball. Discovery in
this ecosystem runs on the GitHub `dsh-plugin` topic and the `dshhub` block in `package.json`, not on an npm listing. The
workflow header documents the exact steps to add npm later if that ever changes.

