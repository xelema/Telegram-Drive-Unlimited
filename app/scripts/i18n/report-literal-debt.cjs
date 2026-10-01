const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const appRoot = path.resolve(__dirname, '../..');
const sourceRoot = path.join(appRoot, 'src');
const english = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'i18n/locales/en.json'), 'utf8'));

function flatten(value, prefix = '', output = new Map()) {
  for (const [key, entry] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === 'string') {
      const keys = output.get(entry) || [];
      keys.push(fullKey);
      output.set(entry, keys);
    } else if (entry && typeof entry === 'object') flatten(entry, fullKey, output);
  }
  return output;
}

function sourceFiles(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'dev') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(fullPath, output);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|generated)\./.test(entry.name)) output.push(fullPath);
  }
  return output;
}

const values = flatten(english);
let findings = 0;
let uniqueMatches = 0;
let ambiguousMatches = 0;
let unmatched = 0;
const unmatchedValues = new Set();

for (const file of sourceFiles(sourceRoot)) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function classify(text) {
    if (!text || !/[A-Za-z]/.test(text)) return;
    findings += 1;
    const keys = values.get(text.trim()) || [];
    if (keys.length === 1) uniqueMatches += 1;
    else if (keys.length > 1) ambiguousMatches += 1;
    else {
      unmatched += 1;
      unmatchedValues.add(text.trim());
    }
  }
  function visit(node) {
    if (ts.isJsxText(node)) classify(node.getText().trim());
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText();
      if (['placeholder', 'title', 'aria-label', 'aria-description', 'alt'].includes(name)) classify(node.initializer.text.trim());
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

console.log(JSON.stringify({ findings, uniqueMatches, ambiguousMatches, unmatched, uniqueUnmatched: unmatchedValues.size }, null, 2));
