const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const outputRoot = path.resolve(process.argv[2] || path.join(repositoryRoot, 'release-assurance'));
const applicationVersion = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'app', 'package.json'), 'utf8'),
).version;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function serialFor(value) {
  const digest = sha256(value);
  return `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function encodePurlName(name) {
  return name.startsWith('@') ? encodeURIComponent(name) : name;
}

function npmComponents(projectDirectory) {
  const lockPath = path.join(projectDirectory, 'package-lock.json');
  const lockBody = fs.readFileSync(lockPath);
  const lock = JSON.parse(lockBody);
  const components = [];

  for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
    if (!packagePath || !packagePath.includes('node_modules/') || !metadata.version) continue;
    const marker = 'node_modules/';
    const name = metadata.name || packagePath.slice(packagePath.lastIndexOf(marker) + marker.length);
    const purl = `pkg:npm/${encodePurlName(name)}@${metadata.version}`;
    const component = {
      type: 'library',
      'bom-ref': purl,
      name,
      version: metadata.version,
      purl,
      scope: metadata.dev ? 'optional' : 'required',
    };
    if (metadata.license) component.licenses = [{ license: { id: metadata.license } }];
    if (typeof metadata.integrity === 'string' && metadata.integrity.startsWith('sha512-')) {
      component.hashes = [{ alg: 'SHA-512', content: Buffer.from(metadata.integrity.slice(7), 'base64').toString('hex') }];
    }
    components.push(component);
  }

  return { lockBody, components };
}

function rustComponents() {
  const manifestPath = path.join(repositoryRoot, 'app', 'src-tauri', 'Cargo.toml');
  const result = spawnSync('cargo', ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifestPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'cargo metadata failed');
  const metadata = JSON.parse(result.stdout);
  return metadata.packages.map((pkg) => {
    const purl = `pkg:cargo/${encodeURIComponent(pkg.name)}@${pkg.version}`;
    const component = {
      type: 'library',
      'bom-ref': purl,
      name: pkg.name,
      version: pkg.version,
      purl,
    };
    if (pkg.license) component.licenses = [{ expression: pkg.license }];
    if (pkg.source) component.externalReferences = [{ type: 'distribution', url: pkg.source }];
    return component;
  });
}

function deduplicate(components) {
  return [...new Map(components.map((component) => [component['bom-ref'], component])).values()]
    .sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']));
}

const appNpm = npmComponents(path.join(repositoryRoot, 'app'));
const workerNpm = npmComponents(path.join(repositoryRoot, 'supporter-service'));
const cargoLock = fs.readFileSync(path.join(repositoryRoot, 'app', 'src-tauri', 'Cargo.lock'));
const inputDigest = sha256(Buffer.concat([appNpm.lockBody, workerNpm.lockBody, cargoLock]));
const components = deduplicate([...appNpm.components, ...workerNpm.components, ...rustComponents()]);

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: serialFor(inputDigest),
  version: 1,
  metadata: {
    component: {
      type: 'application',
      'bom-ref': `pkg:generic/telegram-drive@${applicationVersion}`,
      name: 'Telegram Drive',
      version: applicationVersion,
    },
    properties: [
      { name: 'telegram-drive:source-lock-digest', value: inputDigest },
      { name: 'telegram-drive:commit', value: process.env.GITHUB_SHA || 'local' },
    ],
  },
  components,
};

fs.mkdirSync(outputRoot, { recursive: true });
const outputPath = path.join(outputRoot, 'telegram-drive-source-sbom.cdx.json');
fs.writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`[sbom] Wrote ${outputPath} with ${components.length} components.`);
