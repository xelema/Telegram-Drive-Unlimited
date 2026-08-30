const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(process.argv[2] || '.');
const repositoryRoot = path.resolve(__dirname, '..');
const policyPath = path.join(repositoryRoot, 'dependency-policy', 'npm-audit-allowlist.json');
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const expiry = new Date(`${policy.expires}T23:59:59Z`);
const usesReviewedBaseline = path.basename(projectRoot) === 'app';
const reviewedAdvisories = new Map(
  Object.entries(policy.advisories).map(([identifier, rationale]) => [identifier.toUpperCase(), rationale]),
);

if (!Number.isFinite(expiry.valueOf()) || expiry < new Date()) {
  throw new Error(`The npm advisory baseline expired on ${policy.expires}; review and reduce it before continuing.`);
}

const result = spawnSync('npm', ['audit', '--json'], { cwd: projectRoot, encoding: 'utf8' });
let report;
try {
  report = JSON.parse(result.stdout || '{}');
} catch {
  process.stderr.write(result.stderr || result.stdout || 'npm audit returned unreadable output.\n');
  process.exit(1);
}

if (
  result.error
  || report.error
  || !report.vulnerabilities
  || typeof report.vulnerabilities !== 'object'
  || !report.metadata
  || typeof report.metadata.vulnerabilities !== 'object'
) {
  const detail = report.error?.summary
    || report.error?.detail
    || report.message
    || result.error?.message
    || result.stderr
    || 'npm audit did not return a complete advisory report.';
  console.error(`[audit] Advisory service failure: ${String(detail).trim()}`);
  process.exit(1);
}

const findings = [];
for (const vulnerability of Object.values(report.vulnerabilities || {})) {
  for (const advisory of vulnerability.via || []) {
    if (typeof advisory === 'string') continue;
    const match = String(advisory.url || '').match(/(GHSA-[\w-]+)/i);
    const identifier = match?.[1]?.toUpperCase() || `npm:${advisory.source}`;
    findings.push({ identifier, package: vulnerability.name, severity: advisory.severity });
  }
}

const unexpected = findings.filter((finding) => !usesReviewedBaseline || !reviewedAdvisories.has(finding.identifier));
const stale = usesReviewedBaseline
  ? [...reviewedAdvisories.keys()].filter((identifier) => !findings.some((finding) => finding.identifier === identifier))
  : [];

for (const finding of findings) {
  const status = usesReviewedBaseline && reviewedAdvisories.has(finding.identifier) ? 'ALLOWED-BASELINE' : 'NEW';
  console.log(`[${status}] ${finding.identifier} ${finding.severity} via ${finding.package}`);
}
for (const identifier of stale) console.error(`[STALE] ${identifier} is no longer reported and must be removed from the allowlist.`);

if (unexpected.length || stale.length) {
  console.error(`[audit] ${unexpected.length} new and ${stale.length} stale advisory entries require review.`);
  process.exit(1);
}

console.log(`[audit] Current advisories match the reviewed temporary baseline through ${policy.expires}.`);
