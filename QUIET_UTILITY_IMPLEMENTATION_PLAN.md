# Telegram Drive — Path B “Quiet Utility” Implementation Plan

## 1. Status and intent

**Selected direction:** Path B — Quiet Utility redesign.

This plan upgrades Telegram Drive’s design system, desktop and mobile shells, core file workflows, settings, onboarding, transfers, and sponsored surfaces without changing the underlying Telegram, storage, streaming, sharing, upload, download, proxy, VPN, REST API, or update behavior.

The redesign must feel calm, capable, and trustworthy. It should borrow the discipline of modern OpenAI, Anthropic, and Apple products without copying their branding or turning a file manager into a chat interface.

Language completion and RTL work are defined separately in `LANGUAGE_SUPPORT_IMPLEMENTATION_PLAN.md`. The two plans share the same primitives, layout rules, and release gates.

## 2. Non-negotiable constraints

1. No current product capability may be removed or silently changed.
2. Existing Rust commands, React Query behavior, Telegram connection logic, transfer hooks, streaming hooks, and settings persistence remain the behavioral source of truth.
3. Presentation components may be replaced incrementally, but controller logic must not be rewritten merely to support a visual change.
4. All sponsored/ad functionality stays in the product:
   - One-time post-authentication sponsor gateway.
   - Desktop 300×250 sponsored placement.
   - Desktop click-through, sandboxing, recurrence, countdown, hover pause, and auto-dismiss behavior.
   - Android sponsored banner, click-through, visibility behavior, and persisted dismissal.
   - Existing sponsor URLs and provider integrations unless a separate product decision changes them.
5. Reduced-motion and performance modes remain supported.
6. Light, dark, and custom theme data remain backward compatible. The default UI can become more curated, but stored user themes must migrate safely.
7. Desktop remains the primary productivity surface; mobile remains a touch-native companion rather than a scaled desktop layout.
8. Each migration phase must compile, pass its parity checks, and remain releasable.

## 3. Product principles

### 3.1 Content first

Files, folders, previews, and transfer state carry the visual weight. Chrome, borders, gradients, and blur remain subordinate.

### 3.2 Progressive disclosure

Show the primary action and current context. Move infrequent, destructive, diagnostic, and appearance actions into contextual menus or settings.

### 3.3 Quiet depth

Use mostly solid content surfaces. Use translucent material for navigation, toolbars, sheets, media controls, and transient overlays. Shadows indicate actual elevation rather than decoration.

### 3.4 Predictable behavior

Every button, field, menu, list row, card, dialog, sheet, and selection state must come from a documented primitive with the same focus, disabled, loading, error, and motion behavior.

### 3.5 Platform-aware, product-consistent

Desktop uses precision input, keyboard commands, contextual toolbars, and resizable layouts. Mobile uses safe areas, large targets, bottom sheets, direct manipulation, and native sharing. Both surfaces use the same tokens, terminology, status model, and settings schema.

### 3.6 Trust by default

Authentication, sharing, destructive actions, sponsored content, and connection diagnostics must clearly state what will happen. A primary button must never disguise an advertisement or destructive operation.

## 4. Target visual system

### 4.1 Color

- Telegram blue becomes the default interaction accent.
- Amber becomes a semantic warning/bandwidth color and an optional small brand flourish.
- Dark mode uses neutral graphite/ink surfaces rather than blue-tinted surfaces at every level.
- Light mode uses a warm off-white canvas with white or near-white raised surfaces.
- Status colors are independent of the user’s accent/custom theme.
- Contrast is verified per state rather than inferred from opacity.

### 4.2 Typography

Define roles rather than scattered Tailwind sizes:

- `display`: onboarding and major empty-state title.
- `title`: page/window title.
- `heading`: section heading.
- `body`: standard interface copy.
- `label`: control and navigation labels.
- `metadata`: dates, sizes, transfer rates, secondary status.
- `code`: API keys, IP addresses, hashes, technical values.

The default body size must not fall below 13px on desktop or 14px on mobile. Ten- and eleven-pixel copy is limited to exceptional badges after legibility review.

### 4.3 Spacing and density

