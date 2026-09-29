import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

/** Derive two modules from the single canonical English catalog. */
export function englishTranslationChunks(): Plugin {
  return {
    name: 'english-translation-chunks',
    enforce: 'pre',
    async load(id) {
      const match = id.match(/^(.*[\\/]src[\\/]i18n[\\/]locales[\\/]en\.json)\?(core|supporter)$/);
      if (!match) return;
      this.addWatchFile(match[1]);
      const catalog = JSON.parse(await readFile(match[1], 'utf8')) as Record<string, unknown>;
      const supporter = new Set(['supporter_license', 'supporter_offer']);
      // Vite's normal JSON transform handles the filtered data in dev and builds.
      return JSON.stringify(Object.fromEntries(Object.entries(catalog).filter(([key]) => supporter.has(key) === (match[2] === 'supporter'))));
    },
  };
}
