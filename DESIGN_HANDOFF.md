# Telegram Drive — Design Language & Styling Handoff Specification

## Executive Summary
This document serves as the primary handoff reference and design language specification for **Telegram Drive**. Telegram Drive is a cross-platform (Desktop & Mobile via Tauri 2.0 and React 19) desktop-grade cloud storage interface built on top of Telegram's MTProto API infrastructure.

The design philosophy bridges **Telegram native brand identity** (sleek deep slates, warm amber accents, crisp typography) with **modern desktop visual aesthetics** (glassmorphism, micro-animations, theme presets, dynamic dark/light mode adapting, and low-spec performance fallbacks).

---

## 1. Core Architecture & Design System Stack

| Layer | Technology | Key File / Location |
| :--- | :--- | :--- |
| **Framework** | React 19 + TypeScript + Vite | [app/src/App.tsx](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/App.tsx) |
| **Styling Engine** | Tailwind CSS v4 (`@theme` directive) + Vanilla CSS | [app/src/App.css](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/App.css) |
| **Theme System** | Runtime Dynamic CSS Variable Injector | [app/src/theme/themeEngine.ts](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/theme/themeEngine.ts) |
| **Theme Presets** | Built-in Theme Palette Schema Definitions | [app/src/theme/presets.ts](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/theme/presets.ts) |
| **State & Context** | React Context (`ThemeContext`, `SettingsContext`) | `app/src/context/` |
| **Iconography** | Lucide React + Custom SVG Components | `lucide-react`, [app/src/components/shared/FileTypeIcon.tsx](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/components/shared/FileTypeIcon.tsx) |
| **Animations** | Framer Motion + Keyframe CSS | `framer-motion`, [app/src/App.css](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/App.css) |
| **Notifications** | Sonner Toast Notification Library | `sonner` |

---

## 2. Color Palette & Token Specifications

### 2.1 CSS Theme Variables (`--color-telegram-*`)
The application relies on CSS custom properties defined inside the Tailwind v4 `@theme` block and dynamically modified by `themeEngine.ts`.

```css
@theme {
  --color-telegram-bg: #0e1621;
  --color-telegram-surface: #17212b;
  --color-telegram-primary: #ffae00;
  --color-telegram-secondary: #2481cc;
  --color-telegram-text: #ffffff;
  --color-telegram-subtext: #8e9fb3;
  --color-telegram-border: rgba(255, 255, 255, 0.1);
  --color-telegram-hover: rgba(255, 255, 255, 0.05);
  --color-telegram-glass-bg: #17212b;
  --color-telegram-glass-border: #ffffff;
}
```

### 2.2 Built-in Theme Presets Matrix