- Adopt a base spacing scale and stop introducing arbitrary gaps.
- Support comfortable and compact desktop densities through tokens rather than per-component overrides.
- Mobile retains one touch density with minimum 44–48px interactive targets.

### 4.4 Radius and elevation

- Use three primary radii: control, container, and overlay.
- Pills are reserved for tags, segmented controls, statuses, and true capsule actions.
- Use a small semantic elevation scale: flat, raised, floating, modal.

### 4.5 Motion

- Fast feedback: 120–160ms.
- Menus/popovers: 160–200ms.
- Sheets/dialogs/navigation: 200–260ms.
- Springs only when an element moves through space and momentum helps explain the transition.
- No universal card lift or button scale treatment.
- Reduced-motion variants preserve state changes without spatial movement.

## 5. Design-system architecture

### 5.1 Token layers

Create the following layers under `app/src/design/` or `app/src/theme/`:

1. **Foundation values:** raw neutral, accent, and status palettes.
2. **Semantic color tokens:** canvas, sidebar, surface, raised surface, hover, selected, border levels, text levels, accent, focus, overlay, success, warning, danger, information.
3. **Component tokens:** control heights, navigation row height, file tile dimensions, toolbar height, dialog widths, sheet radii.
4. **Non-color tokens:** spacing, typography, radii, elevation, opacity, z-index, and motion.
5. **Theme adapters:** dark, light, system, built-in legacy presets, and migrated custom themes.

Theme names must no longer be embedded in component semantics. Components consume `surface-raised`, `text-secondary`, or `border-subtle`, not `telegram-surface` when the value represents a generic UI role.

### 5.2 Primitive components

Create a focused `app/src/components/ui/` layer:

- `Button`, `IconButton`, and `ButtonGroup`
- `Input`, `SearchField`, `TextArea`, `Select`, and `NumberField`
- `Switch`, `Slider`, `SegmentedControl`, and `Checkbox`
- `Tooltip`, `Menu`, `ContextMenu`, and `Popover`
- `Dialog`, `AlertDialog`, `Sheet`, and `Drawer`
- `Tabs` and `SettingsNavigation`
- `Card`, `ListRow`, `Section`, and `Divider`
- `Badge`, `StatusDot`, `Progress`, `Skeleton`, and `EmptyState`
- `Toolbar`, `Breadcrumbs`, and `CommandMenu`
- `FileTile`, `FileRow`, `FolderTile`, and `SelectionControl`

Every primitive has an explicit state contract and is usable in LTR, RTL, keyboard, reduced-motion, light, dark, and high-contrast contexts.

### 5.3 Development gallery

Add a development-only component gallery that renders every primitive and major state without requiring a live Telegram connection. It will be used for:

- Visual review.
- Theme review.
- All-language text expansion review.
- RTL review.
- Automated screenshot tests.
- Ad fixture review without loading production ad scripts.

The gallery must not be included in normal production navigation.

## 6. Target information architecture

### 6.1 Desktop

**Sidebar**

- Product identity and collapse control.
- Saved Messages, folders, and groups.
- Group editing and folder drag/reorder behavior.
- Optional secondary destinations such as Transfers and Shared Links.
- Connection/storage summary available without placing critical actions at the bottom edge.

**Primary toolbar**

- Current location/title and breadcrumb.
- Search/command search.
- Primary Upload action.
- New Folder and secondary actions in a compact adjacent menu.
- View options menu for grid/list, density, sort, and thumbnail scale.
- Settings and theme leave the main file toolbar.

**Selection toolbar**

When selection begins, the standard toolbar changes into a contextual action bar. Move, download, share, delete, and clear-selection do not accumulate beside the standard toolbar actions.

**Content workspace**

- Folder section where appropriate.
- Thumbnail-led media tiles.
- Compact generic file tiles/rows.
- Optional preview/inspector pane on sufficiently wide windows.
- Clear empty, loading, offline, error, drag-target, and search states.

**Activity/transfer center**

- Upload and download queues live in a consistent activity surface.
- Active, completed, failed, cancelled, retry, cancel-all, and clear-finished behavior remains intact.

**Settings**

