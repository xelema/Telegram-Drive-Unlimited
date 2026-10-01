import type { CustomTheme } from './themeEngine';

type PaletteColors = [bg: string, surface: string, primary: string, secondary: string, text: string, subtext: string];

// Shared metadata and neutral overlays keep the built-in catalog small at startup.
function preset(
  id: string,
  name: string,
  isDark: boolean,
  [bg, surface, primary, secondary, text, subtext]: PaletteColors,
  border = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.1)',
  hover = isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.04)',
): CustomTheme {
  return { id, name, isDark, isBuiltin: true, palette: { bg, surface, primary, secondary, text, subtext, border, hover } };
}

/** Built-in theme presets. Keep existing IDs and palettes stable for saved selections. */
export const BUILTIN_THEMES: CustomTheme[] = [
  preset('default-dark', 'Default Dark', true,
    ['#101114', '#1b1c20', '#2aabee', '#63a9ff', '#f7f7f5', '#b2b3ba'],
    'rgba(255, 255, 255, 0.1)', 'rgba(255, 255, 255, 0.055)'),
  preset('charcoal', 'Charcoal', true,
    ['#1e1e2e', '#282838', '#6c63ff', '#a78bfa', '#e4e4ef', '#8888a8']),
  preset('nord', 'Nord', true,
    ['#2e3440', '#3b4252', '#88c0d0', '#81a1c1', '#eceff4', '#a3b1c6']),
  preset('monokai', 'Monokai', true,
    ['#272822', '#2f302a', '#a6e22e', '#66d9ef', '#f8f8f2', '#90908a']),
  preset('cyber-teal', 'Cyber Teal', true,
    ['#0a1628', '#112240', '#00e5bf', '#00b4d8', '#e0f7f4', '#6faaaf'],
    'rgba(0, 229, 191, 0.12)', 'rgba(0, 229, 191, 0.06)'),
  preset('default-light', 'Default Light', false,
    ['#f5f5f2', '#fbfbf9', '#168ac3', '#2479c8', '#1b1c1f', '#5d6068'],
    'rgba(0, 0, 0, 0.1)', 'rgba(27, 28, 31, 0.05)'),
  preset('solarized-light', 'Solarized Light', false,
    ['#fdf6e3', '#eee8d5', '#b58900', '#268bd2', '#073642', '#586e75']),

  // Dark palettes use bright accents with dark labels; light palettes use white labels.
  preset('amoled', 'AMOLED', true,
    ['#000000', '#101417', '#70e4c1', '#8ecbff', '#f2f7f5', '#a9bbb6'], '#687d75'),
  preset('ocean', 'Ocean', true,
    ['#081724', '#122b3d', '#81d4fa', '#a9bcff', '#eef8ff', '#b7ccda'], '#67849a'),
  preset('forest', 'Forest', true,
    ['#101d17', '#1b3024', '#a5d6a7', '#ddcc89', '#f1f7ef', '#becfbb'], '#74917b'),
  preset('plum', 'Plum', true,
    ['#211526', '#34223c', '#ddb4f8', '#f5b4d0', '#fcf2ff', '#d8c1df'], '#9879a5'),
  preset('paper', 'Paper', false,
    ['#f4f0e7', '#fffdf7', '#365f82', '#805a35', '#292720', '#393529'], '#87806f'),
  preset('rose', 'Rose', false,
    ['#faf3f5', '#fff9fa', '#9a335a', '#7955a8', '#30232b', '#492937'], '#a47c8d'),
  preset('mint', 'Mint', false,
    ['#f1f8f3', '#fbfefc', '#246848', '#3b647e', '#20342a', '#263d30'], '#6c8b78'),
  preset('sky', 'Sky', false,
    ['#eff6fc', '#fafcff', '#245e9e', '#5c5295', '#233448', '#26394e'], '#6b87a3'),
];

/** Default palette values to seed a new custom theme. */
export function getDefaultPalette(isDark: boolean) {
  const base = isDark
    ? BUILTIN_THEMES.find(t => t.id === 'default-dark')!
    : BUILTIN_THEMES.find(t => t.id === 'default-light')!;
  return { ...base.palette };
}
