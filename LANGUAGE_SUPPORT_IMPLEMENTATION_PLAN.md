# Telegram Drive Language Support — Execution Plan for Gemini 3.6 Flash

**Plan status:** Ready for implementation  
**Plan date:** 2026-07-25  
**Application baseline:** Path B / Quiet Utility redesign, with the desktop sponsor banner restored to its fixed bottom-end position  
**Implementation scope:** Internationalization architecture, complete UI translation coverage, locale formatting, RTL, public-share localization, sponsored-content localization, validation, and QA  
**Out of scope:** New product features, visual redesign, ad removal, theme removal, or changes to transfer/storage behavior

---

## 1. Instructions to the implementing model

This document is deliberately prescriptive so that Gemini 3.6 Flash can execute it safely without having to redesign the localization architecture while editing the product.

### 1.1 Execution contract

Gemini must follow these rules:

1. Work in the phase and batch order in this document. Do not combine phases to save time.
2. Before every batch, inspect the current version of every target file. The working tree already contains the Quiet Utility redesign; do not assume repository `HEAD` represents the UI that must be preserved.
3. Change only files named by the current batch, plus a directly required type/import file. If another file is required, state why before editing it.
4. Preserve all existing features and behavior. Localization is not authorization to refactor data fetching, authentication, uploads, downloads, sharing, ads, themes, proxy behavior, navigation, or state management.
5. Preserve all current theme capabilities: light mode, dark mode, system appearance, built-in presets, and user-created custom themes.
6. Preserve all ad functionality. The desktop banner must remain a fixed `300 × 250` unit at the bottom inline-end of the desktop viewport. Do not move it back into the top banner, workspace grid, or header. The authentication sponsor gateway and mobile sponsor surfaces must continue to work.
7. Never run `app/sync-keys.cjs`. It copies English into other locales and makes incomplete translations appear complete.
8. Never satisfy a validation failure by copying English text into a non-English locale, weakening the validator, deleting a key, or adding a broad allowlist entry.
9. Do not translate brand names, protocols, filenames, paths, URLs, extensions, API identifiers, or diagnostic logs unless this plan explicitly says to translate the surrounding user-facing sentence.
10. Use `apply_patch` for hand edits. Use formatting or generator scripts only for mechanical generated output.
11. Run the required checks at the end of every batch. Stop and repair a failed check before starting the next batch.
12. Do not claim that a locale has production-quality language review unless a fluent reviewer has actually reviewed it and the review is recorded. Model-generated translations must be marked `draft-machine`.
13. Keep a batch report using the template in Section 18. Do not report “complete” from file count alone.

### 1.2 First commands

Run these read-only checks before making language changes:

```bash
git status --short
cd app
npm run build
node check-i18n.cjs
```

Record the results in the first batch report. A dirty worktree is expected. Do not reset, revert, or overwrite the existing redesign changes.

### 1.3 Stop conditions

Stop the current batch and report the problem if any of the following occurs:

- A requested edit would remove or materially alter a feature.
- A target component has conflicting user changes that cannot be preserved.
- The desktop sponsor banner would move from its fixed bottom-end placement.
- Theme selection or custom-theme persistence stops working.
- A build or localization gate fails and the cause is not understood.
- A translation changes the legal/commercial meaning of sponsored disclosure, destructive actions, authentication, privacy, or sharing.
- A native/fluent review is required to call a locale release-ready but no reviewer is available. In that case, finish the engineering work, mark the locale `draft-machine`, and leave the release gate open.

---

## 2. Supported languages and release scope

The shipping language set remains exactly these 13 locales unless product scope is separately changed:

| Code | Language | Direction | System-locale aliases to resolve |
| --- | --- | --- | --- |
| `en` | English | LTR | `en`, all regional English variants |
| `es` | Spanish | LTR | `es`, all regional Spanish variants |
| `ru` | Russian | LTR | `ru` |
| `zh-CN` | Simplified Chinese | LTR | `zh`, `zh-CN`, `zh-SG`, `zh-Hans` |
| `fr` | French | LTR | `fr`, all regional French variants |
| `ar` | Arabic | RTL | `ar`, all regional Arabic variants |
| `pt-BR` | Brazilian Portuguese | LTR | `pt`, `pt-BR` |
| `de` | German | LTR | `de`, all regional German variants |
| `hi` | Hindi | LTR | `hi` |
| `id` | Indonesian | LTR | `id`, legacy `in` |
| `tr` | Turkish | LTR | `tr` |
| `ja` | Japanese | LTR | `ja` |
| `ko` | Korean | LTR | `ko` |

Unsupported system locales resolve to English. Do not silently resolve Traditional Chinese (`zh-TW`, `zh-HK`, `zh-Hant`) to Simplified Chinese; until a Traditional Chinese resource exists, fall back to English.

---

## 3. Verified baseline and current risks

The plan is based on the current post-redesign source, not on a generic localization checklist.

### 3.1 Current implementation

- `app/src/i18n/index.ts` statically registers all 13 JSON resources.
- `app/src/i18n/languages.ts` defines language code, native label, English label, and direction.
- `app/src/context/SettingsContext.tsx` stores a concrete language code and defaults to English.
- `app/src/App.tsx` changes i18next language and root `lang`/`dir` only after asynchronous settings load.
- The English resource currently has **332 leaf values**.
- `app/check-i18n.cjs` checks only normalized structural parity.
- `app/sync-keys.cjs` copies missing English strings into every locale.
- The release workflow builds the app but has no dedicated language-quality job.

### 3.2 Copied-English baseline

The existing resources are structurally similar but not translated to an acceptable level. Exact current identical-to-English counts are:

