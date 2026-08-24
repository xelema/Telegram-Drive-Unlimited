#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`Android release version must be plain semantic versioning (x.y.z), received: ${version}`);
  const [, major, minor, patch] = match.map(Number);
  if (minor > 999 || patch > 999) throw new Error('Android minor and patch versions must be at most 999.');
  const versionCode = major * 1_000_000 + minor * 1_000 + patch;
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
    throw new Error(`Computed Android versionCode is outside the supported range: ${versionCode}`);
  }
  return { version, versionCode };
}

function readCargoVersion(contents) {
  const match = /^version\s*=\s*"([^"]+)"/m.exec(contents);
  if (!match) throw new Error('Unable to read the Cargo package version.');
  return match[1];
}

function verifyReleaseVersions({ appRoot, tag, previousManifest, generatedProperties }) {
  const packageVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
  const tauriVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'src-tauri/tauri.conf.json'), 'utf8')).version;
  const cargoVersion = readCargoVersion(fs.readFileSync(path.join(appRoot, 'src-tauri/Cargo.toml'), 'utf8'));
  const parsed = parseVersion(packageVersion);
  const expectedTag = `v${packageVersion}`;
  const mismatches = [];
  if (tag && tag !== expectedTag) mismatches.push(`release tag ${tag} must equal ${expectedTag}`);
  if (tauriVersion !== packageVersion) mismatches.push(`tauri.conf.json version ${tauriVersion} must equal ${packageVersion}`);
  if (cargoVersion !== packageVersion) mismatches.push(`Cargo.toml version ${cargoVersion} must equal ${packageVersion}`);

  if (generatedProperties) {
    const properties = fs.readFileSync(generatedProperties, 'utf8');
    const generatedName = /^tauri\.android\.versionName=(.+)$/m.exec(properties)?.[1]?.trim();
    const generatedCode = Number(/^tauri\.android\.versionCode=(\d+)$/m.exec(properties)?.[1]);
    if (generatedName !== packageVersion) mismatches.push(`generated Android versionName ${generatedName || 'missing'} must equal ${packageVersion}`);
    if (generatedCode !== parsed.versionCode) mismatches.push(`generated Android versionCode ${generatedCode || 'missing'} must equal ${parsed.versionCode}`);
  }

  if (previousManifest) {
    const previous = JSON.parse(fs.readFileSync(previousManifest, 'utf8'));
    if (previous.packageName !== 'com.cameronamer.telegramdrive') {
      mismatches.push('previous Android update manifest has the wrong package name');
    }
    if (!Number.isSafeInteger(previous.versionCode) || parsed.versionCode <= previous.versionCode) {
      mismatches.push(`Android versionCode ${parsed.versionCode} must be greater than the previous release ${previous.versionCode}`);
    }
  }

  if (mismatches.length) throw new Error(mismatches.join('\n'));
  return parsed;
}

if (require.main === module) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const appRoot = path.resolve(__dirname, '..');
  const result = verifyReleaseVersions({
    appRoot,
    tag: args.get('--tag'),
    previousManifest: args.get('--previous-manifest'),
    generatedProperties: args.get('--generated-properties'),
  });
  console.log(`Android release version passed: ${result.version} (versionCode ${result.versionCode}).`);
}

module.exports = { parseVersion, readCargoVersion, verifyReleaseVersions };
