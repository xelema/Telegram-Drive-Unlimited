const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const policy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'dependency-policy', 'rust-advisory-baseline.json'), 'utf8'));
const deny = fs.readFileSync(path.join(repositoryRoot, 'deny.toml'), 'utf8');
const expiry = new Date(`${policy.expires}T23:59:59Z`);

if (!Number.isFinite(expiry.valueOf()) || expiry < new Date()) {
  throw new Error(`The Rust advisory baseline expired on ${policy.expires}; review and reduce it before continuing.`);
}

const configuredAdvisories = [...deny.matchAll(/\bid\s*=\s*"(RUSTSEC-\d{4}-\d{4})"/g)]
  .map(match => match[1])
  .sort();
const reviewedAdvisories = Object.keys(policy.advisories).sort();
if (JSON.stringify(configuredAdvisories) !== JSON.stringify(reviewedAdvisories)) {
  throw new Error(`deny.toml RustSec ignores do not exactly match the reviewed baseline: ${configuredAdvisories.join(', ')}`);
}

for (const [identifier, rationale] of Object.entries({ ...policy.advisories, ...policy.yankedCrates })) {
  if (typeof rationale !== 'string' || rationale.trim().length < 20) {
    throw new Error(`${identifier} is missing a substantive review rationale.`);
  }
  if (!(identifier in policy.advisories) && !deny.includes(`crate = "${identifier}"`)) {
    throw new Error(`${identifier} is reviewed but missing from deny.toml.`);
  }
}

if (!deny.includes('unmaintained = "workspace"')) {
  throw new Error('Direct unmaintained workspace dependencies must remain denied.');
}

console.log(`[rust-advisories] Exact reviewed baseline is valid through ${policy.expires}.`);