- Replace the narrow six-tab modal with a larger settings surface and left-side category navigation.
- General, Appearance, Transfers, Network/Proxy, VPN, Sharing/API, Storage, Updates, and About remain available.
- Advanced and diagnostic controls are grouped away from everyday preferences.

### 6.2 Mobile

- Safe-area-aware top toolbar with current location and focused actions.
- Edge-to-edge file/folder rows with separators instead of a large card around every row.
- Stable bottom navigation anchored to the safe area.
- Contextual actions use bottom sheets.
- Selection uses a contextual top or bottom action surface with touch-size targets.
- Transfers is a real queue view rather than only an empty-state explanation.
- Settings is driven by the shared settings schema and mobile section components.
- The folder drawer uses logical leading-edge placement and mirrors correctly in RTL.

## 7. Sponsored/ad experience plan

All current ad capabilities remain. The redesign changes their presentation, clarity, and layout safety.

### 7.1 Shared ad architecture

Create a small sponsored-content layer with:

- Shared state names for idle, loading, opened, dismissible, dismissed, and failed.
- Shared `SponsoredLabel`, countdown, CTA, and accessibility copy.
- Shared layout tokens and localization keys.
- A development fixture mode that never calls the production network.
- Local diagnostic events for impression displayed, CTA activated, skipped/dismissed, and external-open failure. No new remote analytics are introduced without explicit approval.

### 7.2 Post-authentication sponsor gateway

Retain:

- One-time gating flag.
- Sponsor click-through.
- Five-second skip countdown.
- Return-to-app state.
- Thank-you behavior.

Improve:

- Label the destination as sponsored before the user clicks.
- Replace ambiguous “Click to Continue” language with a truthful sponsor CTA.
- Present “Continue to files” as the delayed secondary action.
- Preserve keyboard focus, screen-reader countdown, external-open failure recovery, and mobile safe areas.
- Use the same calm onboarding shell as authentication so the transition does not feel like a different product.

### 7.3 Desktop 300×250 placement

Retain:

- 300×250 iframe creative.
- Existing sandbox permissions and click interception.
- Show-on-launch behavior.
- Forty-five-minute recurrence.
- Ten-second countdown and auto-dismiss.
- Hover pause.
- External browser click-through.

Improve:

- Present it as a non-modal sponsored card in a right-side activity/sponsor rail or an anchored surface that does not cover file controls.
- Never steal focus or block file interaction.
- Reserve layout space or use collision-aware placement at narrow window sizes.
- Keep the countdown and sponsor label visually legible without competing with the creative.
- Provide a failure placeholder when the local ad endpoint is unavailable.

### 7.4 Android banner

Retain:

- Existing provider URL and click-through.
- Persisted dismissal.
- Visibility scheduling.
- Close behavior.

Improve:

- Dock it in a dedicated sponsored slot immediately above the safe-area-aware navigation bar.
- Do not rely on hardcoded `bottom-[144px]` placement.
- Avoid obscuring file rows, action sheets, keyboards, and selection controls.
- Localize sponsor and accessibility copy.

### 7.5 Ad parity tests

- Fresh install/authentication path.
- Returning-user bypass path.
- Skip countdown and persistence.
- Sponsor click and return-to-app path.
- External-open failure path.
- Desktop initial impression, hover pause, auto-close, recurrence, and click.
- Desktop narrow-window collision behavior.
- Android visible, hidden, dismissed, keyboard-open, and bottom-sheet states.
- Screen reader labels and live countdown announcements in every supported language.

## 8. Feature-preservation matrix