| Locale | Identical to English | Different from English |
| --- | ---: | ---: |
| Arabic | 223 / 332 | 109 |
| German | 232 / 332 | 100 |
| Spanish | 230 / 332 | 102 |
| French | 230 / 332 | 102 |
| Hindi | 223 / 332 | 109 |
| Indonesian | 230 / 332 | 102 |
| Japanese | 226 / 332 | 106 |
| Korean | 226 / 332 | 106 |
| Brazilian Portuguese | 230 / 332 | 102 |
| Russian | 226 / 332 | 106 |
| Turkish | 227 / 332 | 105 |
| Simplified Chinese | 226 / 332 | 106 |

Some identical values are legitimate technical invariants, but the majority are untranslated settings, sharing, navigation, and newer redesigned copy. Structural parity must never again be treated as translation completion.

### 3.3 Known source problems

- Hardcoded user-visible copy remains in authentication, app startup, dashboards, file actions, settings, viewers, transfers, ads, and public-share HTML.
- Frequently affected files include `MobileDashboard.tsx`, `AuthWizard.tsx`, `SettingsModal.tsx`, `TransferCenter.tsx`, `PdfViewer.tsx`, `AdaptiveMediaPlayer.tsx`, `ArchiveViewerModal.tsx`, and `DesktopDashboard.tsx`.
- The English resource is missing statically referenced keys:
  - `common.delete`
  - `settings.revoke`
  - `settings.update_available`
  - `settings.uploading`
- The existing plural checker omits `_two`, so it misreports valid Arabic forms.
- Dates and byte sizes are not consistently formatted with the selected app locale.
- `UploadQueue.tsx` and `DownloadQueue.tsx` each contain separate English-only size formatters.
- `TouchFileList.tsx` and `FileListItem.tsx` can show raw backend date strings.
- `SettingsModal.tsx` uses the operating-system locale through `toLocaleDateString()` instead of the selected app locale.
- Arabic sets root direction, but physical `left`/`right` layout assumptions and mixed-direction technical strings remain.
- `app/src-tauri/src/share_routes.rs` serves an English-only password page and English-only HTTP error bodies.
- Sponsored UI copy is not fully localized.
- Returning users can briefly see English because i18next initializes before settings are loaded.

---

## 4. Required end state

Language support is complete only when all of these statements are true:

1. Every visible shipping string is translated or narrowly documented as a brand/technical invariant.
2. All 13 locales render, switch, and persist without displaying raw keys.
3. Returning users do not see an English flash before their saved language is applied.
4. A “System language” option resolves supported operating-system locales predictably.
5. Plural forms and interpolation variables pass locale-aware validation.
6. Numbers, dates, sizes, rates, percentages, counts, and durations use the selected app locale.
7. Arabic is functionally mirrored and mixed-direction content remains readable.
8. Script glyphs render correctly on macOS, Windows, Linux, and Android.
9. Public share/password/error pages are localized.
10. Sponsor labels, countdowns, CTAs, failures, and accessibility text are localized without weakening disclosure.
11. CI blocks missing keys, copied-English placeholders, broken variables, invalid plurals, and newly hardcoded user-facing strings.
12. The redesigned feature set, ad behavior, and theme system are unchanged except for translated text, locale formatting, and intentional RTL mirroring.

---

## 5. Target file structure

Keep a single i18next `translation` resource for this rollout. Use nested top-level domains, but do **not** simultaneously migrate to i18next multi-file namespaces; that would add loading and typing risk without user benefit.

Create or replace these files:

```text
app/
  scripts/i18n/
    validate-locales.cjs
    scan-ui-literals.cjs
    generate-key-types.cjs
    generate-pseudo-locales.cjs
    shared.cjs
  src/i18n/
    index.ts
    languages.ts
    resolveLanguage.ts
    formatters.ts
    bidi.tsx
    translationKeys.generated.ts
    glossary.json
    review-status.json
    literal-allowlist.json
    invariant-allowlist.json
    locales/
      en.json
      es.json
      ru.json
      zh-CN.json
      fr.json
      ar.json
      pt-BR.json
      de.json
      hi.json
      id.json
      tr.json
      ja.json
      ko.json
```

Development-only pseudo-locales may be generated in memory or into `app/src/i18n/generated/`; they must not appear in the production language picker or count as shipping resources.

Use these top-level key domains in the JSON resources:

- `common`
- `auth`
- `navigation`
- `files`
- `folders`
- `transfers`
- `preview`
- `media`
- `archive`
- `share`
- `settings`
- `network`
- `updates`
- `errors`
- `ads`
- `accessibility`

Existing keys may remain in their current domain when moving them would produce unnecessary churn. New keys must use the closest domain above.

---

## 6. Translation key and copy rules

### 6.1 Key naming

- Use semantic keys, not English sentences: `transfers.cancel_all`, not `transfers.Cancel all`.
- Use lower snake case for leaf keys.
- Group related states under the same domain: `media.state_buffering`, `media.state_transcoding`.
- Use explicit action/state distinctions: `common.close`, `common.cancel`, `common.dismiss`, and `common.skip` are not interchangeable.
- Do not construct arbitrary keys from backend values. Map backend values through a typed object.
- Do not use `t(key) || 'English fallback'`; missing i18next keys return the key, so this pattern is ineffective and masks defects.
- Do not put punctuation outside a translated sentence when punctuation order could vary.

### 6.2 Interpolation

- Use i18next interpolation for variables: `{{name}}`, `{{count}}`, `{{version}}`, `{{date}}`, `{{port}}`.
- Keep the variable set identical across translations of a key, except an approved locale-specific plural form may omit `{{count}}` when the number is not spoken naturally.
- Never concatenate sentence fragments around a filename or count.
- Use `<Trans>` only when the translated sentence requires embedded React elements. Keep markup tags minimal and validator-approved.

