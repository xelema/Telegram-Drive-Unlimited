const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const artifactRoot = path.resolve(process.argv[2] || '.');
const outputPath = path.resolve(process.argv[3] || path.join(artifactRoot, 'SHA256SUMS.txt'));

function filesUnder(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(fullPath));
    else if (entry.isFile() && path.resolve(fullPath) !== outputPath) files.push(fullPath);
  }
  return files;
}

const lines = filesUnder(artifactRoot)
  .sort()
  .map((file) => {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return `${digest}  ${path.relative(artifactRoot, file).split(path.sep).join('/')}`;
  });

if (!lines.length) throw new Error(`No artifacts found under ${artifactRoot}.`);
fs.writeFileSync(outputPath, `${lines.join('\n')}\n`);
console.log(`[checksums] Wrote ${outputPath} for ${lines.length} artifacts.`);
