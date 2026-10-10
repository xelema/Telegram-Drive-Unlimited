const { SUPPORTED_LOCALES, loadLocale, loadInvariantAllowlist } = require('./shared.cjs');
const copiedEnglishBaseline = require('../../src/i18n/copied-english-baseline.json');

function extractVariables(text) {
  return typeof text === 'string' ? (text.match(/\{\{([^}]+)\}\}/g) || []).map(value => value.trim()).sort() : [];
}

// Pure label structure contains no copied prose. Strip only recognized balanced
// interpolation tokens; all variables and locale/plural checks still apply.
function hasStaticWords(text) {
  return typeof text === 'string' && /\p{L}/u.test(text.replace(/\{\{([^}]+)\}\}/g, ''));
}

function validate() {
  const errors = [];
  const warnings = [];
  const copiedEnglishCounts = {};
  const invariants = loadInvariantAllowlist();
  const allowKeys = new Set(invariants.keys || []);
  const allowTokens = new Set(invariants.tokens || []);
  const largeLocales = new Set(['ar', 'de', 'es', 'fr', 'hi', 'id', 'ko', 'pt-BR', 'ru', 'tr', 'zh-CN']);
  function copyExempt(locale, key, value) {
    // Older global exceptions included live Folder Sync prose. These release
    // locales must translate it even while other locales retain that debt.
    if (largeLocales.has(locale) && (key === 'settings.tab_sync' || /^(settings\.sync|sync\.status|sync\.conflict)\./.test(key))) return false;
    return allowKeys.has(key) || allowTokens.has(value) || (invariants.localeKeys?.[locale] || []).includes(key);
  }

  let en;
  try { en = loadLocale('en'); }
  catch (error) { console.error(`[en] [json_invalid] ${error.message}`); process.exit(1); }
  // A lone enum key such as activity.category_other is not a plural family.
  const pluralBases = new Set(Object.keys(en.flat)
    .filter(key => key.endsWith('_one') && en.flat[key.slice(0, -4) + '_other'] !== undefined)
    .map(key => key.slice(0, -4)));
  const pluralFor = key => {
    const match = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
    return match && pluralBases.has(match[1]) ? match : null;
  };
  function checkValue(locale, key, value, reference, plural) {
    if (typeof value !== 'string') { errors.push(`[${locale}] [type_mismatch] ${key} — expected string`); return; }
    if (!value.trim()) errors.push(`[${locale}] [empty_value] ${key} — translation is empty or whitespace`);
    if (value.includes('__TODO_TRANSLATE__')) errors.push(`[${locale}] [draft_marker] ${key} — contains a draft marker`);
    // Natural zero/singular/dual forms may state their number without {{count}}.
    // Every other interpolation remains mandatory, including extra plural forms.
    const variables = text => extractVariables(text).filter(variable => !plural || variable !== '{{count}}');
    if (JSON.stringify(variables(reference)) !== JSON.stringify(variables(value))) {
      errors.push(`[${locale}] [variable_mismatch] ${key} — expected [${variables(reference)}], found [${variables(value)}]`);
    }
  }
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === 'en') continue;
    let target;
    try { target = loadLocale(locale); }
    catch (error) { errors.push(`[${locale}] [json_invalid] ${error.message}`); continue; }
    copiedEnglishCounts[locale] = 0;
    const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    for (const base of pluralBases) {
      for (const category of categories) {
        const key = `${base}_${category}`;
        if (target.flat[key] === undefined) errors.push(`[${locale}] [plural_missing] ${key} — required ${category} form`);
      }
    }
    for (const [key, reference] of Object.entries(en.flat)) {
      const value = target.flat[key];
      if (value === undefined) {
        if (!pluralFor(key)) errors.push(`[${locale}] [key_missing] ${key} — missing from locale resource`);
        continue;
      }
      checkValue(locale, key, value, reference, Boolean(pluralFor(key)));
      if (hasStaticWords(reference) && reference === value && typeof value === 'string' && value.trim() && !copyExempt(locale, key, value)) copiedEnglishCounts[locale]++;
    }
    for (const [key, value] of Object.entries(target.flat)) {
      if (en.flat[key] !== undefined) continue;
      const plural = pluralFor(key);
      if (!plural || !categories.includes(plural[2])) {
        errors.push(`[${locale}] [unexpected_key] ${key} — not found in English or a supported plural family`);
      } else {
        const referenceKey = plural[1] + '_other';
        const reference = en.flat[referenceKey];
        checkValue(locale, key, value, reference, true);
        if (hasStaticWords(reference) && reference === value && typeof value === 'string' && value.trim() && !copyExempt(locale, key, value) && !copyExempt(locale, referenceKey, value)) copiedEnglishCounts[locale]++;
      }
    }
  }
  for (const [locale, count] of Object.entries(copiedEnglishCounts)) {
    const baseline = copiedEnglishBaseline[locale];
    if (!Number.isInteger(baseline) || baseline < 0) errors.push(`[${locale}] [baseline_missing] copied-English baseline is not defined`);
    else if (count > baseline) errors.push(`[${locale}] [copied_english_regression] ${count} copied-English values exceed ${baseline}`);
    else if (count > 0) warnings.push(`[${locale}] [copied_english_debt] ${count} values remain identical to English (baseline ${baseline})`);
  }
  if (warnings.length) console.log(`--- i18n Validation Warnings (${warnings.length}) ---\n${warnings.join('\n')}`);
  if (errors.length) { console.error(`=== i18n Validation Errors (${errors.length}) ===\n${errors.join('\n')}`); process.exit(1); }
  console.log('[PASS] All locale files passed structure, plural forms, variables, and type validation.');
}
validate();