### 6.3 Plurals

Use i18next suffixes required by `Intl.PluralRules(locale)`:

- English: `_one`, `_other`
- Arabic: `_zero`, `_one`, `_two`, `_few`, `_many`, `_other`
- Russian: `_one`, `_few`, `_many`, `_other`
- Other locales: use the categories reported by the runtime; do not invent English singular rules.

Validator tests must include:

- English: 0, 1, 2
- Arabic: 0, 1, 2, 3, 11, 100
- Russian: 1, 2, 5, 21, 22, 25
- French, Spanish, and Portuguese: 0, 1, 2, 1,000,000
- Chinese, Japanese, Korean, and Indonesian: representative values using their resolved categories

### 6.4 Invariants

Allow identical values only by exact key or exact approved token. Typical legitimate invariants are:

- `Telegram Drive`, `Telegram`, `Saved Messages` only if glossary review explicitly keeps the brand/product name
- `SOCKS5`, `HTTP`, `HTTPS`, `VPN`, `REST API`, `HLS`, `MP4`, `PDF`, `ZIP`, `RAR`, `7z`
- File extensions, keyboard keys, IP addresses, ports, URLs, hashes, API keys, and paths
- Units whose abbreviated symbol is intentionally invariant, after formatter review

Do not allowlist generic English UI words such as “Settings”, “Share”, “Close”, “Upload”, “Password”, or “Sponsored”.

---

## 7. Phase 0 — Baseline safety and inventory

**Goal:** Capture the current behavior before extraction. No user-facing source changes in this phase.

### Tasks

1. Run the baseline commands in Section 1.2.
2. Record the current leaf count and identical-to-English counts from Section 3.2.
3. Inventory every static `t()` key and resolve the four known missing English keys.
4. Inventory likely hardcoded UI literals in:
   - JSX text nodes
   - `title`, `placeholder`, `aria-label`, `aria-description`, and `alt`
   - `toast.*`, `confirm`, `prompt`, and alert-like APIs
   - native share title/body content
   - visible Rust HTML and HTTP error bodies
5. Identify whether `UploadQueue.tsx` and `DownloadQueue.tsx` are still imported. If they are dead, document them as dead source; do not delete them in the localization branch without a separate cleanup decision.
6. Capture manual before-state screenshots of the critical screens listed in Phase 10 for later layout comparison.

### Gate

- `npm run build` passes.
- No app source, locale, theme, or ad placement has changed.
- Inventory includes file path, line, literal, category, and disposition (`translate`, `invariant`, `developer-only`, or `dead-source`).

---

## 8. Phase 1 — Validator and CI foundation

**Goal:** Make incomplete language work measurable before adding more strings.

### 8.1 Replace the structural checker

Create `app/scripts/i18n/validate-locales.cjs`. Keep `app/check-i18n.cjs` as a small compatibility wrapper that imports/runs the new validator, or update all references and remove it only after confirming no scripts depend on it.

The validator must fail on:

1. Invalid JSON.
2. Missing or unexpected leaf keys relative to English.
3. Object/string type mismatches.
4. Empty or whitespace-only values.
5. Explicit draft markers such as `__TODO_TRANSLATE__` in a release run.
6. Required plural-category failures, including Arabic `_two`.
7. Interpolation-variable mismatches.
8. Disallowed HTML or unexpected `<Trans>` tags.
9. Locale file not represented in `languages.ts`, or registry entry without a locale file.
10. Non-English values identical to English unless the key/token is in `invariant-allowlist.json`.

The validator must print actionable output:

```text
[locale] [error type] translation.key — concise explanation
```

It must exit non-zero if any release-blocking error exists.

### 8.2 Literal scanner

Create `app/scripts/i18n/scan-ui-literals.cjs` using the installed TypeScript compiler API rather than regular expressions for the final gate. It must inspect:

- JSX text nodes containing letters.
- String literals in user-visible JSX attributes.
- First string arguments to toast/confirm/prompt/alert calls.
- User-visible fallback strings passed to translation calls.

Exclude:

- `src/components/dev/**`
- tests and generated files
- `console.*` and internal diagnostics
- CSS classes, event names, command names, file extensions, and URLs
- entries narrowly listed in `literal-allowlist.json`

Allowlist entries require exact file, exact literal or key, reason, and owner. The scanner must reject wildcard “all strings in this file” entries for shipping components.

### 8.3 Typed keys

Create `generate-key-types.cjs` to flatten `en.json` and write a generated string-literal union in `translationKeys.generated.ts`. Add a typed helper or react-i18next type augmentation so static unknown keys fail TypeScript compilation. Generated output must begin with a “do not edit” comment.

Dynamic settings tabs, transfer states, and error codes must use typed maps, for example:

```ts
const stateKey: Record<TransferState, TranslationKey> = {
  uploading: 'transfers.state_uploading',
  complete: 'transfers.state_complete',
  failed: 'transfers.state_failed',
};
```

### 8.4 Package scripts

Add these commands to `app/package.json`:

```json
"i18n:validate": "node scripts/i18n/validate-locales.cjs",
"i18n:scan": "node scripts/i18n/scan-ui-literals.cjs",
"i18n:types": "node scripts/i18n/generate-key-types.cjs",
"i18n:pseudo": "node scripts/i18n/generate-pseudo-locales.cjs",
"i18n:check": "npm run i18n:types && npm run i18n:validate && npm run i18n:scan"
```

The type generator must support `--check` so CI can verify committed generated output without rewriting the worktree. Use the mutating form locally and the check form in CI.

### 8.5 CI

