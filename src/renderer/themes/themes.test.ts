import { describe, expect, it } from 'vitest'
import { migrateThemeId, THEME_IDS, THEMES } from './index'

describe('migrateThemeId', () => {
  it('accepts the current ids', () => {
    for (const id of THEME_IDS) expect(migrateThemeId(id)).toBe(id)
  })

  it('maps the retired synthwave id onto cyberpunk', () => {
    // Anyone who picked the theme before the rename has "synthwave" persisted in
    // localStorage and in ~/.torc/state.json; silently dropping it would reset
    // them to the light theme.
    expect(migrateThemeId('synthwave')).toBe('cyberpunk')
  })

  it('rejects anything else', () => {
    expect(migrateThemeId('dracula')).toBeUndefined()
    expect(migrateThemeId('')).toBeUndefined()
    expect(migrateThemeId(undefined)).toBeUndefined()
    expect(migrateThemeId(42)).toBeUndefined()
  })
})

describe('THEMES', () => {
  it('covers every id in the cycle order', () => {
    expect(Object.keys(THEMES).sort()).toEqual([...THEME_IDS].sort())
  })

  it('gives every theme a full terminal palette', () => {
    // A missing colour makes xterm fall back to its own default, which reads as
    // a stray wrong-coloured word rather than an obvious failure.
    const required = [
      'background',
      'foreground',
      'cursor',
      'selectionBackground',
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'brightBlack',
      'brightWhite',
    ] as const

    for (const theme of Object.values(THEMES)) {
      for (const key of required) {
        expect(theme.terminal[key], `${theme.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  it('keeps foreground and background distinct in every theme', () => {
    for (const theme of Object.values(THEMES)) {
      expect(theme.terminal.foreground, theme.id).not.toBe(theme.terminal.background)
    }
  })
})
