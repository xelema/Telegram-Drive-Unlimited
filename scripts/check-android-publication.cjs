// Static publication guard: Android project and source files stay local.
//
// Inspects every tracked file and every commit that a push would publish.
// Only compiled Android binaries are published, as assets of the separate
// Android release, never as repository content. See AGENTS.md.
//
// Usage: node scripts/check-android-publication.cjs [--repo DIR] [--range REV..REV] [--tracked-only] [--strict]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
const repository = path.resolve(option('--repo') || path.resolve(__dirname, '..'));
const reviewFile = option('--review-file') || path.join(repository, 'dependency-policy', 'android-publication-review.json');
const trackedOnly = args.includes('--tracked-only');
const strict = args.includes('--strict');

function git(...parameters) {
  const result = spawnSync('git', ['-C', repository, ...parameters], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}
function lines(result) {
  return result.stdout.split('\n').map(value => value.trim()).filter(Boolean);
}

// Android project, build, source and signing material. Never publishable.
const forbidden = [
  [/(^|\/)(build|settings)\.gradle(\.kts)?$/, 'Gradle build configuration'],
  [/(^|\/)gradle\.properties$/, 'Gradle properties'],
  [/(^|\/)gradlew(\.bat)?$/, 'Gradle wrapper'],
  [/(^|\/)gradle\/wrapper\//, 'Gradle wrapper'],
  [/(^|\/)\.gradle\//, 'Gradle cache'],
  [/(^|\/)local\.properties$/, 'Android SDK location'],
  [/(^|\/)keystore\.properties$/, 'signing configuration'],
  [/(^|\/)AndroidManifest\.xml$/, 'Android manifest'],
  [/(^|\/)proguard-rules\.pro$/, 'R8 configuration'],
  [/\.(kt|kts|java)$/, 'Android source'],
  [/\.(keystore|jks|p12|pfx)$/, 'signing key store'],
  [/\.(apk|aab|aar|dex)$/, 'Android binary (publish as a release asset, not repository content)'],
  [/^android\//, 'Android project folder'],
  [/^app\/android-overrides\//, 'Android project overrides'],
  [/^app\/src-tauri\/gen\/android\//, 'generated Android project'],
  [/^app\/src-tauri\/src-android\//, 'Android native source'],
  [/^app\/src-tauri\/icons\/android\//, 'generated Android resources'],
  [/(^|\/)src\/(androidTest|main\/(java|kotlin|res|jniLibs))\//, 'Android project layout'],
];
// Anything else that names Android needs an explicit decision.
const androidNamed = /android|gradle|(^|\/)jni|(^|\/)mobile[./]/i;

const review = fs.existsSync(reviewFile) ? JSON.parse(fs.readFileSync(reviewFile, 'utf8')) : {};
const permitted = new Set(review.permitted_shared_files || []);
const pending = new Set(review.pending_owner_review || []);

const tracked = git('ls-files');
if (tracked.status !== 0) {
  console.error(`[android-publication] ${repository} is not a Git repository.`);
  process.exit(2);
}
const sources = new Map([['tracked file', lines(tracked)]]);

if (!trackedOnly) {
  let range = option('--range');
  if (!range) {
    const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
    if (upstream.status === 0) range = `${upstream.stdout.trim()}..HEAD`;
    else if (git('rev-parse', '--verify', '--quiet', 'origin/main').status === 0) range = 'origin/main..HEAD';
  }
  // Without a remote to compare with, every commit is outgoing.
  const log = git('log', '--name-only', '--diff-filter=ACMR', '--format=', range || 'HEAD');
  if (log.status !== 0) {
    console.error(`[android-publication] Could not read the outgoing commits (${range || 'HEAD'}): ${log.stderr.trim()}`);
    process.exit(2);
  }
  // A file added in one outgoing commit and removed in a later one is still
  // published in history, so every commit counts, not only the final tree.
  sources.set(`outgoing commit (${range || 'entire history'})`, [...new Set(lines(log))]);
}

const problems = [];
const awaiting = new Set();
for (const [origin, files] of sources) {
  for (const file of files) {
    const match = forbidden.find(([pattern]) => pattern.test(file));
    if (match) {
      problems.push(`${file}: ${match[1]} in a ${origin}`);
    } else if (androidNamed.test(file) && !permitted.has(file)) {
      if (pending.has(file)) awaiting.add(file);
      else problems.push(`${file}: Android-related path in a ${origin} that is not listed as a permitted shared file`);
    }
  }
}
if (strict) for (const file of awaiting) problems.push(`${file}: awaiting the owner's publication decision`);

if (awaiting.size && !strict) {
  console.warn(`[android-publication] ${awaiting.size} Android-related path(s) await the owner's decision and are not approved by this check:`);
  for (const file of [...awaiting].sort()) console.warn(`  ${file}`);
}
if (problems.length) {
  console.error('[android-publication] Android project files must remain local:');
  for (const problem of [...new Set(problems)].sort()) console.error(`  ${problem}`);
  console.error('Remove them from the outgoing commits before pushing. Only compiled Android binaries are published, as assets of the Android release.');
  process.exit(1);
}
console.log(`[android-publication] No Android project files in ${[...sources.keys()].join(' or ')}.`);
