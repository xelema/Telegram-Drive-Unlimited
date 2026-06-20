const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, 'src', 'i18n', 'locales');
const baseFile = path.join(localesDir, 'en.json');

if (!fs.existsSync(baseFile)) {
  console.error('Base locale file (en.json) not found!');
  process.exit(1);
}

const baseData = JSON.parse(fs.readFileSync(baseFile, 'utf8'));

function getFlatKeys(obj, prefix = '') {
  let keys = [];
  for (const k in obj) {
    const keyPath = prefix ? `${prefix}.${k}` : k;
    if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
      keys = keys.concat(getFlatKeys(obj[k], keyPath));
    } else {
      // i18next plural keys: ignore suffix differences for comparision
      // e.g., key_one, key_few, key_many, key_other, key_zero are considered variations of the same base key
      const baseKey = keyPath.replace(/_(one|few|many|other|zero)$/, '');
      if (!keys.includes(baseKey)) {
        keys.push(baseKey);
      }
    }
  }
  return keys;
}

const baseKeys = getFlatKeys(baseData).sort();
let failed = false;

const files = fs.readdirSync(localesDir).filter(f => f.endsWith('.json') && f !== 'en.json');

for (const file of files) {
  const filePath = path.join(localesDir, file);
  try {
    const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const fileKeys = getFlatKeys(fileData);
    
    const missing = baseKeys.filter(k => !fileKeys.some(fk => fk === k));
    const extra = fileKeys.filter(k => !baseKeys.some(bk => bk === k));

    if (missing.length > 0) {
      console.error(`\x1b[31m[FAIL]\x1b[0m ${file} is missing keys:`, missing);
      failed = true;
    }
    if (extra.length > 0) {
      console.warn(`\x1b[33m[WARN]\x1b[0m ${file} has extra keys:`, extra);
    }
    
    if (missing.length === 0) {
      console.log(`\x1b[32m[PASS]\x1b[0m ${file} matches en.json structure.`);
    }
  } catch (e) {
    console.error(`\x1b[31m[ERROR]\x1b[0m Failed to parse ${file}:`, e.message);
    failed = true;
  }
}

if (failed) {
  console.error('\nLocale structure check failed!');
  process.exit(1);
} else {
  console.log('\nAll locale files matched successfully.');
}
