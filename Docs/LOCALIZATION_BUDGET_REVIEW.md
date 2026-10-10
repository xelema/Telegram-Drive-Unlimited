# P2-08 localization capacity review

The owner approved two locale-only ceiling increases sized by an exact dry-run encode, with at most 2% temporary headroom and no other budget changes. The target is zero hard-coded supporter, encryption and authentication presentation, translations for the eleven large locales, and visible data arrays. Remaining noncritical standalone copy and native-language acceptance keep broader P2-08 partly done; translations do not hold the tag.

## Measured capacity

| Measure | Before Part 4 | Final dry run and production build | Temporary ceiling | Final ceiling |
| --- | ---: | ---: | ---: | ---: |
| Largest locale packet | 124,881 | 138,790 | 141,523 | 138,790 |
| Total locale data, including shared dictionary | 1,734,675 | 1,952,434 | 1,990,950 | 1,952,434 |

The original ceilings were 125,000 and 1,800,000. The revised full target includes 128 new keys in all 24 catalogs, 110 distinct copied-English keys in the eleven large locales, and 176 previously exempt Folder Sync prose values. The complete draft was encoded with the production sorted union key table, SHA-256 dictionary identifier and `td-locale-v1` JSON format before the corresponding canonical additions. Review identified further visible arrays and encrypted Settings Sync copy; each expanded draft was remeasured before shipping it. The final “Unmute” label was included before lowering the ceilings.

The dictionary is 40,537 bytes and English is 53,195 bytes, for 93,732 bytes of separate startup data (previously 84,352). Total locale growth is 217,759 bytes. Loading remains one shared dictionary and one complete selected catalog; there are no additional Telegram requests, decoder work, persistent disk writes or feature dependencies. Resource memory grows with the selected translated data; no whole-application resident-memory claim is made.

The production build counts every locale and the dictionary. No bytes are reclassified or compressed out of accounting. Initial JavaScript, route, feature and CSS ceilings are unchanged. The accepted working build measures 504,787 initial JavaScript bytes, 2,448,590 total JavaScript bytes, 131,204 CSS bytes, 300,983 desktop-route bytes, 149,233 Settings bytes and 249,246 media-feature bytes. Other translations are not shortened to fit. The thirteen-string authentication draft is historical evidence, not the estimate used for this pass.

## Scope and acceptance

All eleven target locales have zero copied-English findings, including formerly globally exempt Sync prose. Brands and protocol invariants remain exempt; the validator specifically enforces these Sync translations in the target eleven languages. Presentation scanning includes mapped data arrays, error-state setters, conditional templates and the encryption-sensitive Settings Sync section. Stored IDs, technical protocol values, physical shortcut glyphs and owner names are excluded by actual presentation flow rather than an expanded prose allowlist.

The complete working target measures 308 remaining noncritical literals: transfers/local services 94, media/help 73, other 141; supporter, encryption, authentication and sync are zero. The permitted candidate uses the original scanner and measures 298 literals: supporter 1, encryption/authentication/sync 0, transfers/local services 90, media/help 69 and other 138. Every staged literal ceiling decreases. The strengthened scanner would expose pre-existing hook-held mobile arrays and require an unauthorized candidate area increase, so that scanner and its matching release-tool test hunks remain uncommitted alongside the three mobile files, two mobile E2E journeys and 308-target baseline hunks matching the strengthened scanner. Diagnostic counts from the two scanner versions are not directly comparable. No ceiling is raised to accommodate held copy. The permitted desktop and canonical translation changes are verified from an exported index tree before commit.

Every authored range is listed in [LOCALIZATION_REVIEW.md](LOCALIZATION_REVIEW.md). All 24 native-review statuses remain UNRUN. Browser fixtures exercise presentation and state with controlled Telegram, payment and native-command boundaries; they do not establish linguistic quality, installed upgrades or Android/device behavior.
