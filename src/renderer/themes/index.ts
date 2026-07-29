import type { ITheme } from '@xterm/xterm'

export type ThemeId = 'notion' | 'cyberpunk' | 'matrix'

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
  cyberpunk: {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    hint: 'Neon magenta on deep purple',
    terminal: {
      // Editor sits a shade lighter than the chrome, as in the VS Code theme
      // this is modelled on — it's what makes the panes read as inset panels.
      background: '#241b34',
      foreground: '#f0e6ff',
      cursor: '#ff2fb3',
      cursorAccent: '#241b34',
      selectionBackground: '#46316b',
      selectionForeground: '#ffffff',
      black: '#241b34',
      red: '#fe4450',
      green: '#72f1b8',
      yellow: '#fede5d',
      blue: '#36f9f6',
      magenta: '#ff7edb',
      cyan: '#36f9f6',
      white: '#f0e6ff',
      brightBlack: '#7a6ba3',
      brightRed: '#ff5f6d',
      brightGreen: '#8fffcc',
      brightYellow: '#ff8b39',
      brightBlue: '#5cfbff',
      brightMagenta: '#ff2fb3',
      brightCyan: '#7dfdff',
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

/** Cycle order for ⌥⌘T: light → cyberpunk → matrix. */
export const THEME_IDS = ['notion', 'cyberpunk', 'matrix'] as const

/** Renamed from "synthwave"; keep old persisted values working. */
const RENAMED: Record<string, ThemeId> = { synthwave: 'cyberpunk' }

export function migrateThemeId(value: unknown): ThemeId | undefined {
  if (typeof value !== 'string') return undefined
  if (value in RENAMED) return RENAMED[value]
  return (THEME_IDS as readonly string[]).includes(value) ? (value as ThemeId) : undefined
}