| Area | Capabilities that must survive | Primary parity check |
| --- | --- | --- |
| Authentication | API setup, phone, code, QR, 2FA, help, session restore, logout | Complete each auth path with existing persisted session behavior |
| Sponsor gateway | One-time flag, click, skip delay, return, thank-you | State-machine test plus restart persistence |
| Folder navigation | Saved Messages, create, rename, delete, visibility, invite, groups, reorder, collapse | Controller tests plus desktop/mobile interaction runs |
| File explorer | Grid/list, sort, zoom, virtual scroll, search, selection | Fixture set of 10, 1,000, and mixed-type files |
| File operations | Upload, folder upload, URL upload, drag/drop, move, rename, delete, bulk operations | Existing Tauri command invocations and queue outcomes unchanged |
| Sharing | Share link, password, expiry, revoke, LAN/Tailscale override, native Telegram link, native mobile share | Link creation/revocation and mobile share smoke tests |
| Transfers | Progress, speed, cancel, retry, clear, concurrency limits | Deterministic queue-state tests |
| Preview | Images, PDF, audio, video, HLS/adaptive variants, next/previous | Viewer-specific smoke and keyboard tests |
| Archives | Browse, extract one, extract all, destinations, progress/errors | Archive fixture suite |
| Network | Connection state, sync, proxy, live latency, VPN optimizer | Settings persistence and reconnect tests |
| REST API | Enable/disable, port, key generation, copy, diagnostics | API command tests and restart persistence |
| Storage/update | Cache controls, transcode cache, update checks/install states | Command tests and UI state tests |
| Themes | Light, dark, system behavior, presets, custom themes, performance mode | Migration plus contrast/visual tests |
| Desktop ad | Creative, timing, sandbox, click, hover pause, auto-close | Clock-controlled component integration tests |
| Android ad | Banner, dismissal persistence, click, visibility | Mobile integration tests |
| Localization | 13 current languages, RTL, formatting, public share surface | Separate language plan release gate |

## 9. Implementation phases

### Phase 0 — Baseline and safety harness

1. Record current screenshots for authentication, dashboard grid/list, selection, settings tabs, transfer states, viewers, share flow, ads, and mobile states.
2. Create a behavior inventory tied to the matrix above.
3. Add deterministic frontend fixtures for folders, files, transfers, shares, media metadata, network state, and ads.
4. Add smoke tests around controller/hook inputs and outputs before moving UI ownership.
5. Capture current bundle/build/typecheck results.

**Exit gate:** Baseline artifacts exist and all critical flows have an explicit parity check.

### Phase 1 — Tokens, themes, and primitives

1. Introduce semantic tokens alongside the existing variables.
2. Add compatibility mappings for legacy presets and custom themes.
3. Build the primitive component layer and development gallery.
4. Define motion, density, focus, disabled, error, loading, and reduced-motion behavior.
5. Verify dark/light contrast before migrating product screens.

**Exit gate:** Primitives pass state, theme, keyboard, and RTL gallery review; no product workflow has changed.

### Phase 2 — Desktop shell and navigation

1. Migrate sidebar visuals without changing folder/group controllers.
2. Build the new standard and selection toolbars.
3. Move theme and low-frequency actions out of the file toolbar.
4. Add responsive sidebar collapse and narrow-window behavior.
5. Introduce the activity/transfer surface container.

**Exit gate:** All navigation, folder/group, search, selection, and keyboard behavior reaches baseline parity.

### Phase 3 — File workspace

1. Build shared file/folder presentation models.
2. Replace generic card treatment with folder, media, document, archive, audio, and list variants.
3. Consolidate quick actions into an overflow/context model while retaining shortcuts.
4. Migrate sort, zoom, view mode, upload tiles, loading, error, empty, drag, and search states.
5. Preserve virtualizer measurement and large-folder performance.

**Exit gate:** All file operations and 1,000-item performance fixture pass in grid and list modes.

### Phase 4 — Transfers, settings, sharing, and diagnostics

1. Consolidate upload/download queue presentation in the activity center.
2. Split `SettingsModal.tsx` into category panels and shared setting rows.
3. Keep settings keys and persistence backward compatible.
4. Migrate sharing, REST API, proxy, VPN, storage, cache, update, and diagnostics surfaces.
5. Map raw backend errors to stable UI error codes where they reach users.

**Exit gate:** Every existing settings control and transfer action has a parity test and persists across restart.

### Phase 5 — Authentication, onboarding, and ads

1. Migrate AuthWizard to the new primitives without changing auth commands.
2. Simplify setup guidance and preserve phone, QR, code, password, help, and donation paths.
3. Implement the shared sponsored-content layer.
4. Rework gateway, desktop ad, and Android banner according to Section 7.
5. Localize and accessibility-test sponsored states through the language plan.

