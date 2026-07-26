import { create } from 'zustand'
import type { SessionSnapshot, SessionSpec } from '@shared/types'
import { THEME_IDS, type ThemeId } from '../themes'
import { forgetSession } from '../term/bus'

const THEME_KEY = 'torc:theme'

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

function loadTheme(): ThemeId {
  // TORC_THEME wins in dev so QA can boot straight into a given theme.
  if (isThemeId(window.torc.devTheme)) return window.torc.devTheme
  const stored = localStorage.getItem(THEME_KEY)
  return isThemeId(stored) ? stored : 'notion'
}

export type View = 'workspace' | 'mission'

interface TorcState {
  panes: SessionSnapshot[]
  activeId: string | null
  theme: ThemeId
  view: View
  paletteOpen: boolean
  /** Lives in the store rather than the component so QA can drive it. */
  paletteQuery: string
  /** Last cwd used to open an agent — the sensible default for the next one. */
  lastCwd: string | null

  newSession(spec: Omit<SessionSpec, 'cwd'> & { cwd?: string }): Promise<void>
  closePane(id?: string): Promise<void>
  setActive(id: string): void
  focusIndex(index: number): void
  cyclePane(delta: number): void
  applyUpdate(snapshot: SessionSnapshot): void
  markExited(id: string, exitCode: number): void
  setTheme(theme: ThemeId): void
  cycleTheme(): void
  setView(view: View): void
  setPalette(open: boolean): void
  togglePalette(): void
  setPaletteQuery(query: string): void
}

export const useStore = create<TorcState>((set, get) => ({
  panes: [],
  activeId: null,
  theme: loadTheme(),
  view: 'workspace',
  paletteOpen: false,
  paletteQuery: '',
  lastCwd: null,

  async newSession(spec) {
    // Explicit choice → the folder you last opened an agent in → wherever Torc
    // was launched from. Landing in $HOME is never what you meant.
    const resolved = spec.cwd ?? get().lastCwd ?? (await window.torc.defaultCwd())
    try {
      const snapshot = await window.torc.sessions.create({ ...spec, cwd: resolved })
      set((s) => ({
        panes: [...s.panes, snapshot],
        activeId: snapshot.id,
        lastCwd: resolved,
        view: 'workspace',
      }))
    } catch (error) {
      // A spawn that fails (missing binary, bad cwd) must not fail silently.
      console.error(`torc: could not start ${spec.kind} in ${resolved}:`, error)
    }
  },

  async closePane(id) {
    const target = id ?? get().activeId
    if (!target) return
    await window.torc.sessions.kill(target)
    forgetSession(target)
    set((s) => {
      const index = s.panes.findIndex((p) => p.id === target)
      const panes = s.panes.filter((p) => p.id !== target)
      const nextActive =
        s.activeId === target ? (panes[index]?.id ?? panes[index - 1]?.id ?? null) : s.activeId
      return { panes, activeId: nextActive }
    })
  },

  setActive(id) {
    // Looking at a pane is what "reading" it means.
    window.torc.sessions.markRead(id)
    set({ activeId: id, view: 'workspace' })
  },

  focusIndex(index) {
    const pane = get().panes[index]
    if (pane) set({ activeId: pane.id, view: 'workspace' })
  },

  cyclePane(delta) {
    const { panes, activeId } = get()
    if (panes.length === 0) return
    const current = panes.findIndex((p) => p.id === activeId)
    const next = (current + delta + panes.length) % panes.length
    set({ activeId: panes[next].id, view: 'workspace' })
  },

  applyUpdate(snapshot) {
    set((s) => ({
      panes: s.panes.map((p) => (p.id === snapshot.id ? { ...p, ...snapshot } : p)),
    }))
  },

  markExited(id, exitCode) {
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === id
          ? { ...p, status: exitCode === 0 ? 'exited' : 'error', exitCode, currentTool: undefined }
          : p,
      ),
    }))
  },

  setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme)
    document.documentElement.dataset.theme = theme
    set({ theme })
  },

  cycleTheme() {
    const order = THEME_IDS
    const next = order[(order.indexOf(get().theme) + 1) % order.length]
    get().setTheme(next)
  },

  setView: (view) => set({ view }),
  // Opening always starts from a clean query.
  setPalette: (open) => set({ paletteOpen: open, paletteQuery: '' }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen, paletteQuery: '' })),
  setPaletteQuery: (paletteQuery) => set({ paletteQuery }),
}))

/** Apply the persisted theme before first paint. */
document.documentElement.dataset.theme = useStore.getState().theme

/**
 * Dev-only handle for the QA harness in src/main/qa.ts, which drives the UI
 * through executeJavaScript and screenshots each step.
 */
if (import.meta.env.DEV) {
  ;(window as unknown as { __torc: unknown }).__torc = {
    store: useStore,
    report: () => {
      const s = useStore.getState()
      return {
        theme: s.theme,
        view: s.view,
        paletteOpen: s.paletteOpen,
        activeId: s.activeId,
        paneCount: s.panes.length,
        panes: s.panes.map((p) => ({
          kind: p.kind,
          title: p.title,
          status: p.status,
          needsAttention: p.needsAttention,
          aiTitle: p.aiTitle,
          tool: p.currentTool?.name,
          tokens: p.tokens ? p.tokens.input + p.tokens.output + p.tokens.cacheRead : 0,
          claudeSessionId: p.claudeSessionId,
        })),
      }
    },
  }
}
