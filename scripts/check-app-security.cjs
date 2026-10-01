// Validate actual application configuration without a unit-test framework.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'app');
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const config = json('src-tauri/tauri.conf.json');
const csp = config.app?.security?.csp;
if (typeof csp !== 'string') throw new Error('A production WebView CSP is required.');
const directives = new Map(csp.split(';').map(value => value.trim()).filter(Boolean).map(value => {
  const [name, ...sources] = value.split(/\s+/);
  return [name, sources];
}));
const scripts = directives.get('script-src') || [];
if (!scripts.includes("'self'") || scripts.some(value => ["'unsafe-inline'", "'unsafe-eval'", '*'].includes(value))) {
  throw new Error('WebView scripts must be self-hosted without inline/eval/wildcard execution.');
}
for (const [name, expected] of [['object-src', "'none'"], ['base-uri', "'self'"], ['form-action', "'self'"]]) {
  const sources = directives.get(name);
  if (sources?.length !== 1 || sources[0] !== expected) throw new Error(`Invalid ${name} restriction.`);
}
const mobile = json('src-tauri/capabilities/mobile.json');
const desktop = json('src-tauri/capabilities/default.json');
if (mobile.platforms?.length !== 1 || mobile.platforms[0] !== 'android') {
  throw new Error('Mobile capabilities must remain restricted to Android.');
}
if (desktop.platforms?.length !== 3 || !['linux', 'macOS', 'windows'].every(value => desktop.platforms.includes(value))) {
  throw new Error('Desktop capabilities must remain restricted to desktop platforms.');
}
if (!desktop.permissions?.includes('updater:default')) throw new Error('Signed desktop updater permission is required.');
if (![mobile.identifier, desktop.identifier].every(value => config.app.security.capabilities.includes(value))) {
  throw new Error('The application must declare its platform-specific capabilities.');
}
console.log('[app-security] WebView CSP and platform capability configuration passed.');