Create `.github/workflows/i18n.yml` for pull requests and pushes to the main development branch:

1. Checkout.
2. Set up Node 20.
3. Run `npm ci` in `app`.
4. Run generated-key check.
5. Run `npm run i18n:validate`.
6. Run `npm run i18n:scan`.
7. Run `npm run build`.

Also add `npm run i18n:validate` before the build step in `.github/workflows/release.yml` so a release tag cannot bypass language validation.

### Gate

- The new tooling has self-tests or fixture tests for Arabic `_two`, missing variables, extra keys, copied English, and permitted invariants.
- `npm run i18n:check` passes only after existing debt is explicitly represented. During migration, use a checked-in baseline debt file with exact current findings; do not weaken rules. Each subsequent batch must reduce it, and Phase 9 removes it.
- `npm run build` passes.

---

## 9. Phase 2 — Language registry, startup, formatting, and bidi primitives

**Goal:** Establish safe shared behavior before migrating screen copy.

### Batch 2A — Registry and system-language resolution

Update `app/src/i18n/languages.ts`:

- Keep `SupportedLanguage` for the 13 actual resources.
- Add `LanguagePreference = 'system' | SupportedLanguage`.
- Add aliases, `dir`, `numberLocale`, `dateLocale`, and `fontFamily` to each registry entry.
- Export `getLanguageInfo(code)` and never duplicate `language === 'ar'` logic elsewhere.

Create `resolveLanguage.ts` with pure functions:

- `normalizeLocale(input: string): string`
- `resolveSupportedLanguage(input: string | readonly string[]): SupportedLanguage`
- `resolveLanguagePreference(preference, systemLocales): SupportedLanguage`

Unit-test the alias rules in Section 2, including the deliberate Traditional Chinese fallback to English.

### Batch 2B — Settings migration and no-English-flash startup

Update `SettingsContext.tsx`, `i18n/index.ts`, and the minimal app bootstrap code:

- Change stored setting type from `SupportedLanguage` to `LanguagePreference`.
- Existing concrete saved language values remain valid; do not overwrite them with `system`.
- New installations default to `system`.
- Resolve the stored preference before rendering user-facing copy. The current settings store is asynchronous, so render the existing neutral loading shell without localized text until settings are loaded and i18next has changed language.
- Alternatively, persist a small mirrored language preference in local storage for synchronous bootstrap, but the Tauri settings store remains authoritative and mismatch handling must be deterministic.
- Set `<html lang>` and `<html dir>` from the resolved registry entry before the main UI renders.
- Change `App.tsx` to use the resolved language, not the preference string and not a hardcoded Arabic comparison.
- Localize “Restoring session…” and image alt text, or keep the pre-language shell icon-only and accessible through a language-neutral busy state.
- Changing `system` language while the app is open should update when the platform exposes a language-change event; otherwise document that an app restart is required for a changed OS language.

Do not modify session restoration, authentication routing, sponsor-gateway routing, update checking, or dashboard selection.

### Batch 2C — Locale formatter module

Create `formatters.ts` with pure, testable functions that always receive the resolved locale:

- `formatNumber`
- `formatInteger`
- `formatPercent`
- `formatBytes`
- `formatTransferRate`
- `formatDate`
- `formatDateTime`
- `formatRelativeTime`
- `formatDuration`
- `formatList`

Requirements:

- Use `Intl` APIs.
- Keep file-size calculation binary and document the unit policy. If labels remain `KB/MB/GB`, treat them as approved technical abbreviations while localizing the numeric punctuation. If switching to `KiB/MiB/GiB`, do it consistently everywhere and call it out as a product-copy change.
- Invalid/unknown timestamps return a localized neutral placeholder, never `Invalid Date`.
- Transfer rates use the same number and unit policy as file sizes.
- Formatting uses the selected app locale, not the host default.

Migrate `app/src/utils.ts` to delegate to the shared formatter or remove only its formatting function after all imports move. Remove the duplicate local formatter functions in queue components only when those components are confirmed live and migrated.

### Batch 2D — Bidi primitives

Create `bidi.tsx`:

- `UserText` renders user-controlled names with `<bdi dir="auto">`.
- `TechnicalText` renders URLs, paths, IP addresses, ports, hashes, API keys, and protocol strings with `dir="ltr"` and `unicode-bidi: isolate`.
- Both accept normal inline React attributes and do not impose visual styling.

Add the minimal CSS needed for bidi isolation. Do not change theme colors or typography tokens.

### Gate for every Phase 2 batch

- Unit/pure-function tests pass.
- `npm run i18n:check` and `npm run build` pass.
- Language switch and persistence smoke tests pass.
- Light, dark, system, built-in, and custom themes still work.
- Desktop and mobile sponsor surfaces still work; fixed desktop banner placement is unchanged.

---

## 10. Phase 3 — English extraction in protected feature batches

**Goal:** Extract every shipping literal while minimizing feature risk.

### Required method for every batch

1. Inspect the component and identify its state/event handlers before editing copy.
2. Add/finalize English keys first.
3. Replace only user-visible literals and locale formatting.
4. Do not restructure handlers, hooks, or component trees unless required by `<Trans>` or bidi wrappers.
5. Add the same keys to all locales in the same batch. Draft translations are allowed only when marked `draft-machine` in review metadata; English copies are not allowed.
6. Run the batch-specific smoke test, localization checks, and build.
7. Compare against the Phase 0 screenshot for unintended layout or feature changes.

### Batch 3A — Startup, authentication, update, and error boundary

Target files:

- `app/src/App.tsx`
- `app/src/components/shared/AuthWizard.tsx`
- `app/src/components/shared/UpdateBanner.tsx`
- `app/src/components/shared/ErrorBoundary.tsx`

