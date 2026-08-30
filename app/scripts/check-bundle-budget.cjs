const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const appRoot = path.resolve(__dirname, '..');
const distRoot = path.join(appRoot, 'dist');
const manifestPath = path.join(distRoot, '.vite', 'manifest.json');
const budgetPath = path.join(appRoot, 'bundle-budget.json');
const reportPath = path.join(distRoot, 'bundle-report.json');

function fail(message) {
  console.error(`[bundle] ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(manifestPath)) {
  throw new Error(`Missing ${manifestPath}. Run the production build before bundle:check.`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
const assetFiles = fs.readdirSync(path.join(distRoot, 'assets'))
  .filter((file) => /\.(js|css)$/.test(file))
  .sort();

const assets = assetFiles.map((file) => {
  const body = fs.readFileSync(path.join(distRoot, 'assets', file));
  return {
    file: `assets/${file}`,
    type: file.endsWith('.js') ? 'javascript' : 'css',
    bytes: body.length,
    gzipBytes: zlib.gzipSync(body, { level: 9 }).length,
    brotliBytes: zlib.brotliCompressSync(body).length,
  };
});

const manifestByFile = new Map(Object.values(manifest).map((entry) => [entry.file, entry]));
const entryFiles = Object.values(manifest).filter((entry) => entry.isEntry).map((entry) => entry.file);
const initialFiles = new Set();

function collectInitial(file) {
  if (initialFiles.has(file)) return;
  initialFiles.add(file);
  const entry = manifestByFile.get(file);
  for (const imported of entry?.imports || []) {
    const importedFile = manifest[imported]?.file;
    if (importedFile) collectInitial(importedFile);
  }
}

for (const file of entryFiles) collectInitial(file);

const javascript = assets.filter((asset) => asset.type === 'javascript');
const css = assets.filter((asset) => asset.type === 'css');
const summary = {
  initialJavaScriptBytes: javascript.filter((asset) => initialFiles.has(asset.file)).reduce((sum, asset) => sum + asset.bytes, 0),
  maxJavaScriptChunkBytes: Math.max(0, ...javascript.map((asset) => asset.bytes)),
  totalJavaScriptBytes: javascript.reduce((sum, asset) => sum + asset.bytes, 0),
  totalCssBytes: css.reduce((sum, asset) => sum + asset.bytes, 0),
};

function resolveManifestKey(reference) {
  if (manifest[reference]) return reference;
  const expectedName = path.basename(reference, path.extname(reference));
  const matches = Object.entries(manifest)
    .filter(([, entry]) => entry.src === reference || entry.name === expectedName)
    .map(([key]) => key);
  if (matches.length !== 1) {
    throw new Error(`Bundle budget reference ${reference} resolved to ${matches.length} manifest entries.`);
  }
  return matches[0];
}

function manifestJavaScriptBytes(manifestReference, excludeFiles = new Set()) {
  const manifestKey = resolveManifestKey(manifestReference);
  const files = new Set();
  const visitedKeys = new Set();
  function collect(key) {
    if (visitedKeys.has(key)) return;
    visitedKeys.add(key);
    const entry = manifest[key];
    if (!entry) throw new Error(`Manifest entry ${manifestReference} imports missing key: ${key}`);
    if (entry.file?.endsWith('.js') && !excludeFiles.has(entry.file)) files.add(entry.file);
    for (const imported of entry.imports || []) collect(imported);
  }
  collect(manifestKey);
  return {
    bytes: javascript
      .filter((asset) => files.has(asset.file))
      .reduce((sum, asset) => sum + asset.bytes, 0),
    files: [...files].sort(),
  };
}

const routeJavaScript = Object.fromEntries(
  Object.keys(budget.routeJavaScriptBudgets || {}).map((key) => [
    key,
    manifestJavaScriptBytes(key, initialFiles),
  ]),
);
const featureChunks = Object.fromEntries(
  Object.keys(budget.featureChunkBudgets || {}).map((key) => {
    const manifestKey = resolveManifestKey(key);
    const asset = javascript.find((candidate) => candidate.file === manifest[manifestKey].file);
    if (!asset) throw new Error(`Bundle budget entry ${key} did not produce a JavaScript chunk.`);
    return [key, { file: asset.file, bytes: asset.bytes }];
  }),
);

const report = {
  schemaVersion: 1,
  summary,
  budgets: budget,
  initialFiles: [...initialFiles].sort(),
  routeJavaScript,
  featureChunks,
  assets,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

const checks = [
  ['initial JavaScript', summary.initialJavaScriptBytes, budget.maxInitialJavaScriptBytes],
  ['largest JavaScript chunk', summary.maxJavaScriptChunkBytes, budget.maxJavaScriptChunkBytes],
  ['total JavaScript', summary.totalJavaScriptBytes, budget.maxTotalJavaScriptBytes],
  ['total CSS', summary.totalCssBytes, budget.maxTotalCssBytes],
];

for (const [label, actual, maximum] of checks) {
  const status = actual <= maximum ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${label}: ${actual} / ${maximum} bytes`);
  if (actual > maximum) fail(`${label} exceeds its reviewed budget.`);
}

for (const [key, maximum] of Object.entries(budget.routeJavaScriptBudgets || {})) {
  const actual = routeJavaScript[key].bytes;
  const status = actual <= maximum ? 'PASS' : 'FAIL';
  console.log(`[${status}] route JavaScript ${key}: ${actual} / ${maximum} bytes`);
  if (actual > maximum) fail(`${key} route JavaScript exceeds its reviewed budget.`);
}

for (const [key, maximum] of Object.entries(budget.featureChunkBudgets || {})) {
  const actual = featureChunks[key].bytes;
  const status = actual <= maximum ? 'PASS' : 'FAIL';
  console.log(`[${status}] feature chunk ${key}: ${actual} / ${maximum} bytes`);
  if (actual > maximum) fail(`${key} feature chunk exceeds its reviewed budget.`);
}

console.log(`[bundle] Wrote ${path.relative(appRoot, reportPath)}`);
