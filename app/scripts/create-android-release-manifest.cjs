#!/usr/bin/env node

const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { basename } = require('node:path');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

for (const required of ['--apk', '--version', '--version-code', '--repository', '--tag', '--output']) {
  if (!args.get(required)) throw new Error(`Missing ${required}`);
}

const apk = args.get('--apk');
const filename = basename(apk);
const digest = createHash('sha256').update(readFileSync(apk)).digest('hex');
const repository = args.get('--repository');
const tag = args.get('--tag');
const manifest = {
  schema: 1,
  packageName: 'com.cameronamer.telegramdrive',
  version: args.get('--version'),
  versionCode: Number.parseInt(args.get('--version-code'), 10),
  url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`,
  sha256: digest,
  filename,
};

if (!Number.isSafeInteger(manifest.versionCode) || manifest.versionCode < 1) {
  throw new Error('version-code must be a positive integer');
}

writeFileSync(args.get('--output'), `${JSON.stringify(manifest, null, 2)}\n`);
