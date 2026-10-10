// Fails ahead of time when a reviewed dependency baseline is about to expire.
// The release gate rejects an expired baseline outright; this check gives the
// maintainer notice while there is still time to review it.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let warnDays = 14;
let policyRoot = path.resolve(__dirname, '..', 'dependency-policy');
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--warn-days') {
    warnDays = Number(args[index + 1]);
    index += 1;
  } else {
    policyRoot = path.resolve(args[index]);
  }
}
if (!Number.isInteger(warnDays) || warnDays < 0) {
  throw new Error('--warn-days must be a non-negative whole number.');
}

const baselines = ['npm-audit-allowlist.json', 'rust-advisory-baseline.json'];
const dayMs = 24 * 60 * 60 * 1000;
let failed = false;

for (const name of baselines) {
  const policy = JSON.parse(fs.readFileSync(path.join(policyRoot, name), 'utf8'));
  const expiry = new Date(`${policy.expires}T23:59:59Z`);
  if (!Number.isFinite(expiry.valueOf())) {
    console.error(`[baseline-expiry] ${name} has no valid "expires" date.`);
    failed = true;
    continue;
  }
  const remaining = Math.floor((expiry.valueOf() - Date.now()) / dayMs);
  if (remaining < 0) {
    console.error(`[baseline-expiry] ${name} expired on ${policy.expires}; releases are blocked until it is reviewed.`);
    failed = true;
  } else if (remaining < warnDays) {
    console.error(`[baseline-expiry] ${name} expires on ${policy.expires} (${remaining} day(s) left); review it before the release gate starts failing.`);
    failed = true;
  } else {
    console.log(`[baseline-expiry] ${name} is valid through ${policy.expires} (${remaining} day(s) left).`);
  }
}

if (failed) process.exit(1);
