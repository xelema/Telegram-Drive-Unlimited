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

  const foundPositions = new Set();
  const textAttributes = new Set(['placeholder', 'title', 'aria-label', 'aria-description', 'alt']);
  const dialogFields = new Set(['title', 'message', 'description', 'confirmText', 'cancelText', 'confirmLabel', 'cancelLabel']);
  function add(node, text, type) {
    text = text.trim();
    if (!text || !/[a-zA-Z]/.test(text) || foundPositions.has(node.pos)) return;
    foundPositions.add(node.pos);
    const {line} = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    findings.push({line: line + 1, start:node.getStart(), end:node.getEnd(), text, type});
  }
  // Follow only values that are actually presented. Translation calls and
  // arbitrary option objects are not literals; variant:'danger' is not copy.
  function visible(node, type) {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text, type);
    else if (ts.isTemplateExpression(node)) {
      const staticText = node.head.text + node.templateSpans.map(span => span.literal.text).join('');
      if (/[a-zA-Z]/.test(staticText)) add(node, node.getText(), type + ':template');
    } else if (ts.isConditionalExpression(node)) {visible(node.whenTrue, type);visible(node.whenFalse, type);}
    else if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {visible(node.left, type);visible(node.right, type);}
      else if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {visible(node.left, type);visible(node.right, type);}
      else if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) visible(node.right, type);
    }
    else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) visible(node.expression, type);
  }
  function options(node, type) {
    if (!node || !ts.isObjectLiteralExpression(node)) return;
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property) && dialogFields.has(property.name.getText().replace(/^['"]|['"]$/g, ''))) visible(property.initializer, type);
    }
  }
  function visit(node) {
    if (ts.isJsxText(node) && !(ts.isJsxElement(node.parent) && node.parent.openingElement.tagName.getText() === 'style')) add(node, node.getText(), 'jsx_text');
    if (ts.isJsxAttribute(node) && node.initializer && textAttributes.has(node.name.getText())) {
      if (ts.isStringLiteral(node.initializer)) add(node.initializer, node.initializer.text, `attribute:${node.name.getText()}`);
      else if (ts.isJsxExpression(node.initializer)) visible(node.initializer.expression, `attribute:${node.name.getText()}`);
    }
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && !(ts.isJsxElement(node.parent) && ['style','script'].includes(node.parent.openingElement.tagName.getText()))) visible(node.expression, 'jsx_expression');
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      const toast = /^(?:toast)(?:\.(?:success|error|info|warning|message|loading))?$/.test(callee);
      const dialog = /^(?:(?:window\.)?(?:confirm|alert|prompt)|promptSecret)$/.test(callee);
      if (toast || dialog) {
        const type = toast ? 'toast' : 'dialog';
        visible(node.arguments[0], type);options(node.arguments[0], type);options(node.arguments[1], type);
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
  const budgetConfig = fs.existsSync(BUDGET_PATH)
    ? JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8'))
    : null;
  const areaBudgets = budgetConfig?.areaBudgets || {};

  function areaFor(relativePath) {
    for (const [area, config] of Object.entries(areaBudgets)) {
      if (area === 'other') continue;
      if (!Array.isArray(config.patterns) || config.patterns.length === 0) {
        throw new Error(`Literal area ${area} must define at least one path pattern.`);
      }
      if (config.patterns.some(pattern => new RegExp(pattern, 'i').test(relativePath))) return area;
    }
    return 'other';
  }

  let totalFindings = 0;
  const fileFindingsMap = {};
  const findingsByArea = {};

  for (const file of files) {
    const relativePath = path.relative(path.join(__dirname, '../..'), file);
    const findings = scanFile(file);
    const unallowed = findings.filter(f => !allowSet.has(`${relativePath}:${f.text}`));

    if (unallowed.length > 0) {
      fileFindingsMap[relativePath] = unallowed;
      totalFindings += unallowed.length;
      const area = areaFor(relativePath);
      findingsByArea[area] = (findingsByArea[area] || 0) + unallowed.length;
    }
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({totalFindings, findingsByArea, files:fileFindingsMap},null,2));
  }

  if (!process.argv.includes('--json') && totalFindings > 0) {
    console.log(`\n=== UI Literal Scanner Findings (${totalFindings} items in ${Object.keys(fileFindingsMap).length} files) ===`);
    for (const [file, items] of Object.entries(fileFindingsMap)) {
      console.log(`\nFile: ${file}`);
      for (const item of items) {
        console.log(`  L${item.line} [${item.type}]: "${item.text}"`);
      }
    }
    console.log('\nNote: Unextracted text remains in shipping UI. The ceilings must only decrease.');
  } else if (!process.argv.includes('--json')) {
    console.log('[PASS] UI Literal Scanner found zero unextracted shipping literals.');
  }

  if (budgetConfig) {
    const budget = budgetConfig.maxFindings;
    if (!Number.isInteger(budget) || budget < 0) {
      throw new Error('src/i18n/literal-budget.json must define a non-negative integer maxFindings.');
    }
    if (totalFindings > budget) {
      console.error(`\n[FAIL] UI literal debt increased from the ${budget}-item budget to ${totalFindings}.`);
      process.exitCode = 1;
    } else {
      console.log(`[PASS] UI literal debt is within the ${budget}-item no-regression budget.`);
    }

    for (const [area, config] of Object.entries(areaBudgets)) {
      if (!Number.isInteger(config.maxFindings) || config.maxFindings < 0) {
        throw new Error(`Literal area ${area} must define a non-negative integer maxFindings.`);
      }
      const actual = findingsByArea[area] || 0;
      if (actual > config.maxFindings) {
        console.error(`[FAIL] ${area} literal debt increased from ${config.maxFindings} to ${actual}.`);
        process.exitCode = 1;
      } else {
        console.log(`[PASS] ${area} literal debt: ${actual} / ${config.maxFindings}.`);
      }
    }
  }
}

runScanner();
