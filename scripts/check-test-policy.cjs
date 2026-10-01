// Configuration lint: behavioral regression suites must exercise application boundaries.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const problems = [];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const exists = file => fs.existsSync(path.join(root, file));
function files(directory) {
  if (!exists(directory)) return [];
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const name = `${directory}/${entry.name}`;
    return entry.isDirectory() ? files(name) : entry.isFile() ? [name] : [];
  });
}

for (const project of ['app', 'supporter-service']) {
  const manifest = JSON.parse(read(`${project}/package.json`));
  const e2e = manifest.scripts?.['test:e2e'];
  if (!e2e || ![e2e, 'npm run test:e2e', 'npm run test:e2e --'].includes(manifest.scripts?.test)) {
    problems.push(`${project}: npm test must run the test:e2e entrypoint.`);
  }
  if (manifest.scripts?.['test:coverage']) problems.push(`${project}: remove the retired unit coverage command.`);
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (/^(vitest$|@vitest\/|@testing-library\/|jsdom$)/.test(dependency)) {
      problems.push(`${project}: obsolete unit-only dependency ${dependency}.`);
    }
  }
  if (exists(`${project}/vitest.config.ts`)) problems.push(`${project}: remove the retired Vitest configuration.`);
}

for (const directory of ['app/tests/unit', 'app/android-overrides/app/src/test']) {
  if (files(directory).length) problems.push(`${directory}: replace unit cases with application or device journeys.`);
}
for (const file of [...files('app/src'), ...files('supporter-service/src')]) {
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) problems.push(`${file}: production source must not contain unit suites.`);
}
for (const file of files('app/src-tauri/src').filter(file => file.endsWith('.rs'))) {
  if (/#\s*\[\s*(?:test\b|[a-z_]+::test\b|cfg\([^\]]*\btest\b)/.test(read(file))) {
    problems.push(`${file}: move regression coverage to the native process/HTTP E2E suite.`);
  }
}
for (const file of files('.github/workflows').filter(file => /\.ya?ml$/.test(file))) {
  if (/\bvitest\b|\btest:coverage\b|tests\/unit\/|\btest\w*UnitTest\b|cargo\s+(?:test|llvm-cov)[^\r\n]*--lib\b/.test(read(file))) {
    problems.push(`${file}: CI still invokes a retired unit suite.`);
  }
}
const androidBuild = 'app/android-overrides/app/build.gradle.kts';
if (exists(androidBuild) && /\btest(?:Implementation|RuntimeOnly|CompileOnly)\b/.test(read(androidBuild))) {
  problems.push(`${androidBuild}: remove dependencies used only by the retired JVM unit suite.`);
}
for (const file of [
  'app/playwright.config.ts',
  'app/src-tauri/tests/native_e2e.rs',
  'scripts/e2e/assurance.e2e.cjs',
]) {
  if (!exists(file)) problems.push(`${file}: required E2E entrypoint is missing.`);
}

if (problems.length) {
  console.error(`[test-policy]\n${problems.map(problem => `- ${problem}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('[test-policy] E2E entrypoints are configured; no retired unit runners remain.');
}
