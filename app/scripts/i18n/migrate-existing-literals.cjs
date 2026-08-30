const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const appRoot = path.resolve(__dirname, '../..');
const sourceRoot = path.join(appRoot, 'src');
const english = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'i18n/locales/en.json'), 'utf8'));
const allowlist = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'i18n/literal-allowlist.json'), 'utf8')).allowlist || [];
const allowed = new Set(allowlist.map((item) => `${item.file}:${item.literal}`));

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
function normalize(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('…', '...')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
const normalizedValues = new Map();
for (const [value, keys] of values) {
  const normalized = normalize(value);
  normalizedValues.set(normalized, [...new Set([...(normalizedValues.get(normalized) || []), ...keys])]);
}
let replacements = 0;

for (const file of sourceFiles(sourceRoot)) {
  const original = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const relativeFile = path.relative(appRoot, file).split(path.sep).join('/');
  const edits = [];

  function keyFor(text) {
    if (!text || !/[A-Za-z]/.test(text) || allowed.has(`${relativeFile}:${text}`)) return null;
    const keys = values.get(text.trim()) || normalizedValues.get(normalize(text)) || [];
    return keys.length === 1 ? keys[0] : null;
  }

  function visit(node) {
    if (ts.isJsxText(node)) {
      const raw = node.getText();
      const text = raw.trim();
      const key = keyFor(text);
      if (key) {
        const startOffset = raw.indexOf(text);
        edits.push({ start: node.getStart() + startOffset, end: node.getStart() + startOffset + text.length, replacement: `{i18n.t(${JSON.stringify(key)})}` });
      }
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const attribute = node.name.getText();
      if (['placeholder', 'title', 'aria-label', 'aria-description', 'alt'].includes(attribute)) {
        const key = keyFor(node.initializer.text.trim());
        if (key) edits.push({ start: node.initializer.getStart(), end: node.initializer.getEnd(), replacement: `{i18n.t(${JSON.stringify(key)})}` });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!edits.length) continue;

  let next = original;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    next = `${next.slice(0, edit.start)}${edit.replacement}${next.slice(edit.end)}`;
  }

  if (!/import\s+i18n\s+from\s+['"]/.test(next)) {
    const importPath = path.relative(path.dirname(file), path.join(sourceRoot, 'i18n')).split(path.sep).join('/');
    const specifier = importPath.startsWith('.') ? importPath : `./${importPath}`;
    const imports = source.statements.filter(ts.isImportDeclaration);
    const insertAt = imports.length ? imports[imports.length - 1].getEnd() : 0;
    next = `${next.slice(0, insertAt)}\nimport i18n from '${specifier}';${next.slice(insertAt)}`;
  }

  fs.writeFileSync(file, next);
  replacements += edits.length;
  console.log(`[i18n] ${relativeFile}: ${edits.length}`);
}

console.log(`[i18n] Migrated ${replacements} literal occurrences to existing reviewed translation keys.`);