Extract all headings, instructions, labels, placeholders, validation errors, toasts, update states, retry actions, and accessibility labels. Authentication state transitions and Tauri command payloads must not change.

Smoke test: first run, API credentials, phone, code, 2FA password, invalid inputs, back navigation, successful authentication, session restore, update banner, and error fallback.

### Batch 3B — Sponsored/ad surfaces

Target files:

- `app/src/components/shared/AdGateway.tsx`
- `app/src/components/shared/AdsterraBanner.tsx`
- `app/src/components/desktop/dashboard/DesktopAdBanner.tsx`
- mobile ad/sponsor portions of `app/src/components/mobile/MobileDashboard.tsx`
- app-level sponsor thank-you toast in `app/src/App.tsx`

Add the `ads` domain for sponsored label, destination CTA, continue/skip, countdowns, auto-close, return, loading, failure, thank-you, dismiss, and screen-reader status.

Non-negotiable behavior:

- Do not remove ad impressions, click handling, timers, storage flags, disclosure, external navigation, or gateway gating.
- Keep desktop dimensions `300 × 250` and fixed bottom inline-end positioning.
- Use logical `end` for RTL placement while preserving the same viewport relationship.
- Do not place the desktop ad in the top banner or app header.

Smoke test: first authenticated gateway, countdown, sponsor click, continue, persisted gateway pass, desktop banner load/close/click, mobile banner, and thank-you toast.

### Batch 3C — Desktop shell and navigation

Target files:

- `app/src/components/desktop/DesktopDashboard.tsx`
- `app/src/components/desktop/dashboard/Sidebar.tsx`
- `SidebarItem.tsx`
- `TopBar.tsx`
- `BandwidthWidget.tsx`
- `EmptyState.tsx`
- `DragDropOverlay.tsx`
- `ExternalDropBlocker.tsx`

Extract navigation, connection/proxy states, search results, bandwidth labels, empty/loading states, drag/drop instructions, tooltips, and accessibility copy.

Smoke test: sidebar expand/collapse, folders/groups, Saved Messages, search, proxy indicator, view switching, drag overlay, and bandwidth display.

### Batch 3D — Desktop files and actions

Target files:

- `FileExplorer.tsx`
- `FileCard.tsx`
- `FileListItem.tsx`
- `ContextMenu.tsx`
- `MoveToFolderModal.tsx`
- `RenameFileModal.tsx`
- `RenameFolderModal.tsx`
- `RemoteUploadModal.tsx`
- `ShareDialog.tsx`

Extract all file actions, selection states, menus, confirmation copy, upload-by-URL copy, share settings, validation, expiration, and errors. Wrap file/folder names with `UserText`; wrap URLs with `TechnicalText`. Replace raw date/size display with shared formatters.

Smoke test: grid/list, sort, select, upload, download, remote upload, rename, move, delete, create/revoke share, password/expiration options, and keyboard/menu dismissal.

### Batch 3E — Transfers

Target files:

- `TransferCenter.tsx`
- live upload/download queue sources
- relevant transfer portions of `DesktopDashboard.tsx` and `MobileDashboard.tsx`

Extract headings, active/completed/failed/cancelled states, cancel/retry/clear actions, queue counts, rate/size/time labels, and live-region announcements. Use plural keys and formatter functions. Do not change transfer context state, cancel identifiers, concurrency, retry behavior, or event listeners.

Smoke test: active upload, active download, progress, rate, cancel one, cancel all, retry failed, clear finished, queue empty, completion, and persisted file list refresh.

### Batch 3F — Settings and custom themes

Target file:

- `app/src/components/desktop/dashboard/SettingsModal.tsx`
- any mobile settings UI implemented inside `MobileDashboard.tsx`

Extract every tab, heading, description, field, unit label, validation message, connection state, share management label, cache action, update state, proxy/VPN option, and appearance description.

Protected behavior:

- Preserve light, dark, and system appearance choices.
- Preserve all built-in theme presets.
- Preserve creation, editing, selection, preview, persistence, and deletion behavior for custom themes.
- Preserve proxy, VPN optimizer, REST API, cache/transcode, update, and performance settings.
- Use shared locale formatters for share creation/expiration dates.
- Keep technical values bidi-isolated.

Smoke test every settings tab, save/persist/reopen, reset, theme preview and custom theme round-trip, proxy validation, API-key copy/revoke, share revoke, cache clear, and update controls.

### Batch 3G — Mobile shell, files, and actions

Target files:

- `app/src/components/mobile/MobileDashboard.tsx` excluding already migrated ad/transfer blocks
- `TouchFileList.tsx`
- `ActionPopover.tsx`
- `BottomNavBar.tsx`
- `RenameFolderSheet.tsx`

Extract navigation, drawer, empty/loading/error states, selection and batch actions, prompts, toasts, move/rename/delete/share flows, transfer labels, and accessibility copy. Replace raw dates and English “Sync” fallback with localized/locale-formatted output.

Smoke test: drawer, folder navigation, back behavior, bottom tabs, grid/list if supported, long press/select, move/rename/delete/share, deep links, Android share intent, upload/download, transfer queue, and action sheet dismissal.

### Batch 3H — Preview, media, PDF, and archive

Target files:

- `PreviewModal.tsx`
- `MediaPlayer.tsx`
- `AdaptiveMediaPlayer.tsx`
- `PdfViewer.tsx`
- `ArchiveViewerModal.tsx`
- `QualitySelector.tsx`
- `VideoMetaBadge.tsx` if it contains user-visible labels

Extract all loading, conversion, streaming, quality, page, zoom, rotate, fullscreen, password/error, archive tree, selection, extraction, size, and status text. Use typed maps for backend phases. Do not translate codec names, formats, or actual filenames.

