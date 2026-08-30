const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const inputPath = path.resolve(process.argv[2] || 'gradle-dependencies.txt');
const outputPath = path.resolve(process.argv[3] || 'telegram-drive-android-sbom.cdx.json');
const input = fs.readFileSync(inputPath, 'utf8');
const applicationVersion = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'app', 'package.json'), 'utf8'),
).version;
const components = new Map();

for (const line of input.split(/\r?\n/)) {
  const match = line.match(/^[| +\\-]*([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([^\s(]+)(?:\s+->\s+([^\s(]+))?/);
  if (!match) continue;
  const [, group, name, requested, resolved] = match;
  const version = resolved || requested;
  if (!version || version === 'FAILED') continue;
  const purl = `pkg:maven/${encodeURIComponent(group)}/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
  components.set(purl, { type: 'library', 'bom-ref': purl, group, name, version, purl });
}

if (components.size === 0) {
  throw new Error(`No Gradle dependencies were recognized in ${inputPath}.`);
}

const digest = crypto.createHash('sha256').update(input).digest('hex');
const serial = `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: serial,
  version: 1,
  metadata: {
    component: {
      type: 'application',
      'bom-ref': `pkg:generic/telegram-drive-android@${applicationVersion}`,
      name: 'Telegram Drive Android',
      version: applicationVersion,
    },
  },
  components: [...components.values()].sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref'])),
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`[sbom] Wrote ${outputPath} with ${components.size} Gradle components.`);
