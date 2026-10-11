> Fork history starts at 2.0.0. Versions 1.0.x–1.1.x belong to the original project:
> [KhalilYamber/dsh-tidewatch](https://github.com/KhalilYamber/dsh-tidewatch).

## v. 2.0.1

- **Fixed the session cost on dsh 0.2.0-rc.2**:
    - The card keyed its bridge ownership on `sessions.current`, a field the sessions-list snapshot no longer publishes
      (it is now `{ ids, byId, phase, projectionsBySession }`). The owner never matched the probe's session id, so `usage`
      stayed `null` and the cost was pinned to `0.0000`, while the phase and the countdown — which never read `usage` —
      kept rendering correctly.
    - The owner is now resolved from the row the main view retains (`retainedBy.mainView`), and the check stays tolerant:
      when the list cannot tell, the card trusts the probe, which clears the bridge on mount so a session switch still
      cannot surface a stale amount.
    - Reported and fixed by [@sh-222](https://github.com/sh-222) in
      [#1](https://github.com/proDreams/dsh-tidewatch/pull/1).
- **Tests**: three regression checks in `node test/verify.mjs` (73 passed).

## v. 2.0.0

- **Real i18n instead of hard-coded Chinese**:
    - The card now reads all copy through the DeepSeek Harness `locale` service: it registers its own `tidewatch`
      namespace and declares it on the badge slot, so the framework injects the `t` seat and re-renders the card on every
      language switch.
    - Ships `zh`, `en` and `ru` dictionaries with an identical key set; the test suite fails if they drift apart.
    - Offers Russian to the shared language catalog, so «Русский» appears in Settings → Language. Other plugins resolve
      it through the English fallback.
    - On a shell without the locale service the card falls back to the browser language instead of one hard-coded
      language, and it never declares a locale seat it cannot serve.
    - Every string is a `{placeholder}` template: copy is never assembled from translated fragments.
- **Local-time window table**:
    - The official UTC windows are mapped onto the viewer's own calendar day and rendered with `Intl`; the tier itself is
      still decided in UTC (the official definition).
    - `Intl` formatting for money, compact token counts and zero-padded countdowns — Russian gets a decimal comma and its
      own compact suffixes, Chinese its own compact units.
    - The default currency now follows the interface language: Chinese → CNY, otherwise USD. An explicit choice is
      remembered.
- **Redesigned card (tide gauge)**:
    - Elevated glass panel instead of the flat `bg-overlay` slab, micro-caps labels and mono figures with tabular
      numerals; the phase accent (amber or green) is the only saturated colour.
    - A "tide line" shows how much of the current phase has elapsed, the active row gets a `NOW` marker with an accent
      bar, and every row carries a phase pill.
    - Segmented currency control and an SVG disclosure chevron.
    - Theme tokens keep scheme-aware fallbacks, so the card is correct in light and dark themes and on hosts without a
      theme layer.
- **Accessibility**:
    - The badge and the disclosure rows are real buttons with focus rings and `aria-expanded` / `aria-pressed` states;
      the tide line exposes a `progressbar` role.
- **Fixed**:
    - Phantom scrollbar on hover over the session-cost row: the official `Tooltip` renders a `position:fixed` bubble as a
      sibling, and the panel is both a scroll container and — because of `backdrop-filter` — a containing block for fixed
      descendants, so the bubble inflated the panel's scrollable overflow. The row now uses a native `title`.
    - On phones the expanded panel could exceed the space above the badge: its height budget is now measured from the
      badge's real top edge, and `scrollbar-gutter: stable` keeps a real scrollbar from shifting the layout.
- **Docs**:
    - README rewritten as English (default) and Russian (`README-RU.md`), with screenshots rendered from the real bundle.
    - All Chinese copy removed from the code, metadata and docs — only the `zh` dictionary keeps Chinese, and the test
      suite now guards the READMEs as well.
    - `docs/PORTING.md` rescoped to the portable core, the DSH wiring, the host-interface mapping and the maintenance
      runbook.
- **Detached from the original fork**:
    - `repository`, `homepage` and `bugs` now point at `proDreams/dsh-tidewatch`.
    - `LICENSE` keeps the original copyright notice and adds the fork author's; `README.en.md` was dropped in favour of
      the English default `README.md`.
- **Releases**:
    - A version tag now produces a GitHub Release with the `CHANGELOG.md` section as its body and an installable
      `dsh-tidewatch-<version>.tgz` attached, so installs can be pinned without a registry.
    - No npm publish: the npm name `dsh-tidewatch` belongs to the original author, and DeepSeek Harness installs git tags
      and tarballs natively.
- **Tests**: `node test/verify.mjs` grew from 39 to 70 checks. It now materializes the real client bundle against a stub
  React and a fake plugin context, covering the dictionaries, the fallback chain, `Intl` formatting, the time-zone window
  table and the panel height budget.
