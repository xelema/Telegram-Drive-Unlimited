#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
function tagPolicy(tag) {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag || '');
  if (!match || match[2]?.split('.').some(value => /^\d+$/.test(value) && value.length > 1 && value.startsWith('0'))) throw new Error(`Malformed release tag: ${tag}`);
  return { tag, version: tag.slice(1), applicationVersion: match[1], prerelease: Boolean(match[2]), make_latest: match[2] ? 'false' : 'true' };
}
function verify(options) {
  const policy = tagPolicy(options.tag);
  if (options.appRoot) {
    const root = path.resolve(options.appRoot);
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1].match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (version !== policy.applicationVersion || cargo !== version || JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version !== version) throw new Error('Desktop tag base and plain application versions disagree');
  }
  if (options.changelog) {
    const text = fs.readFileSync(options.changelog, 'utf8');
    const first = /^## \[([^\]]+)\].*$/m.exec(text);
    if (!first || first[1] !== policy.applicationVersion) throw new Error(`First changelog block must be ${policy.applicationVersion}, not Unreleased or an older version`);
    const rest = text.slice(first.index + first[0].length);
    const next = /^## \[/m.exec(rest);
    const body = rest.slice(0, next?.index ?? rest.length).trim();
    if (!body) throw new Error('Release changelog body is empty');
    if (options.bodyOutput) fs.writeFileSync(options.bodyOutput, `${body}\n`);
  } else if (options.bodyOutput) throw new Error('--body-output requires --changelog');
  return policy;
}
if (require.main === module) {
  try {
    const options = {};
    const flags = { '--tag': 'tag', '--app-root': 'appRoot', '--changelog': 'changelog', '--body-output': 'bodyOutput' };
    for (let i = 2; i < process.argv.length; i += 2) {
      if (!flags[process.argv[i]] || !process.argv[i + 1]) throw new Error('Expected --tag TAG and optional version/changelog paths');
      options[flags[process.argv[i]]] = process.argv[i + 1];
    }
    console.log(JSON.stringify(verify(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { tagPolicy, verify };
