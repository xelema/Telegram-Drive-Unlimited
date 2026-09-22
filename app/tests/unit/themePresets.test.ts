import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_THEMES } from '../../src/theme/presets';
import { applyTheme, contrastRatio, ensureAccessiblePalette, removeCustomTheme } from '../../src/theme/themeEngine';

const newThemeIds = ['amoled', 'ocean', 'forest', 'plum', 'paper', 'rose', 'mint', 'sky'];

// Match the engine's sRGB raised surfaces and translucent muted text.
function mix(foreground: string, background: string, opacity: number): string {
  return '#' + [1, 3, 5].map(offset => {
    const channel = parseInt(foreground.slice(offset, offset + 2), 16) * opacity
      + parseInt(background.slice(offset, offset + 2), 16) * (1 - opacity);
    return Math.round(channel).toString(16).padStart(2, '0');
  }).join('');
}

afterEach(removeCustomTheme);

describe('additional built-in themes', () => {
  it.each(newThemeIds)('%s keeps readable text and controls without fallback color substitution', id => {
    const theme = BUILTIN_THEMES.find(theme => theme.id === id)!;
    expect(theme.isBuiltin).toBe(true);
    const palette = ensureAccessiblePalette(theme.palette);
    expect(palette).toEqual(theme.palette);
    const backgrounds = [palette.bg, palette.surface, mix(palette.surface, palette.text, 0.94)];
    for (const background of backgrounds) {
      for (const color of [palette.text, palette.subtext, palette.primary, palette.secondary]) {
        expect(contrastRatio(color, background), `${id}: ${color} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(mix(palette.subtext, background, 0.72), background), `${id}: muted text`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.border, background), `${id}: control border`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(newThemeIds)('%s renders readable accent button labels in its selected mode', id => {
    const theme = BUILTIN_THEMES.find(theme => theme.id === id)!;
    applyTheme(theme);
    const style = document.getElementById('dynamic-theme')!.textContent!;
    const label = style.match(/--color-app-accent-contrast: (#[0-9a-f]{6});/)![1];
    expect(contrastRatio(label, theme.palette.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(label, mix(theme.palette.primary, theme.palette.text, 0.86))).toBeGreaterThanOrEqual(4.5);
    expect(document.documentElement.classList.contains(theme.isDark ? 'dark' : 'light')).toBe(true);
    expect(document.documentElement.dataset.themeContrastAdjusted).toBe('false');
  });
});