| Theme ID | Mode | Background (`bg`) | Surface (`surface`) | Accent Primary (`primary`) | Accent Secondary (`secondary`) | Text (`text`) | Subtext (`subtext`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `default-dark` | Dark | `#0e1621` | `#17212b` | `#ffae00` (Telegram Gold) | `#2481cc` (Telegram Blue) | `#ffffff` | `#8e9fb3` |
| `charcoal` | Dark | `#1e1e2e` | `#282838` | `#6c63ff` (Indigo) | `#a78bfa` (Purple) | `#e4e4ef` | `#8888a8` |
| `nord` | Dark | `#2e3440` | `#3b4252` | `#88c0d0` (Frost Teal) | `#81a1c1` (Frost Blue) | `#eceff4` | `#a3b1c6` |
| `monokai` | Dark | `#272822` | `#2f302a` | `#a6e22e` (Lime Green) | `#66d9ef` (Cyan) | `#f8f8f2` | `#90908a` |
| `cyber-teal` | Dark | `#0a1628` | `#112240` | `#00e5bf` (Neon Teal) | `#00b4d8` (Deep Cyan) | `#e0f7f4` | `#6faaaf` |
| `default-light` | Light | `#f0f2f5` | `#ffffff` | `#e69500` (Warm Amber) | `#2481cc` (Telegram Blue) | `#1a1a1a` | `#65676b` |
| `solarized-light` | Light | `#fdf6e3` | `#eee8d5` | `#b58900` (Yellow Ochre) | `#268bd2` (Solar Blue) | `#073642` | `#586e75` |

---

## 3. Glassmorphism & UI Effect System

### 3.1 Glass Utility Tokens
The app features multi-layered glassmorphic surfaces using CSS `backdrop-filter` combined with `color-mix(in srgb, ...)` for adaptive transparency in both Light and Dark themes.

```css
/* Standard Glass Surface */
.glass {
  background: color-mix(in srgb, var(--color-telegram-glass-bg) 70%, transparent);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid color-mix(in srgb, var(--color-telegram-glass-border) 8%, transparent);
}

/* Authentication Screen Deep Glass */
.auth-glass {
  background: color-mix(in srgb, var(--color-telegram-glass-bg) 85%, transparent);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid color-mix(in srgb, var(--color-telegram-glass-border) 10%, transparent);
}

/* Form Input Glass */
.glass-input {
  background: color-mix(in srgb, var(--color-telegram-glass-bg) 60%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-telegram-glass-border) 10%, transparent);
  backdrop-filter: blur(10px);
}
```

### 3.2 Performance Mode Infrastructure
To ensure smooth rendering on lower-end desktop devices, older hardware, or WebKitGTK Linux environments, a low-overhead **Performance Mode** is implemented.

- **Trigger**: Automatic enablement when OS detects `prefers-reduced-motion` or manual toggle in **Settings → General → Performance Mode**.
- **CSS Strategy**:
  ```css
  .performance-mode *, .performance-mode *::before, .performance-mode *::after {
    transition: none !important;
    animation: none !important;
  }
  .performance-mode .glass, .performance-mode .auth-glass {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  ```

---

## 4. Typography, Hierarchy, & Iconography

### 4.1 Font Stack
- **Primary Font**: `'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
- **Text Smoothing**: Enabled via `-webkit-font-smoothing: antialiased`.

### 4.2 Typographic Hierarchy
- **Modal / Page Title**: `text-xl` to `text-2xl`, `font-bold` / `font-semibold`, tracking normal.
- **Section Headers**: `text-sm` to `text-base`, `font-semibold`, `text-telegram-text`.
- **Body Text**: `text-sm`, `font-normal`, `text-telegram-text` or `text-telegram-subtext`.
- **Metadata / Badges / Captions**: `text-xs`, `font-medium`, `text-telegram-subtext` or opacity modifiers (`text-white/60`).

### 4.3 Iconography Rules
- Primary icons are sourced from `lucide-react`.
- **Icon Sizing Standard**:
  - `14px - 16px`: Inline indicators, file list metadata, badge icons.
  - `18px - 20px`: Sidebar navigation items, toolbar actions, context menu icons.
  - `24px`: Modal header icons, hero action buttons.
  - `32px - 48px`: Empty state placeholders, media player overlays.
- Special overrides exist for high visibility (e.g. `.auth-form-icon` enforces pure white `#ffffff` in dark mode and high-opacity `#000000` in light mode).

---

## 5. Layout Architecture & Key Components

### 5.1 Desktop Layout Architecture
- **Sidebar ([Sidebar.tsx](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/components/desktop/dashboard/Sidebar.tsx))**: Fixed width collapsible left navigation with category filters (All Files, Photos, Videos, Documents, Audio, Archives), storage bandwidth widget, and settings entry point.
- **TopBar ([TopBar.tsx](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/components/desktop/dashboard/TopBar.tsx))**: Global search bar, view mode toggle (Grid vs List), batch selection actions, sync status indicator, and theme quick switcher.
- **File Explorer ([FileExplorer.tsx](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/components/desktop/dashboard/FileExplorer.tsx))**: Infinite canvas / virtualized list displaying file/folder cards, supporting dnd-kit drag-and-drop, context menus, and inline file renaming.

### 5.2 Mobile Layout Architecture
- **Bottom Navigation Bar ([BottomNavBar.tsx](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/components/mobile/BottomNavBar.tsx))**: Fixed bottom bar with touch-optimized target buttons.
- **Touch File List ([TouchFileList.tsx](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/components/mobile/TouchFileList.tsx))**: Native-feel swipe gestures, pull-to-refresh, long-press action sheets ([ActionPopover.tsx](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/components/mobile/ActionPopover.tsx)).

### 5.3 Special Functional Components
- **Adaptive Media Player ([AdaptiveMediaPlayer.tsx](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/components/desktop/dashboard/AdaptiveMediaPlayer.tsx))**: Supports streaming video/audio directly from Telegram channels, quality selection, HLS streaming fallback, and speed controls.
- **Archive Viewer Modal ([ArchiveViewerModal.tsx](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/components/desktop/dashboard/ArchiveViewerModal.tsx))**: Inspect ZIP/RAR/TAR archives remotely before downloading.
- **Settings Modal ([SettingsModal.tsx](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/components/desktop/dashboard/SettingsModal.tsx))**: Tabbed modal for Account, Appearance & Custom Themes, Downloads & Uploads, Bandwidth, and Storage Management.

---

## 6. Accessibility (a11y) & Localization (i18n)

- **Bi-directional Layout Support**: Full support for LTR (English, Russian, Spanish, etc.) and RTL (Arabic `dir="rtl"`) text rendering.
- **Dynamic Language Selection**: Integrated with `react-i18next` and standard key maps checked via `check-i18n.cjs`.
- **Keyboard Navigation**: Modal focus traps, Esc key close handlers, and keyboard shortcut listeners for file operations.

---

## 7. Strategic Design Changes & Upgrade Recommendations

To elevate Telegram Drive to a world-class tier-1 desktop experience and eliminate existing technical debt in the styling layer, the following targeted upgrades are recommended:

### 7.1 Immediate Design System & CSS Refactoring
1. **Eliminate Hardcoded Hex Values in JSX**:
   - *Current Issue*: Several components feature hardcoded inline Tailwind classes (e.g. `bg-[#17212b]`, `border-[#2481cc]/20`, `text-[#8e9fb3]`).
   - *Upgrade Action*: Replace all static hex strings with variable tokens `bg-[var(--color-telegram-surface)]`, `text-telegram-subtext`, or custom semantic Tailwind utilities. This ensures custom user themes apply consistently across 100% of UI elements.

2. **Deconstruct Large Monolithic Modals**:
   - *Current Issue*: [SettingsModal.tsx](file:///Users/cameronamer/Documents/TelegramicBackUP_01/app/src/components/desktop/dashboard/SettingsModal.tsx) is over 136KB and contains inline styled tab panels, sliders, color pickers, and tables.
   - *Upgrade Action*: Extract primitive reusable UI components into `src/components/ui/`:
     - `<Button variant="primary | secondary | danger | glass" size="sm | md | lg" />`
     - `<Input />` / `<Select />` / `<ToggleSwitch />`
     - `<Card />` / `<ModalHeader />` / `<Tabs />`

3. **Standardize Light Mode Design Tokens**:
   - *Current Issue*: In light mode, some glass borders and low-contrast subtexts rely on ad-hoc CSS overrides (`:root.light .auth-glass ...`).
   - *Upgrade Action*: Expand `--color-telegram-*` tokens to include explicit surface elevation variables (`--color-telegram-surface-elevated`, `--color-telegram-border-subtle`, `--color-telegram-text-muted`) to make light theme contrast crisp and effortless.

### 7.2 UI/UX Polish & Visual Enhancements
4. **Enhanced Micro-Interactions & Hover Feedback**:
   - Standardize spring physics presets in Framer Motion (`type: "spring", stiffness: 400, damping: 25`) for dropdown menus, modal popovers, and file hover cards.
   - Add active tactile state scaling (`active:scale-95`) to all button components.

5. **Refined File Grid & Card Layout**:
   - Implement dynamic skeleton loaders for thumbnail loading states instead of plain spinner icons.
   - Add hover action bar overlays with quick preview, copy link, and download shortcuts.

6. **Mobile Touch & Gesture Refinements**:
   - Ensure all touch targets on mobile view hit the minimum 44x44pt recommendation.
   - Add smooth haptic-style feedback animations on mobile file selections and drag operations.

7. **Design Token Schema Exporting**:
   - Create a JSON schema file (`theme-tokens.json`) as the single source of truth for color tokens, allowing Tauri Rust code and web frontends to share color definitions synchronously.

---
*Document Version: 1.0.0*  
*Author: Antigravity AI Pair Programmer*  
*Target Project: Telegram Drive (TelegramicBackUP_01)*
