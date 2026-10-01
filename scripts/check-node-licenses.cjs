const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(process.argv[2] || '.');
const repositoryRoot = path.resolve(__dirname, '..');
const policy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'dependency-policy', 'node-licenses.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
const allowed = new Set(policy.allowed);
const failures = [];

function packageName(packagePath, metadata) {
  if (metadata.name) return metadata.name;
  const marker = 'node_modules/';
  const index = packagePath.lastIndexOf(marker);
  return index >= 0 ? packagePath.slice(index + marker.length) : packagePath;
}

function declaredLicense(packagePath, metadata) {
  if (metadata.license) return metadata.license;
  const packageJson = path.join(projectRoot, packagePath, 'package.json');
  if (fs.existsSync(packageJson)) {
    return JSON.parse(fs.readFileSync(packageJson, 'utf8')).license;
  }
  return undefined;
}

function isAllowed(expression) {
  if (!expression || typeof expression !== 'string') return false;
  const identifiers = expression
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND|WITH)\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return identifiers.length > 0 && identifiers.every((identifier) => allowed.has(identifier));
}

for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
  if (!packagePath || !packagePath.includes('node_modules/')) continue;
  if (metadata.optional && !fs.existsSync(path.join(projectRoot, packagePath))) continue;
  const name = packageName(packagePath, metadata);
  const version = metadata.version || 'unknown';
  const license = declaredLicense(packagePath, metadata);
  const exception = policy.exceptions?.[`${name}@${version}`];
  const exceptionValid = exception
    && exception.license === license
    && typeof exception.scope === 'string'
    && typeof exception.owner === 'string'
    && new Date(`${exception.expires}T23:59:59Z`) >= new Date();
  if (!isAllowed(license) && !exceptionValid) failures.push({ name, version, license: license || 'missing' });
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`[license] ${failure.name}@${failure.version}: ${failure.license}`);
  }
  console.error(`[license] ${failures.length} dependency license declaration(s) require review.`);
  process.exit(1);
}

console.log(`[license] All installed dependencies under ${path.relative(repositoryRoot, projectRoot)} satisfy the reviewed policy.`);
