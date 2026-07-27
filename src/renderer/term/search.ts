import type { SearchAddon } from '@xterm/addon-search'
import { THEMES, type ThemeId } from '../themes'

/**
 * The find bar lives in React but the search itself belongs to a specific
 * terminal instance, so panes register their addon here and the bar looks up
 * whichever pane is active.
 */
const addons = new Map<string, SearchAddon>()

export function registerSearch(paneId: string, addon: SearchAddon): void {
  addons.set(paneId, addon)
}

export function unregisterSearch(paneId: string): void {
  addons.delete(paneId)
}

function decorations(theme: ThemeId) {
  const palette = THEMES[theme].terminal
  return {
    matchBackground: palette.brightBlack,
    matchOverviewRuler: palette.yellow ?? '#ffb000',
    activeMatchBackground: palette.yellow ?? '#ffb000',
    activeMatchColorOverviewRuler: palette.yellow ?? '#ffb000',
    activeMatchBorder: palette.foreground,
  }
}

export interface SearchResult {
  found: boolean
}

export function findInPane(
  paneId: string,
  query: string,
  theme: ThemeId,
  direction: 'next' | 'previous',
): SearchResult {
  const addon = addons.get(paneId)
  if (!addon || query.length === 0) return { found: false }

  const options = { decorations: decorations(theme), regex: false, caseSensitive: false }
  const found =
    direction === 'next'
      ? addon.findNext(query, options)
      : addon.findPrevious(query, options)
  return { found }
}

export function clearSearch(paneId: string): void {
  addons.get(paneId)?.clearDecorations()
}

/** Exposed for the QA harness, which asserts that find actually matches. */
if (import.meta.env.DEV || window.torc?.qaEnabled) {
  ;(window as unknown as { __torcSearch: unknown }).__torcSearch = { findInPane, clearSearch }
}
