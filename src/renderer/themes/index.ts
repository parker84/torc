import type { ITheme } from '@xterm/xterm'

export type ThemeId = 'notion' | 'synthwave' | 'matrix'

export interface ThemeDef {
  id: ThemeId
  label: string
  hint: string
  /** Palette handed to xterm; must stay in sync with tokens.css. */
  terminal: ITheme
}

export const THEMES: Record<ThemeId, ThemeDef> = {
  notion: {
    id: 'notion',
    label: 'Notion',
    hint: 'Clean white, for daylight',
    terminal: {
      background: '#ffffff',
      foreground: '#37352f',
      cursor: '#37352f',
      cursorAccent: '#ffffff',
      selectionBackground: '#d3e5f3',
      selectionForeground: '#37352f',
      black: '#37352f',
      red: '#eb5757',
      green: '#0f7b6c',
      yellow: '#d9730d',
      blue: '#2383e2',
      magenta: '#9065b0',
      cyan: '#0b6e99',
      white: '#787774',
      brightBlack: '#9b9a97',
      brightRed: '#e03e3e',
      brightGreen: '#0f7b6c',
      brightYellow: '#dfab01',
      brightBlue: '#337ea9',
      brightMagenta: '#ad1a72',
      brightCyan: '#0b6e99',
      brightWhite: '#37352f',
    },
  },
  synthwave: {
    id: 'synthwave',
    label: 'Synthwave',
    hint: 'Cyberpunk purple and magenta',
    terminal: {
      background: '#221b2e',
      foreground: '#e6dcf5',
      cursor: '#f92aad',
      cursorAccent: '#221b2e',
      selectionBackground: '#3d2a5e',
      selectionForeground: '#ffffff',
      black: '#241b2f',
      red: '#fe4450',
      green: '#72f1b8',
      yellow: '#fede5d',
      blue: '#36f9f6',
      magenta: '#ff7edb',
      cyan: '#36f9f6',
      white: '#e6dcf5',
      brightBlack: '#6c6783',
      brightRed: '#fe4450',
      brightGreen: '#72f1b8',
      brightYellow: '#ff8b39',
      brightBlue: '#36f9f6',
      brightMagenta: '#f92aad',
      brightCyan: '#36f9f6',
      brightWhite: '#ffffff',
    },
  },
  matrix: {
    id: 'matrix',
    label: 'Matrix',
    hint: 'Black and phosphor green',
    terminal: {
      background: '#000000',
      foreground: '#00ff41',
      cursor: '#7dffa0',
      cursorAccent: '#000000',
      selectionBackground: '#0f3b21',
      selectionForeground: '#7dffa0',
      black: '#04120a',
      red: '#ff3333',
      green: '#00ff41',
      yellow: '#ffb000',
      blue: '#00a32b',
      magenta: '#00d47e',
      cyan: '#00e58a',
      white: '#7dffa0',
      brightBlack: '#00752a',
      brightRed: '#ff5555',
      brightGreen: '#7dffa0',
      brightYellow: '#ffd000',
      brightBlue: '#00c94a',
      brightMagenta: '#4dffb8',
      brightCyan: '#88ffcc',
      brightWhite: '#d6ffe4',
    },
  },
}

export const THEME_LIST = Object.values(THEMES)

/** Cycle order for ⌃⌘T: light → cyberpunk → matrix. */
export const THEME_IDS = ['notion', 'synthwave', 'matrix'] as const
