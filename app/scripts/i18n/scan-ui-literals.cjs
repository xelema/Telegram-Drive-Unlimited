const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const SRC_DIR = path.join(__dirname, '../../src');
const ALLOWLIST_PATH = path.join(__dirname, '../../src/i18n/literal-allowlist.json');
const BUDGET_PATH = path.join(__dirname, '../../src/i18n/literal-budget.json');

function loadAllowlist() {
  if (fs.existsSync(ALLOWLIST_PATH)) {
    return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')).allowlist || [];
  }
  return [];
}

function getAllFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      if (file !== 'dev' && file !== 'node_modules') {
        getAllFiles(filePath, fileList);
      }
    } else if (filePath.endsWith('.tsx') || filePath.endsWith('.ts')) {
      if (!filePath.endsWith('.generated.ts') && !filePath.endsWith('.test.ts') && !filePath.endsWith('.test.tsx')) {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

function scanFile(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];

  function visit(node) {
    // JSX Text with letters
    if (ts.isJsxText(node)) {
      const text = node.getText().trim();
      if (text && /[a-zA-Z]/.test(text) && !/^[\s\d\W]+$/.test(text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        findings.push({ line: line + 1, text, type: 'jsx_text' });
      }
    }

    // JSX Attributes like placeholder, title, aria-label
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const attrName = node.name.getText();
      if (['placeholder', 'title', 'aria-label', 'aria-description', 'alt'].includes(attrName)) {
        const text = node.initializer.text.trim();
        if (text && /[a-zA-Z]/.test(text)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          findings.push({ line: line + 1, text, type: `attribute:${attrName}` });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function runScanner() {
  const files = getAllFiles(SRC_DIR);
  const allowlist = loadAllowlist();
  const allowSet = new Set(allowlist.map(item => `${item.file}:${item.literal}`));

  let totalFindings = 0;
  const fileFindingsMap = {};

  for (const file of files) {
    const relativePath = path.relative(path.join(__dirname, '../..'), file);
    const findings = scanFile(file);
    const unallowed = findings.filter(f => !allowSet.has(`${relativePath}:${f.text}`));

    if (unallowed.length > 0) {
      fileFindingsMap[relativePath] = unallowed;
      totalFindings += unallowed.length;
    }
  }

  if (totalFindings > 0) {
    console.log(`\n=== UI Literal Scanner Findings (${totalFindings} items in ${Object.keys(fileFindingsMap).length} files) ===`);
    for (const [file, items] of Object.entries(fileFindingsMap)) {
      console.log(`\nFile: ${file}`);
      for (const item of items) {
        console.log(`  L${item.line} [${item.type}]: "${item.text}"`);
      }
    }
    console.log('\nNote: Unextracted literals detected in shipping components. Extract them in Phase 3.');
  } else {
    console.log('[PASS] UI Literal Scanner found zero unextracted shipping literals.');
  }

  if (fs.existsSync(BUDGET_PATH)) {
    const budget = JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8')).maxFindings;
    if (!Number.isInteger(budget) || budget < 0) {
      throw new Error('src/i18n/literal-budget.json must define a non-negative integer maxFindings.');
    }
    if (totalFindings > budget) {
      console.error(`\n[FAIL] UI literal debt increased from the ${budget}-item budget to ${totalFindings}.`);
      process.exitCode = 1;
    } else {
      console.log(`[PASS] UI literal debt is within the ${budget}-item no-regression budget.`);
    }
  }
}

runScanner();
