import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function workflow(name: string): string {
  return readFileSync(resolve(process.cwd(), '..', '.github', 'workflows', name), 'utf8');
}

function repositoryFile(...segments: string[]): string {
  return readFileSync(resolve(process.cwd(), '..', ...segments), 'utf8');
}

describe('release safety gates', () => {
  it('blocks draft release creation on application and Worker verification', () => {
    const release = workflow('release.yml');
    const createReleaseJob = release.slice(
      release.indexOf('  create-release:'),
      release.indexOf('  build-tauri:'),
    );

    expect(release).toContain('  verify-release:');
    expect(release).toContain('run: npm run test:coverage');
    expect(release).toContain('run: npm run build:verify');
    expect(release).toContain(
      'run: npm run release:version:check -- --tag "$GITHUB_REF_NAME" --changelog ../CHANGELOG.md',
    );
    expect(release).toContain('run: cargo test --lib');
    expect(release).toContain('npx wrangler deploy --dry-run');
    expect(createReleaseJob).toContain('needs: verify-release');
  });

  it('keeps release manifests and the first changelog heading on one version', () => {
    const packageVersion = JSON.parse(repositoryFile('app', 'package.json')).version as string;
    const tauriVersion = JSON.parse(
      repositoryFile('app', 'src-tauri', 'tauri.conf.json'),
    ).version as string;
    const cargoVersion = repositoryFile('app', 'src-tauri', 'Cargo.toml')
      .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const changelogVersion = repositoryFile('CHANGELOG.md')
      .match(/^## \[([^\]]+)\](?:\s+-|\s*$)/m)?.[1];

    expect([tauriVersion, cargoVersion, changelogVersion]).toEqual([
      packageVersion,
      packageVersion,
      packageVersion,
    ]);
  });

  it('keeps Android verification independent from the desktop-only release', () => {
    const android = workflow('android.yml');
    const release = workflow('release.yml');

    expect(android).toMatch(/on:\s*\n\s+workflow_call:/);
    expect(android).toContain('  workflow_dispatch:');
    expect(android).not.toContain('  pull_request:');
    expect(android).not.toContain('  push:');
    expect(android).toContain('--target aarch64 armv7 i686 x86_64');
    expect(android).toContain('--r8-seeds');
    expect(android).toContain('bash scripts/verify-android-artifacts.sh');
    expect(android).toContain('Require protected signing for production');
    expect(android).toContain('ANDROID_SIGNING_CERT_SHA256');
    expect(android).toContain('bash scripts/package-android-release.sh');
    expect(android).toContain("'system-images;android-24;google_apis;x86_64'");
    expect(android).toContain("ANDROID_EMULATOR_API: '24'");
    expect(android).toContain(':app:assembleArm64Release');
    expect(android).toContain('-x :app:rustBuildArm64Release');
    expect(android).toContain("if: env.HAS_ANDROID_SIGNING_KEY == 'true'");
    expect(release).not.toContain('uses: ./.github/workflows/android.yml');
    expect(release).not.toContain('telegram-drive-android-signed');
    expect(release).not.toContain('android-update.json');
  });

  it('runs frontend regression tests in the native desktop matrix', () => {
    const desktop = workflow('desktop-sync-ci.yml');
    expect(desktop).toContain('run: npm test');
    expect(desktop).toContain('run: cargo fmt --all -- --check');
    expect(desktop).toContain('run: cargo clippy --lib --all-targets -- -D warnings');
    expect(desktop).toContain('run: npm run tauri -- build --no-bundle');
    expect(desktop).toContain('  desktop-ui-e2e:');
    expect(desktop).toContain('run: npm run visual:test');
    expect(desktop).toContain('run: npm run i18n:check');
  });

  it('blocks releases when native formatting or clippy gates fail', () => {
    const release = workflow('release.yml');
    expect(release).toContain('run: cargo fmt --all -- --check');
    expect(release).toContain('run: cargo clippy --lib --all-targets -- -D warnings');
  });

  it('never mutates an AppImage after Tauri signs and uploads release artifacts', () => {
    const release = workflow('release.yml');
    const desktopBuild = release.slice(
      release.indexOf('  build-tauri:'),
      release.indexOf('  build-arch:'),
    );

    expect(desktopBuild).toContain('tauri-apps/tauri-action@');
    expect(desktopBuild).not.toMatch(/Patch AppImage|appimagetool|squashfs-root|LD_PRELOAD|NO_AT_BRIDGE/);
    expect(release).not.toContain('AppImageKit/releases/download/continuous');
    expect(release).not.toContain('WEBKIT_DISABLE_DMABUF_RENDERER=1');
  });

  it('builds a checksum-locked pacman-owned package before release assurance', () => {
    const release = workflow('release.yml');
    const archCi = workflow('arch-package.yml');
    const archBuild = release.slice(
      release.indexOf('  build-arch:'),
      release.indexOf('  release-assurance:'),
    );
    const pkgbuild = repositoryFile('packaging', 'arch', 'PKGBUILD.in');
    const launcher = repositoryFile('packaging', 'arch', 'telegram-drive');
    const installationInfo = readFileSync(
      resolve(process.cwd(), 'src-tauri', 'src', 'installation.rs'),
      'utf8',
    );
    const updateHook = readFileSync(
      resolve(process.cwd(), 'src', 'hooks', 'useUpdateCheck.ts'),
      'utf8',
    );
    const settingsModal = readFileSync(
      resolve(process.cwd(), 'src', 'components', 'desktop', 'dashboard', 'SettingsModal.tsx'),
      'utf8',
    );

    expect(archBuild).toContain('needs: [create-release, build-tauri]');
    expect(archBuild).toMatch(/archlinux:base-devel-[^\s]+@sha256:[0-9a-f]{64}/);
    expect(archBuild).toContain("--pattern '*.deb'");
    expect(archBuild).toContain('scripts/render-arch-pkgbuild.sh');
    expect(archBuild).toContain('runuser -u arch-builder');
    expect(archBuild).toContain('makepkg --printsrcinfo');
    expect(archBuild).toContain('namcap arch-package/PKGBUILD');
    expect(archBuild).toContain('desktop-file-utils');
    expect(archBuild).toContain('scripts/verify-arch-package.sh');
    expect(archBuild).toContain('pacman -U --noconfirm');
    expect(archBuild).toContain('xvfb-run -a timeout --kill-after=5s 15s telegram-drive');
    expect(archBuild).toContain('scripts/generate-arch-runtime-sbom.sh');
    expect(archBuild).toContain('gh release upload "$GITHUB_REF_NAME"');

    expect(pkgbuild).toContain('pkgname=telegram-drive-bin');
    expect(pkgbuild).toContain("arch=('x86_64')");
    expect(pkgbuild).toContain("license=('LicenseRef-Upstream-Unspecified')");
    expect(pkgbuild).toContain("options=('!strip' '!debug')");
    expect(pkgbuild).not.toContain("license=('MIT')");
    expect(pkgbuild).not.toContain('SKIP');
    expect(pkgbuild).not.toContain('/usr/local');
    expect(launcher).toContain('TELEGRAM_DRIVE_PACKAGE_MANAGER=pacman');
    expect(installationInfo).toContain('managed_by_package_manager: package_manager.is_some()');
    expect(installationInfo).toContain('cmd_get_installation_info');
    expect(updateHook).toContain('if (state.managedByPackageManager)');
    expect(updateHook).toContain('await openUrl(RELEASES_URL)');
    expect(updateHook.indexOf('if (state.managedByPackageManager)')).toBeLessThan(
      updateHook.indexOf('await installVerifiedUpdate('),
    );
    expect(settingsModal).toContain('if (installationInfo?.managedByPackageManager)');
    expect(settingsModal).toContain("installationInfo?.managedByPackageManager ? t('common.open')");
    expect(archCi).toContain('  pull_request:');
    expect(archCi).toMatch(/archlinux:base-devel-[^\s]+@sha256:[0-9a-f]{64}/);
    expect(archCi).toContain('d229a414025650d44211521ca350298d67c7d8136001f8300636bb3ea2ecc35f');
    expect(archCi).toContain('makepkg --printsrcinfo');
    expect(archCi).toContain('scripts/verify-arch-package.sh');
    expect(archCi).not.toContain("sha256sums=('SKIP')");
  });

  it('runs axe in the Playwright accessibility gate', () => {
    const spec = readFileSync(
      resolve(process.cwd(), 'tests', 'visual', 'design-gallery.spec.ts'),
      'utf8',
    );
    expect(spec).toContain('a11y-audit');
    expect(spec).toContain('data-axe-audit-status="complete"');
    expect(spec).toContain('expect(result.violations ?? []).toEqual([])');
  });

  it('keeps crash destinations and Telegram API hashes outside WebView-controlled storage', () => {
    const crashClient = readFileSync(resolve(process.cwd(), 'src', 'services', 'crashTelemetry.ts'), 'utf8');
    const crashCommand = readFileSync(
      resolve(process.cwd(), 'src-tauri', 'src', 'commands', 'crash_reporting.rs'),
      'utf8',
    );
    const authWizard = readFileSync(
      resolve(process.cwd(), 'src', 'components', 'shared', 'AuthWizard.tsx'),
      'utf8',
    );
    expect(crashClient).not.toContain('VITE_CRASH_REPORT_ENDPOINT');
    expect(crashClient).not.toMatch(/cmd_submit_crash_report[^\n]*endpoint/);
    expect(crashCommand).toContain('option_env!("TELEGRAM_DRIVE_CRASH_REPORT_ENDPOINT")');
    expect(authWizard).not.toMatch(/store\.set\(['"]api_hash/);
    expect(authWizard).toContain("invoke('cmd_store_api_hash'");
  });

  it('keeps the product-site screenshot lightbox keyboard operable', () => {
    const site = repositoryFile('Docs', 'Telegram-Drive.html');
    expect(site).toContain("image.setAttribute('role', 'button')");
    expect(site).toContain('image.tabIndex = 0');
    expect(site).toContain("event.key === 'Enter' || event.key === ' '");
    expect(site).toContain("imageDialog.addEventListener('close'");
    expect(site).toContain('lightboxTrigger?.focus()');
  });

  it('prepares required Windows resources with PowerShell 7 and a legacy fallback', () => {
    const tauriCli = readFileSync(resolve(process.cwd(), 'scripts', 'tauri-cli.cjs'), 'utf8');
    expect(tauriCli).toContain('prepareWindowsRuntime();');
    expect(tauriCli).not.toContain("if (!args.includes('--no-bundle'))");
    expect(tauriCli).toContain("['pwsh.exe', 'powershell.exe']");
  });

  it('keeps untranslated UI literal debt on a non-increasing budget', () => {
    const budget = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src', 'i18n', 'literal-budget.json'), 'utf8'),
    );
    expect(budget.maxFindings).toBe(486);
    expect(budget.areaBudgets.sync.maxFindings).toBe(0);
    expect(Object.keys(budget.areaBudgets)).toEqual([
      'supporterAndSponsors',
      'encryptionAndAccess',
      'authentication',
      'sync',
      'transfersAndLocalServices',
      'mediaAndHelp',
      'other',
    ]);
    expect(readFileSync(resolve(process.cwd(), 'scripts', 'i18n', 'scan-ui-literals.cjs'), 'utf8'))
      .toContain('literal debt increased');
  });

  it('keeps every shipped language compatible with encrypted settings sync', () => {
    const languages = readFileSync(
      resolve(process.cwd(), 'src', 'i18n', 'languages.ts'),
      'utf8',
    );
    const settingsSync = readFileSync(
      resolve(process.cwd(), 'src-tauri', 'src', 'commands', 'settings_sync.rs'),
      'utf8',
    );
    const shippedCodes = Array.from(
      languages.matchAll(/\{\s*code:\s*'([^']+)'/g),
      match => match[1],
    );
    const syncLanguageBlock = settingsSync.match(
      /"language",\s*&\[([\s\S]*?)\]\s*,?\s*\)/,
    )?.[1];
    const syncCodes = Array.from(
      syncLanguageBlock?.matchAll(/"([^"]+)"/g) ?? [],
      match => match[1],
    );

    expect(shippedCodes).toHaveLength(24);
    expect(syncCodes).toEqual(['system', ...shippedCodes]);
    expect(settingsSync).toContain('("archiveMaxBytes", 0, 4_294_967_296)');
  });

  it('keeps share capability secrets and private message IDs out of logs and errors', () => {
    const shareRoutes = readFileSync(
      resolve(process.cwd(), 'src-tauri', 'src', 'share_routes.rs'),
      'utf8',
    );
    const logCalls = Array.from(
      shareRoutes.matchAll(/log::\w+!\([\s\S]*?\);/g),
      match => match[0],
    ).join('\n');

    expect(logCalls).not.toMatch(/\btoken\b|\bpassword\b|\bmessage_id\b/);
    expect(shareRoutes).not.toMatch(
      /HttpResponse::InternalServerError\(\)\.body\(format!\(/,
    );
    expect(shareRoutes).toContain('MAX_TRACKED_SHARE_TOKENS');
    expect(shareRoutes).toContain('HttpResponse::TooManyRequests()');
  });

  it('uses one exact CORS allowlist for both local HTTP servers', () => {
    const localCors = readFileSync(
      resolve(process.cwd(), 'src-tauri', 'src', 'local_cors.rs'),
      'utf8',
    );
    const nativeLibrary = readFileSync(
      resolve(process.cwd(), 'src-tauri', 'src', 'lib.rs'),
      'utf8',
    );
    const streamingServer = readFileSync(
      resolve(process.cwd(), 'src-tauri', 'src', 'server.rs'),
      'utf8',
    );

    expect(localCors).toContain('origin.parse::<Uri>()');
    expect(localCors).not.toContain('starts_with');
    expect(nativeLibrary).toContain('local_cors::is_allowed_origin_header(origin)');
    expect(streamingServer).toContain('crate::local_cors::is_allowed_origin_header(origin)');
    expect(nativeLibrary).not.toContain('origin.as_bytes().starts_with');
    expect(streamingServer).not.toContain('origin.as_bytes().starts_with');
  });

  it('keeps public media, download, and Android release facts aligned with implementation', () => {
    const readme = repositoryFile('README.md');
    const androidRunbook = repositoryFile('Docs', 'ANDROID_SIDELOAD_RELEASE.md');
    const cargoManifest = readFileSync(
      resolve(process.cwd(), 'src-tauri', 'Cargo.toml'),
      'utf8',
    );
    const localeDirectory = resolve(process.cwd(), 'src', 'i18n', 'locales');
    const localizedTaglines = readdirSync(localeDirectory)
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const locale = JSON.parse(
          readFileSync(resolve(localeDirectory, file), 'utf8'),
        ) as { auth?: { tagline?: string }; settings?: { tagline?: string } };
        return [locale.settings?.tagline ?? '', locale.auth?.tagline ?? ''].join('\n');
      })
      .join('\n');
    const authWizard = readFileSync(
      resolve(process.cwd(), 'src', 'components', 'shared', 'AuthWizard.tsx'),
      'utf8',
    );
    const privacy = repositoryFile('PRIVACY.md');

    expect(readme).toContain('TDENC2-protected audio, video, and PDF content can stream');
    expect(readme).not.toContain('In-app image, PDF, archive, audio, and video previews.');
    expect(readme).not.toContain('Androidv4.0.0beta');
    expect(androidRunbook).toContain('That workflow does not invoke Android CI');
    expect(androidRunbook).not.toContain('Telegram-Drive-v3.5.0-android-universal.apk');
    expect(cargoManifest).not.toContain('unlimited, secure cloud storage');
    expect(authWizard).not.toContain('Self-hosted secure storage');
    expect(privacy).not.toContain('self-hosted desktop and Android client');

    for (const retiredClaim of [
      'unlimited, secure cloud storage',
      '容量無制限',
      'walang limitasyon',
      'illimitato e sicuro',
      'نامحدود',
      'необмежену',
      'সীমাহীন',
      'لامحدود',
      'không giới hạn',
      'ไม่จำกัด',
      'nieograniczoną',
      '無限的安全雲端',
      'tanpa had',
      'Self-hosted secure storage',
    ]) {
      expect(localizedTaglines).not.toContain(retiredClaim);
    }
  });

  it('keeps supporter terms versions and platform allowance wording synchronized', () => {
    const markdownTerms = repositoryFile('SUPPORTER_TERMS.md');
    const workerTerms = repositoryFile('supporter-service', 'src', 'terms.ts');
    const workerConfig = repositoryFile('supporter-service', 'wrangler.jsonc');
    const nativeSupporter = readFileSync(
      resolve(process.cwd(), 'src-tauri', 'src', 'commands', 'supporter.rs'),
      'utf8',
    );
    const supporterContext = readFileSync(
      resolve(process.cwd(), 'src', 'context', 'SupporterContext.tsx'),
      'utf8',
    );
    const readme = repositoryFile('README.md');
    const privacy = repositoryFile('PRIVACY.md');
    const productSite = repositoryFile('Docs', 'Telegram-Drive.html');
    const platformAllowance =
      'supported Windows, macOS, Linux, or Android devices in total';
    const versions = [
      markdownTerms.match(/Terms version:\s*(\d{4}-\d{2}-\d{2})/)?.[1],
      workerConfig.match(/"TERMS_VERSION":\s*"([^"]+)"/)?.[1],
      nativeSupporter.match(/const TERMS_VERSION: &str = "([^"]+)"/)?.[1],
      supporterContext.match(/terms_version:\s*'([^']+)'/)?.[1],
    ];

    expect(versions.every(Boolean)).toBe(true);
    expect(new Set(versions).size).toBe(1);
    for (const surface of [markdownTerms, workerTerms, readme, privacy, productSite]) {
      expect(surface).toContain(platformAllowance);
    }
    expect(productSite).not.toContain('up to three desktop devices');
    expect(productSite).not.toContain('supported desktop sponsor placements');
    expect(workerConfig).toContain('"SUPPORTER_PRICE": "5.00"');
    expect(workerConfig).toContain('"SUPPORTER_CURRENCY": "USD"');
    expect(workerConfig).toContain('"MAX_ACTIVE_DEVICES": "3"');
  });

  it('discloses sponsor creative request metadata without implying file tracking', () => {
    const privacy = repositoryFile('PRIVACY.md');

    expect(privacy).toContain("application's loopback sponsor relay");
    expect(privacy).toContain('public IP address and user agent');
    expect(privacy).toContain('does not send file activity, file metadata');
  });

  it('pins every third-party workflow action to an immutable commit', () => {
    const workflowDirectory = resolve(process.cwd(), '..', '.github', 'workflows');
    for (const name of readdirSync(workflowDirectory).filter(file => file.endsWith('.yml'))) {
      const source = readFileSync(resolve(workflowDirectory, name), 'utf8');
      const externalUses = Array.from(source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm), match => match[1])
        .filter(action => !action.startsWith('./'));
      expect(externalUses, name).not.toHaveLength(0);
      for (const action of externalUses) {
        expect(action, `${name}: ${action}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it('publishes checksums, SBOMs, and attestations before a release can leave draft state', () => {
    const release = workflow('release.yml');
    const android = workflow('android.yml');

    expect(release).toContain('  release-assurance:');
    expect(release).toContain('node scripts/generate-sboms.cjs release-assurance');
    expect(release).toContain('node scripts/generate-checksums.cjs release-assets release-assets/SHA256SUMS.txt');
    expect(release).toContain('subject-checksums: release-assurance/SUBJECTS.sha256');
    expect(release).toContain('needs: [create-release, build-tauri, build-arch]');
    expect(release).toContain('subject-checksums: release-assurance/ARCH_SUBJECT.sha256');
    expect(release).toContain('sbom-path: release-assets/telegram-drive-arch-runtime-sbom.cdx.json');
    expect(release).toContain('needs: [create-release, build-tauri, build-arch, release-assurance]');
    const sourceSbom = repositoryFile('scripts', 'generate-sboms.cjs');
    expect(sourceSbom).toContain('applicationVersion');
    expect(sourceSbom).not.toContain("version: '3.7.0'");
    expect(android).toContain('node ../scripts/generate-gradle-sbom.cjs');
    expect(android).toContain('node ../scripts/generate-sboms.cjs android-release');
    expect(android).toContain('subject-checksums: app/android-release/SHA256SUMS.txt');
  });

  it('enforces dependency policy without automatic update PRs or lock mutation', () => {
    const assurance = workflow('dependency-assurance.yml');
    const dependabotPath = resolve(process.cwd(), '..', '.github', 'dependabot.yml');

    expect(assurance).toContain('node scripts/check-npm-audit.cjs');
    expect(assurance).toContain('node scripts/check-node-licenses.cjs');
    expect(assurance).toContain('cargo deny --manifest-path app/src-tauri/Cargo.toml check --config ../../deny.toml --hide-inclusion-graph');
    expect(assurance).not.toContain('npm audit fix');
    expect(assurance).not.toContain('cargo update');
    expect(existsSync(dependabotPath)).toBe(false);
    expect(repositoryFile('scripts', 'check-npm-audit.cjs')).toContain(
      'npm audit did not return a complete advisory report',
    );
  });

  it('keeps optional viewers, media tooling, settings, and non-English locales off the initial graph', () => {
    const desktop = readFileSync(resolve(process.cwd(), 'src', 'components', 'desktop', 'DesktopDashboard.tsx'), 'utf8');
    const mobile = readFileSync(resolve(process.cwd(), 'src', 'components', 'mobile', 'MobileDashboard.tsx'), 'utf8');
    const media = readFileSync(resolve(process.cwd(), 'src', 'components', 'desktop', 'dashboard', 'AdaptiveMediaPlayer.tsx'), 'utf8');
    const i18n = readFileSync(resolve(process.cwd(), 'src', 'i18n', 'index.ts'), 'utf8');
    const fileOperations = readFileSync(resolve(process.cwd(), 'src', 'hooks', 'useFileOperations.ts'), 'utf8');
    const bundleBudget = JSON.parse(repositoryFile('app', 'bundle-budget.json'));

    expect(desktop).toContain('lazy(() => import(');
    expect(desktop).toContain("import('./dashboard/SettingsModal')");
    expect(mobile).toContain('lazy(() => import(');
    expect(media).toContain("import('hls.js').then(");
    expect(i18n).toContain("es: () => import('./locales/es.json')");
    expect(i18n).not.toContain("import es from './locales/es.json'");
    expect(fileOperations).not.toContain("import('@tauri-apps/plugin-dialog')");
    expect(bundleBudget.routeJavaScriptBudgets).toMatchObject({
      'src/components/desktop/DesktopDashboard.tsx': expect.any(Number),
      'src/components/mobile/MobileDashboard.tsx': expect.any(Number),
    });
    expect(bundleBudget.featureChunkBudgets).toMatchObject({
      'src/components/desktop/dashboard/SettingsModal.tsx': expect.any(Number),
      'src/components/desktop/dashboard/MediaPlayer.tsx': expect.any(Number),
      'src/components/desktop/dashboard/PdfViewer.tsx': expect.any(Number),
      'node_modules/hls.js/dist/hls.mjs': expect.any(Number),
    });
  });
});
