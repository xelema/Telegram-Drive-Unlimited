// Exercise the real Tauri bundler against the native app built by the E2E gate.
// This checks package contents; it does not launch a GUI or sign a release.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const app = path.join(root, 'app');
function run(command, args, cwd = app) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('desktop package contains the application and excludes native E2E executables', { timeout: 200_000 }, () => {
  assert.ok(['darwin', 'linux'].includes(process.platform), 'Run this packaging journey on macOS or Linux; Windows installer verification is separate.');
  const metadata = JSON.parse(run('cargo', ['metadata', '--no-deps', '--locked', '--format-version', '1'], path.join(app, 'src-tauri')));
  const output = path.join(metadata.target_directory, 'debug', 'bundle');
  const config = JSON.parse(fs.readFileSync(path.join(app, 'src-tauri/tauri.conf.json'), 'utf8'));
  const kind = process.platform === 'darwin' ? 'app' : 'deb';
  // Rebundling can retain files from a prior bundle; inspect only fresh output.
  if (process.platform === 'darwin') fs.rmSync(path.join(output, 'macos', `${config.productName}.app`), { recursive: true, force: true });
  run(process.execPath, [path.join(app, 'node_modules/@tauri-apps/cli/tauri.js'), 'bundle', '--features', 'tauri/custom-protocol', '--debug', '--bundles', kind, '--no-sign', '--ci', '--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } })]);
  if (process.platform === 'darwin') {
    const binaries = fs.readdirSync(path.join(output, 'macos', `${config.productName}.app`, 'Contents', 'MacOS'));
    assert.ok(binaries.length > 0, 'Application executable missing');
    assert.ok(binaries.every(name => !/native[-_]e2e[-_]driver/.test(name)), `Test executable bundled: ${binaries}`);
  } else {
    const directory = path.join(output, 'deb');
    const packages = fs.readdirSync(directory).filter(name => name.endsWith('.deb') && name.includes(config.version));
    assert.equal(packages.length, 1, 'Expected the current-version Debian package');
    const listing = run('dpkg-deb', ['--contents', path.join(directory, packages[0])]);
    assert.match(listing, /\/usr\/bin\/\S+/);
    assert.doesNotMatch(listing, /native[-_]e2e[-_]driver/);
  }
});
