# End-to-end testing

Behavioral regression testing uses E2E suites. New tests must exercise an application boundary and a meaningful user or service journey. Isolated function/component assertions, inline Rust unit modules, and Android JVM unit suites are retired. Historical review reports describe the checks available at the time; this document defines the current workflow.

## Host verification

Install JavaScript dependencies in `app/` and `supporter-service/`, the normal native build prerequisites, and Playwright Chromium:

```sh
npm ci --prefix app
npm ci --prefix supporter-service
cd app
npx playwright install chromium
cd ..
node scripts/run-e2e.cjs
```

On Linux CI, install the browser system dependencies with `npx playwright install --with-deps chromium`. The top-level runner stops on the first failing suite. It never deploys the Worker, uses a real PayPal purchase, or signs in to a personal Telegram account.

Individual suites:

| Boundary | Command from the repository root | What it exercises |
| --- | --- | --- |
| Browser | `npm run test:e2e --prefix app` | User journeys in Chromium, including existing visual/accessibility checks and full application flows; the Tauri/Telegram boundary is controlled by fixtures. |
| Native | `cargo test --locked --manifest-path app/src-tauri/Cargo.toml --features native-e2e --test native_e2e` | Native child processes, real local storage, vault/envelope persistence, download publication and loopback HTTP, using synthetic accounts and private temporary directories. |
| Supporter service | `npm run test:e2e --prefix supporter-service` | Real HTTP requests to the production Worker in a local workerd runtime with migrated D1; only the external PayPal boundary is simulated. |
| Release tools | `node scripts/e2e/assurance.e2e.cjs` | Shipped SBOM/checksum CLI processes, generated artifacts, independent checksum verification, and invalid-input rejection. |

`npm test` is an alias for `test:e2e` in both JavaScript projects. `visual:test` and `visual:update` remain browser tooling aliases. The native E2E driver is feature-gated and is excluded from normal application builds.

## Static checks and builds

E2E-only describes behavioral tests. Keep the independent checks that catch invalid configuration, type errors, dependency advisories, licensing problems, formatting issues, translation regressions, and oversized bundles:

```sh
node scripts/check-test-policy.cjs
node scripts/check-app-security.cjs
npm run build:verify --prefix app
npm run i18n:check --prefix app
npm run check --prefix supporter-service
cargo fmt --manifest-path app/src-tauri/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path app/src-tauri/Cargo.toml --features native-e2e --lib --all-targets -- -D warnings
```

The dependency-assurance workflow remains mandatory for desktop publication. Release verification requires browser, native, and service E2E suites before creating a release. CI also builds the normal application on Windows, Linux, and macOS. Unit-test line-coverage floors have been retired; a green E2E run must not be presented as 100% code or feature coverage.

## Device and external-service acceptance

Browser fixtures do not prove the Tauri IPC bridge, OS credential stores, native codecs, real Telegram network behavior, or installed-app updates. Native loopback/process tests do not replace GUI or OS integration checks. Their encrypted-file fixtures verify vault/envelope persistence and recovery; they do not verify Telegram encrypted-download staging or publication. Worker tests with a simulated PayPal transport do not prove the live provider integration.

Before a supported release, perform the relevant installed-app and device acceptance: sign in/out, switch accounts, upload/download/stream, restart/update without losing settings or activation, verify encrypted-file recovery, and exercise Android device flows. Keep the PayPal sandbox purchase/recovery/refund acceptance required by [the supporter contract](SUPPORTER_LICENSE_INVARIANTS.md) before payment-path or schema changes reach production. Never use production purchases, personal sessions, production D1, or real keychain entries as automated test fixtures.

Android device/emulator verification stays local; Android source and test projects must not be published to GitHub. With the SDK/NDK configured and the required system images installed, create the universal debug JNI inputs and run a private emulator from `app/`:

```sh
npm run tauri -- android build --debug --target aarch64 armv7 i686 x86_64 --apk true --ci
bash scripts/run-android-emulator-tests.sh phone
```

The runner uses 4096 MB of emulator RAM by default (`ANDROID_EMULATOR_RAM_MB` overrides it). This is a verified test-environment setting, not an application memory requirement. API 35+ phone runs include real PIN cancellation/reopen, camera-journal process restart, and session-recovery journeys after device instrumentation. The runner reinstalls the instrumentation APK for the separate ADB-driven journeys because Gradle removes it after its own tests. Each journey restores its synthetic state; the emulator is shut down on exit. Report device or platform checks that were unavailable as unrun, never as passing.

When fixing a regression, add a failing journey at the affected application boundary, make the smallest implementation change, and run that suite plus relevant static/build checks. Use explicit readiness and observable state changes rather than sleeps that assume a busy runner's scheduling speed.
