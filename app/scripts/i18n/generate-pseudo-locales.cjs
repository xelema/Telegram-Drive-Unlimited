const fs = require('fs');
const path = require('path');
const { loadLocale } = require('./shared.cjs');

const OUTPUT_DIR = path.join(__dirname, '../../src/i18n/generated');

function padAccent(str) {
  const map = { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' };
  let result = str.replace(/[aeiouAEIOU]/g, m => map[m] || m);
  // Expand length ~35%
  const padding = ' ~' + 'x'.repeat(Math.ceil(str.length * 0.35)) + '~';
  return `[${result}${padding}]`;
}

function padRtl(str) {
  return `\u202E[AR-XB] ${str}\u202C`;
}

function generatePseudo() {
  const en = loadLocale('en');
  const flatEn = en.flat;

  const enXA = {};
  const arXB = {};

  for (const [key, val] of Object.entries(flatEn)) {
    if (typeof val === 'string') {
      enXA[key] = padAccent(val);
      arXB[key] = padRtl(val);
    }
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'en-XA.json'), JSON.stringify(enXA, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'ar-XB.json'), JSON.stringify(arXB, null, 2), 'utf8');

  console.log('[PASS] Generated pseudo-locales (en-XA, ar-XB) in src/i18n/generated/');
}

generatePseudo();