Smoke test: images, audio, direct video, adaptive/transcoded video, subtitles if present, PDF paging/zoom/rotate, archives of every supported type, archive extraction, error/retry, and close/reopen.

### Batch 3I — Shared accessibility and residual scan

Run the AST literal scanner across all shipping TS/TSX. Resolve every remaining finding as:

- translated,
- exact approved invariant,
- developer-only,
- or verified dead source.

`app/src/components/dev/DesignGallery.tsx` is developer-only and can use fixture labels, but any component rendered inside it must still receive translated production copy.

### Phase 3 gate

- Literal scanner has zero unexplained shipping findings.
- All four known missing keys exist in English and all locales.
- `npm run i18n:check` and `npm run build` pass.
- All batch smoke tests pass with no feature regression.

---

## 11. Phase 4 — Complete and review all 12 non-English resources

**Goal:** Replace copied English and draft-quality language with complete, reviewable translations.

### 11.1 English copy freeze

Before final translation:

1. Freeze English keys and source meaning.
2. Use sentence case consistently.
3. Standardize Upload, Download, Transfer, Queue, Folder, Channel, Share link, and Saved Messages terminology.
4. Keep ordinary UI concise; keep exact technical terminology in advanced settings.
5. Add translator notes for ambiguous, destructive, privacy-sensitive, security-sensitive, and sponsor-related strings.

### 11.2 Glossary

Populate `glossary.json` with source term, definition/context, translate/do-not-translate rule, and approved term per locale for at least:

- Telegram Drive
- Saved Messages
- folder versus Telegram channel
- upload, download, transfer, queue, sync
- share link, public/private, protected, revoked, expired
- proxy, SOCKS5, HTTP, VPN, data center
- REST API, API key, localhost
- cache, transcode, HLS, variant, original
- sponsor, sponsored content, continue, skip, dismiss

### 11.3 Translation order

For each locale, translate/review in this order:

1. Authentication, destructive actions, privacy/security, sharing, and sponsored disclosure.
2. Navigation, files/folders, selection, upload/download, and transfers.
3. General settings and connection state.
4. Proxy, VPN, REST API, cache, transcode, and diagnostics.
5. Viewers, archive states, updates, help, and secondary copy.

### 11.4 Review metadata

`review-status.json` must record per locale and per domain:

```json
{
  "status": "draft-machine | fluent-reviewed | native-reviewed",
  "reviewer": "name-or-empty",
  "reviewedAt": "ISO-date-or-empty",
  "englishSourceVersion": "git-commit-or-copy-version",
  "notes": []
}
```

Gemini may produce a complete first draft, but it must use `draft-machine`. Authentication, deletion, privacy, sharing, sponsor disclosure, proxy/VPN security, and public-share copy cannot be considered release-ready without fluent review.

### 11.5 Linguistic QA priorities

- Arabic: grammar, dual/few/many plurals, neutral professional tone, RTL word order, sponsor disclosure.
- Russian: count cases and long labels.
- German: compound length and button truncation.
- French/Spanish/Portuguese: natural product terminology and grammatical gender/number.
- Turkish: suffixes around interpolated variables.
- Hindi: natural technical terminology rather than excessive transliteration; conjunct rendering.
- Chinese/Japanese/Korean: concise native phrasing, correct punctuation, avoid literal English word order.
- Indonesian: natural action labels and single-category plural behavior.

### Gate

- Validator reports zero copied-English values outside the exact invariant allowlist.
- No empty/draft marker/missing/extra key exists.
- Every domain has review metadata.
- Draft translations are clearly distinguished from human-reviewed translations.

---

## 12. Phase 5 — RTL and mixed-direction implementation

**Goal:** Make Arabic fully functional, not merely right-aligned.

### 12.1 Logical layout migration

Scan all shipping source for physical direction utilities and CSS:

```bash
rg -n "(left|right|ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|text-left|text-right)-" src
```

For logical relationships, migrate:

- `left/right` to `start/end`
- `ml/mr` to `ms/me`
- `pl/pr` to `ps/pe`
- physical border/radius to inline-start/inline-end variants
- `text-left/right` to `text-start/end`

Keep physical direction only for genuine screen/media coordinates. Document each retained physical direction in a narrow RTL allowlist or code comment.

Priority surfaces:

1. Desktop sidebar, top bar, breadcrumbs, context menus, dialogs, and fixed sponsor banner.
2. Mobile drawer, action sheet/popover, header/back behavior, bottom navigation, and sponsor slot.
3. File selection indicators, lists/cards, transfer progress/status, and settings forms.
4. Media transport controls, PDF controls, archive navigation, and tooltips.

### 12.2 Icon and motion rules

- Mirror back/forward, previous/next, breadcrumb separators, and drawer-edge chevrons when they represent reading/navigation direction.
- Do not mirror search, settings, download, upload, play, pause, volume, or universal file icons.
- Transfer arrows represent upload/download semantics, not reading direction; keep their semantic direction.
- Reverse slide/sheet transitions that enter from the logical start/end edge.

### 12.3 Bidi isolation rollout

Use `UserText` for filenames, folders, channels, usernames, and other user-controlled labels. Use `TechnicalText` for URLs, IPs, ports, paths, hashes, API keys, and protocol strings. Test Latin technical strings embedded in Arabic sentences at both ends of a sentence and beside punctuation.

### 12.4 Arabic workflow test

Test authentication, sponsor gateway, desktop shell, fixed sponsor banner, folder navigation, file selection, every context action, settings, custom themes, share generation, transfer queues, all viewers, dialogs, mobile drawer, mobile action sheet, and public share pages.

### Gate

