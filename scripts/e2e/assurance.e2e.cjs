const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Exercise the shipped CLI programs as child processes against real files.
// No generator implementation or internal function is imported by this suite.
const scripts = path.resolve(__dirname, '..');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-drive-assurance-e2e-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function run(name, ...args) {
  const result = spawnSync(process.execPath, [path.join(scripts, name), ...args], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(result.error);
  return result;
}
function success(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('release artifacts pass through SBOM generation and an independently verified checksum manifest', t => {
  const directory = fixture(t);
  const report = path.join(directory, 'gradle-dependencies.txt');
  fs.writeFileSync(report, '+--- androidx.core:core-ktx:1.12.0\n\\--- com.squareup.okhttp3:okhttp:4.11.0 -> 4.12.0\n');
  const sbomPath = path.join(directory, 'artifacts', 'android-sbom.cdx.json');
  success(run('generate-gradle-sbom.cjs', report, sbomPath));
  const sbom = JSON.parse(fs.readFileSync(sbomPath, 'utf8'));
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.5');
  assert.equal(sbom.components.length, 2);
  assert.ok(sbom.components.some(component => component.name === 'okhttp' && component.version === '4.12.0'));

  const manifest = path.join(directory, 'SHA256SUMS.txt');
  success(run('generate-checksums.cjs', directory, manifest));
  const contents = fs.readFileSync(manifest, 'utf8');
  const entries = contents.trim().split('\n');
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(entry);
    assert.ok(match, `Invalid checksum record: ${entry}`);
    const [, expected, name] = match;
    assert.notEqual(name, 'SHA256SUMS.txt');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex');
    assert.equal(actual, expected, `Checksum differs for ${name}`);
  }
  success(run('generate-checksums.cjs', directory, manifest));
  assert.equal(fs.readFileSync(manifest, 'utf8'), contents, 'Regeneration must not checksum the manifest itself.');
});

test('an empty dependency report fails without publishing an SBOM', t => {
  const directory = fixture(t);
  const report = path.join(directory, 'empty.txt');
  const output = path.join(directory, 'sbom.json');
  fs.writeFileSync(report, 'No resolved dependencies\n');
  assert.notEqual(run('generate-gradle-sbom.cjs', report, output).status, 0);
  assert.equal(fs.existsSync(output), false);
});

test('an empty release directory fails without publishing a checksum manifest', t => {
  const directory = fixture(t);
  const output = path.join(directory, 'SHA256SUMS.txt');
  assert.notEqual(run('generate-checksums.cjs', directory, output).status, 0);
  assert.equal(fs.existsSync(output), false);
});
