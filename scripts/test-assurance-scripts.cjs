const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptRoot = __dirname;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-drive-assurance-'));
const dependencyReport = path.join(temporaryRoot, 'gradle-dependencies.txt');
const sbomPath = path.join(temporaryRoot, 'android-sbom.cdx.json');
const checksumPath = path.join(temporaryRoot, 'SHA256SUMS.txt');

fs.writeFileSync(dependencyReport, [
  '+--- androidx.core:core-ktx:1.12.0',
  '\\--- com.squareup.okhttp3:okhttp:4.11.0 -> 4.12.0',
  '',
].join('\n'));

function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(scriptRoot, script), ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${script} failed`);
}

run('generate-gradle-sbom.cjs', [dependencyReport, sbomPath]);
const sbom = JSON.parse(fs.readFileSync(sbomPath, 'utf8'));
if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.5') {
  throw new Error('Gradle SBOM is not CycloneDX 1.5.');
}
if (sbom.components.length !== 2 || !sbom.components.some(component => component.version === '4.12.0')) {
  throw new Error('Gradle SBOM did not preserve the resolved dependency graph.');
}

run('generate-checksums.cjs', [temporaryRoot, checksumPath]);
const checksumLines = fs.readFileSync(checksumPath, 'utf8').trim().split('\n');
if (checksumLines.length !== 2 || !checksumLines.every(line => /^[0-9a-f]{64}  .+/.test(line))) {
  throw new Error('Checksum manifest is incomplete or malformed.');
}

console.log('[assurance] Gradle SBOM and checksum generators passed their contract test.');