- No accidental horizontal scroll at supported window sizes.
- Focus order follows DOM/logical order.
- Tooltips, menus, and dialogs anchor correctly.
- Filenames and technical values are readable and do not reorder punctuation.
- Desktop sponsor banner stays fixed at bottom inline-end and does not cover the header/banner region.

---

## 13. Phase 6 — Public share/download localization

**Goal:** Localize the Rust-served user experience without changing streaming/security behavior.

Target file:

- `app/src-tauri/src/share_routes.rs`

Do not localize `AD_BANNER_HTML` in `server.rs`; its `<title>` is not product UI and the ad creative controls its own language. Do not change stream range handling, cookies, password hashing, route paths, status codes, Telegram resolution, or media response behavior.

### Implementation design

1. Add a small Rust locale registry/messages module used only by share routes.
2. Resolve locale in this order:
   - explicit safe `lang` query parameter on the share link, if present and supported;
   - `Accept-Language` quality values and alias matching;
   - English fallback.
3. Preserve the locale through the password POST. Prefer a hidden validated locale field or query parameter; never trust it as raw HTML.
4. Localize:
   - document title
   - password heading/instruction/placeholder/button
   - incorrect password
   - link not found/revoked/expired
   - internal error
   - Telegram not connected
   - folder/file lookup failure
   - download/stream failure that is shown to the user
5. Escape filename, token, locale, and error values before inserting them into HTML. Current string interpolation must not become an XSS vector.
6. Set `<html lang="…" dir="…">`.
7. Use logical CSS (`text-align: start`, logical margins/padding where applicable).
8. Wrap the filename in `<bdi dir="auto">`.
9. Keep logs in English with technical detail; user responses use localized safe messages.
10. Add Rust tests for language parsing, fallback, HTML escaping, direction, valid page, password failure, revoked, expired, missing, and disconnected states.

If share URLs are created by the frontend, include the currently resolved locale in newly generated links without invalidating existing links. Existing links without a language continue to use `Accept-Language`/English fallback.

### Gate

- Rust tests and `cargo check` pass.
- Valid/password/expired/revoked/missing flows work in English, Arabic, and one additional LTR locale.
- Streaming, range requests, cookies, and link compatibility are unchanged.

---

## 14. Phase 7 — Error-code localization boundary

**Goal:** Stop expected backend failures from surfacing as raw English while preserving useful diagnostics.

Do this incrementally; do not rewrite every Rust error in one batch.

### Design

For expected user-recoverable errors, return a stable code plus safe structured data. Example shape:

```ts
type AppErrorPayload = {
  code: 'download.empty' | 'share.revoked' | 'auth.invalid_code';
  args?: Record<string, string | number>;
  technical?: string;
};
```

Frontend behavior:

- Map `code` through a typed `ERROR_TRANSLATION_KEYS` object.
- Interpolate only safe args.
- Log technical detail separately.
- For legacy/unexpected string errors, show a localized generic error and retain raw detail only in logs or an explicit technical-details disclosure.

Migration order:

1. Authentication.
2. Upload/download and remote upload.
3. Share creation/revocation.
4. Preview/media/archive.
5. Proxy/network settings.

Do not change command names, success payloads, retry behavior, or transport behavior while introducing error codes.

### Gate

- Expected failures in the migrated domain show localized messages.
- Logs retain enough information for support.
- Unknown errors never render raw backend English as the primary message.
- Existing command consumers and feature smoke tests pass.

---

## 15. Phase 8 — Typography and script coverage

**Goal:** Ensure every supported script renders reliably without destabilizing the visual design.

### Tasks

1. Define script-aware fallback stacks through the language registry or root language data attributes.
2. Test Latin/Cyrillic, Arabic, Devanagari, Simplified Chinese, Japanese, and Korean on macOS, Windows, Linux, and Android.
3. Prefer reliable platform-native script fonts first.
4. Bundle WOFF2 subsets only when Linux/Android testing proves fallback unreliable. Measure asset size before committing.
5. Verify regular, medium, semibold, and bold behavior; avoid faux bold where it degrades Arabic or CJK.
6. Check line height, Arabic diacritics, Devanagari conjuncts, CJK punctuation, ellipsis, numerals, and mixed-script filenames.
7. Do not truncate security/destructive labels so aggressively that actions become ambiguous.

### Gate

- No missing-glyph boxes.
- No clipped diacritics/conjuncts.
- Layout remains consistent with Quiet Utility density.
- Font changes do not alter theme tokens or custom theme behavior.

---

## 16. Phase 9 — Pseudo-locales and debt removal

**Goal:** Make future language regressions cheap to detect.

### Pseudo-locales

Create development-only:

- `en-XA`: accented, bracketed, and expanded by roughly 35% while preserving placeholders and tags.
- `ar-XB`: forced RTL/mirrored markers while preserving placeholders and technical tokens.

Integrate them into the development design gallery through a dev-only selector or query parameter. They must not appear in production resources or the shipping settings picker.

### Debt removal

- Resolve every entry in the Phase 1 baseline debt file.
- Delete the baseline debt file once empty.
- Remove/disable `sync-keys.cjs`, or replace it with a scaffold command that inserts an explicit non-shipping draft marker and never passes release validation.
- Remove obsolete localization allowlist entries.
- Regenerate typed keys and require clean `--check` output.

### Gate

- Expanded pseudo copy reveals no clipped critical action.
- RTL pseudo mode reveals no physical-layout regression.
- Language validator and literal scanner pass with no baseline exceptions.

---

## 17. Phase 10 — Full verification matrix

### 17.1 Critical screens for every locale

Capture and inspect:

