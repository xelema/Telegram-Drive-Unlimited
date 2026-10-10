const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..', '.github/workflows');
let count = 0;
for (const name of fs.readdirSync(root).filter(name => /\.ya?ml$/.test(name))) {
  const text = fs.readFileSync(path.join(root, name), 'utf8');
  for (const match of text.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
    const action = match[1].replace(/^['"]|['"]$/g, '');
    if (!action.startsWith('./') && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(action)) throw new Error(`${name}: third-party action is not pinned to a full commit: ${action}`);
  }
  count++;
}
const assurance = fs.readFileSync(path.join(root, 'dependency-assurance.yml'), 'utf8');
if (!/\n  schedule:/.test(assurance) || !/\n  baseline-expiry:/.test(assurance)) throw new Error('Scheduled baseline-expiry gate must remain');
const release = fs.readFileSync(path.join(root, 'release.yml'), 'utf8');
for (const platform of ['macos', 'windows']) if (!release.includes(`if: env.PLATFORM_SIGNING == '${platform}'`)) throw new Error(`Missing conditional ${platform} signature gate`);
console.log(`[workflow-pins] ${count} workflow action pins and scheduled/conditional protections passed; workflow execution remains UNRUN.`);
