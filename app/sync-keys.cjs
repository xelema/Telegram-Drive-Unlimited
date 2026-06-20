const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, 'src', 'i18n', 'locales');
const baseFile = path.join(localesDir, 'en.json');
const baseData = JSON.parse(fs.readFileSync(baseFile, 'utf8'));

function syncObjects(source, target) {
  let updated = false;
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
        updated = true;
      }
      if (syncObjects(source[key], target[key])) {
        updated = true;
      }
    } else {
      if (target[key] === undefined) {
        target[key] = source[key];
        updated = true;
      }
    }
  }
  return updated;
}

const files = fs.readdirSync(localesDir).filter(f => f.endsWith('.json') && f !== 'en.json');

for (const file of files) {
  const filePath = path.join(localesDir, file);
  const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (syncObjects(baseData, fileData)) {
    fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2) + '\n', 'utf8');
    console.log(`Synced ${file}`);
  } else {
    console.log(`No changes for ${file}`);
  }
}