1. Authentication API setup, phone/code, and 2FA.
2. Sponsor gateway.
3. Desktop file workspace with the fixed sponsor banner visible.
4. Desktop grid, list, selection toolbar, context menu, and search.
5. Transfer center with active, failed, and completed items.
6. Settings overview, appearance/custom theme, proxy/VPN, sharing, REST API, cache, and update panels.
7. Share dialog with password and expiration.
8. Preview/media/PDF/archive states.
9. Mobile files, drawer, bottom navigation, action popover, settings, transfers, and sponsor slot.
10. Public share password, expired, revoked, and download pages.

### 17.2 Functional matrix for every locale

- First launch/system-language resolution.
- Explicit language switch and restart persistence.
- Authentication and sponsor gateway.
- Folder create/rename/delete and group editing.
- Upload, download, remote upload, selection, move, rename, delete, and share.
- Loading, empty, error, offline, and retry states.
- Transfer progress/count/rate/size/duration formatting.
- Settings inputs, descriptions, validation, diagnostics, and persistence.
- Custom theme create/edit/select/restart/delete.
- Media, PDF, and archive workflows.
- Dates, sizes, rates, percentages, long filenames, mixed scripts, and technical strings.
- Light, dark, system, built-in, and custom themes.
- Reduced motion and performance mode.

### 17.3 Platform/layout matrix

- Desktop: compact supported window and large window on Windows, macOS, and Linux.
- Android: portrait, landscape where supported, safe areas, software keyboard, drawer, action sheets, bottom navigation, share intent, and sponsor banner.
- Arabic: entire RTL suite on desktop and Android.
- Arabic, Hindi, Chinese, Japanese, and Korean: font/script review.
- German, Russian, French, Spanish, Portuguese, and Turkish: text-expansion/truncation review.

### 17.4 Accessibility

- Screen reader announces translated control names and live transfer states.
- Language switch updates root `lang` and `dir`.
- Focus order is logical in LTR and RTL.
- Icon-only controls have localized accessible names.
- Sponsor content is clearly disclosed to sighted and screen-reader users.
- Error/validation text is associated with its field and is not color-only.

### Final automated commands

```bash
cd app
npm run i18n:check
npm run build
cd src-tauri
cargo check
cargo test
```

Run relevant manual app smoke tests after these commands; a passing build does not prove language quality or feature preservation.

---

## 18. Required batch report format

Gemini must produce this report after every batch:

```markdown
## Language batch report — <phase/batch>

### Scope completed
- <exact items>

### Files changed
- <path>: <reason>

### Translation changes
- English keys added/changed: <count and domains>
- Locales updated: <list>
- Review status: <draft-machine/fluent-reviewed/native-reviewed>

### Behavior-preservation checks
- Authentication: pass / not in scope / fail
- Upload/download/transfers: pass / not in scope / fail
- Sharing: pass / not in scope / fail
- Ads: pass / not in scope / fail
- Light/dark/system/custom themes: pass / not in scope / fail
- Desktop fixed ad placement: pass / not in scope / fail

### Automated checks
- npm run i18n:check: pass/fail
- npm run build: pass/fail
- Rust checks if applicable: pass/fail/not in scope

### Manual checks performed
- <workflow and result>

### Remaining risks or blockers
- <specific item; never say “none” unless all relevant checks actually ran>

### Next allowed batch
- <one batch identifier only>
```

---

## 19. Release acceptance checklist

Engineering complete:

- [ ] All 13 resources are registered and resolve correctly.
- [ ] System-language selection and existing-setting migration work.
- [ ] No startup English flash occurs.
- [ ] Unknown translation keys fail TypeScript or validation.
- [ ] Locale validator passes with no debt baseline.
- [ ] Literal scanner passes with narrow reviewed allowlists.
- [ ] Plural and interpolation tests pass.
- [ ] Shared locale formatters are used everywhere user-visible.
- [ ] Arabic RTL and bidi isolation pass.
- [ ] Public share pages are localized and escaped safely.
- [ ] Expected backend errors use localized stable codes.
- [ ] Sponsor copy is localized and all ad functionality remains.
- [ ] Light, dark, system, built-in, and custom themes remain functional.
- [ ] Desktop sponsor banner remains fixed at bottom inline-end and does not cut into the top banner.
- [ ] Desktop, Android, reduced-motion, and performance-mode smoke tests pass.

Language release ready:

- [ ] No non-English shipping locale contains unapproved copied English.
- [ ] High-risk domains have fluent/native review.
- [ ] Reviewer and source-version metadata are complete.
- [ ] Screenshot/layout review is complete for every locale.
- [ ] Script/font review is complete on all target platforms.
- [ ] No raw key, missing glyph, clipping, overlap, or unintended horizontal scroll remains.

The language release must not be declared “perfect” until both checklists are complete. Gemini can complete the engineering and draft-translation work, but human linguistic review remains a real release requirement for high-risk copy.

---

## 20. Recommended implementation sequence summary

Execute in this exact order:

1. Phase 0: inventory and screenshots.
2. Phase 1: validator, literal scanner, typed keys, and CI.
3. Phase 2: language registry, system preference, startup, formatters, and bidi primitives.
4. Phase 3A–3I: extract and migrate English/product copy in protected feature batches.
5. Phase 4: complete all locale resources, glossary, and review metadata.
6. Phase 5: complete RTL and mixed-direction work.
7. Phase 6: localize Rust public-share surfaces.
8. Phase 7: migrate expected backend errors by domain.
9. Phase 8: verify and correct script typography.
10. Phase 9: pseudo-locales and removal of all temporary debt exceptions.
11. Phase 10: full automation, workflow, platform, visual, accessibility, and human-language QA.
12. Ship only when Section 19 is fully satisfied.
