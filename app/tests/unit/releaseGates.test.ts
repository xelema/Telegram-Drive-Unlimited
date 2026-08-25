import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function workflow(name: string): string {
  return readFileSync(resolve(process.cwd(), '..', '.github', 'workflows', name), 'utf8');
}

describe('release safety gates', () => {
  it('blocks draft release creation on application and Worker verification', () => {
    const release = workflow('release.yml');
    const createReleaseJob = release.slice(
      release.indexOf('  create-release:'),
      release.indexOf('  build-tauri:'),
    );

    expect(release).toContain('  verify-release:');
    expect(release).toContain('run: npm test');
    expect(release).toContain('run: cargo test --lib');
    expect(release).toContain('npx wrangler deploy --dry-run');
    expect(createReleaseJob).toContain('needs: verify-release');
  });

  it('keeps Android verification independent from the desktop-only release', () => {
    const android = workflow('android.yml');
    const release = workflow('release.yml');

    expect(android).toMatch(/on:\s*\n\s+workflow_call:/);
    expect(android).toContain('--target aarch64 armv7 i686 x86_64');
    expect(android).toContain('--r8-seeds');
    expect(android).toContain('bash scripts/verify-android-artifacts.sh');
    expect(android).toContain('Require protected signing for production');
    expect(android).toContain('ANDROID_SIGNING_CERT_SHA256');
    expect(android).toContain('bash scripts/package-android-release.sh');
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

  it('keeps untranslated UI literal debt on a non-increasing budget', () => {
    const budget = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src', 'i18n', 'literal-budget.json'), 'utf8'),
    );
    expect(budget.maxFindings).toBe(580);
    expect(readFileSync(resolve(process.cwd(), 'scripts', 'i18n', 'scan-ui-literals.cjs'), 'utf8'))
      .toContain('UI literal debt increased');
  });
});