**Exit gate:** Every auth and sponsored-content scenario passes fresh-install and returning-user tests.

### Phase 6 — Mobile shell and primary workflows

1. Build safe-area-aware mobile toolbar and bottom navigation.
2. Replace card-heavy file rows with the shared mobile file/folder models.
3. Migrate selection, action sheets, folder drawer, transfers, and settings.
4. Integrate the Android sponsored slot without fixed collision offsets.
5. Verify native share, file picking, keyboard, long labels, and small-screen behavior.

**Exit gate:** Android/mobile feature matrix passes at minimum and maximum supported viewport sizes.

### Phase 7 — Viewers and advanced surfaces

1. Migrate preview modal, adaptive media player, PDF viewer, and archive viewer chrome.
2. Standardize navigation, close, loading, unsupported, conversion, and error states.
3. Preserve streaming, quality selection, cached variants, keyboard shortcuts, extraction, and external-open behavior.

**Exit gate:** Viewer fixtures and keyboard/media controls match baseline capability.

### Phase 8 — Localization, accessibility, and responsive hardening

Execute the applicable phases of `LANGUAGE_SUPPORT_IMPLEMENTATION_PLAN.md` against stable English copy and final primitives.

**Exit gate:** Language, RTL, formatting, contrast, focus, target-size, text-expansion, and screen-reader gates all pass.

### Phase 9 — Cleanup and release candidate

1. Remove superseded component-local styling and compatibility code only after parity is proven.
2. Remove stale screenshots and replace them with final verified captures.
3. Run frontend build/typecheck, Rust tests, platform smoke tests, and upgrade/migration tests.
4. Test existing stored settings and custom themes from a previous release.
5. Produce a release checklist and known-differences report. Any intentional behavior change requires explicit approval.

**Exit gate:** No unresolved critical/major parity defect and no unapproved feature loss.

## 10. Verification strategy

### Automated

- TypeScript typecheck and production build on every phase.
- Rust unit/integration tests for commands touched by error-code work.
- Component state tests for primitives and sponsored content.
- Controller/hook contract tests for file, transfer, connection, and settings behavior.
- Automated screenshots for critical screens in light/dark, compact/comfortable, LTR/RTL, and long-text modes.
- Keyboard and focus-order tests for toolbars, menus, dialogs, sheets, viewers, and settings.
- Performance checks for large virtualized folders and thumbnail loading.

### Manual platform matrix

- macOS desktop.
- Windows desktop/WebView2.
- Linux/WebKitGTK with normal and performance modes.
- Android minimum supported SDK/device size and a current large-screen device.

### Release-blocking defects

- Missing capability from the feature matrix.
- Lost persisted setting, theme, session, sponsor flag, or dismissal state.
- Broken upload/download/share/delete/move behavior.
- Ad overlap that blocks a primary control.
- Keyboard trap, inaccessible dialog, unreadable contrast, or touch target below the agreed minimum.
- Missing translation key, visible fallback key, broken RTL flow, or severe text clipping in a shipping locale.

## 11. Execution rules

1. Migrate one bounded surface at a time.
2. Keep old and new behavior comparable through fixtures, not through a long-lived duplicate production UI.
3. Do not mix large controller rewrites into visual pull requests.
4. Do not remove compatibility mappings until stored settings/themes from the previous version are tested.
5. Do not translate copy while English labels and information architecture are still changing; establish the localization foundation early, then translate after copy freeze.
6. Do not change sponsor timing, provider, URL, sandbox, or persisted rules without explicit product approval.

## 12. Definition of done

Path B is complete when:

- The application has one documented semantic design system and shared primitive layer.
- Desktop and mobile feel related while respecting their input and layout models.
- Every feature in Section 8 passes parity checks.
- Sponsored functionality is intact, clearly labeled, non-overlapping, localized, and testable.
- Settings and mobile dashboard are decomposed into maintainable presentation modules.
- All current languages pass the separate language plan.
- Light, dark, reduced-motion, performance, LTR, and RTL variants are release-ready.
- Legacy styles and compatibility code have been removed only where migration is proven safe.

