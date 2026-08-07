import { create } from 'zustand'
import type { SessionSnapshot, SessionSpec } from '@shared/types'
import { migrateThemeId, THEME_IDS, type ThemeId } from '../themes'
import { forgetSession } from '../term/bus'
import { previous, touch } from './recency'

const THEME_KEY = 'torc:theme'

function loadGridSize(): GridSize {
  const stored = Number(localStorage.getItem(GRID_KEY))
  return stored === 2 || stored === 4 ? stored : 1
}

function loadTheme(): ThemeId {
  // TORC_THEME wins in dev so QA can boot straight into a given theme.
  // migrateThemeId also maps the retired "synthwave" id onto "cyberpunk", so a
  // saved preference survives the rename.
  return (
    migrateThemeId(window.torc.devTheme) ??
    migrateThemeId(localStorage.getItem(THEME_KEY)) ??
    'notion'
  )
}

export type View = 'workspace' | 'mission'
export type GridSize = 1 | 2 | 4

const GRID_KEY = 'torc:grid'

/** Module-level so a StrictMode double-mount can't restore twice. */
let restoreStarted = false

interface TorcState {
  panes: SessionSnapshot[]
  activeId: string | null
  theme: ThemeId
  view: View
  paletteOpen: boolean
  /** Lives in the store rather than the component so QA can drive it. */
  paletteQuery: string
  findOpen: boolean
  /** How many panes are visible at once: 1, 2 or 4. */
  gridSize: GridSize
  /** Surfaced in a banner; a failed spawn must not disappear into the console. */
  error: string | null
  /** Last cwd used to open an agent — the sensible default for the next one. */
  lastCwd: string | null
  /** Pane ids, most recently focused first. Drives ⌃Tab. */
  recent: string[]
  /**
   * The pane whose name is being edited in the rail, if any. In the store rather
   * than the rail row so ⌘K and the pane menu can both start the edit.
   */
  renamingId: string | null

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
  /** Rebuilds last session's panes. Safe to call once at startup. */
  restore(): Promise<void>
  /** Focuses the next agent that needs you, wrapping around. */
  focusNextAttention(): void
  /** Back to the pane you were just in — the two-place shuffle you do most. */
  jumpBack(): void
  restartPane(id?: string): Promise<void>
  /** Opens the inline name editor. Defaults to the focused pane. */
  startRename(id?: string): void
  /** Commits a name; an empty one hands the pane back to Torc's own guess. */
  renamePane(id: string, title: string): void
  cancelRename(): void
  setPalette(open: boolean): void
  togglePalette(): void
  setPaletteQuery(query: string): void
  setFind(open: boolean): void
  setError(message: string | null): void
  setGridSize(size: GridSize): void
  /** Types text into a pane and submits it. */
  sendToPane(id: string, text: string): void
  /** Sends the same prompt to every agent (shells are skipped). */
  broadcast(text: string): void
}

export const useStore = create<TorcState>((set, get) => ({
  panes: [],
  activeId: null,
  theme: loadTheme(),
  view: 'workspace',
  paletteOpen: false,
  paletteQuery: '',
  findOpen: false,
  gridSize: loadGridSize(),
  error: null,
  lastCwd: null,
  recent: [],
  renamingId: null,

  async newSession(spec) {
    // Explicit choice → wherever the pane you're looking at has got to → the
    // folder you last opened one in → wherever Torc was launched from. The active
    // pane comes first because the repo you're in is the repo you mean; a shell
    // you cd'd out of trace-backend shouldn't keep handing out trace-backend.
    // Landing in $HOME is never what you meant.
    const { panes, activeId, lastCwd } = get()
    const resolved =
      spec.cwd ??
      panes.find((p) => p.id === activeId)?.cwd ??
      lastCwd ??
      (await window.torc.defaultCwd())
    try {
      const snapshot = await window.torc.sessions.create({ ...spec, cwd: resolved })
      set((s) => ({
        panes: [...s.panes, snapshot],
        activeId: snapshot.id,
        // A new pane is the most recent thing you looked at, so ⌃⇥ from it goes
        // back to whatever you were doing before you opened it.
        recent: touch(s.recent, snapshot.id),
        lastCwd: resolved,
        view: 'workspace',
      }))
    } catch (error) {
      // A spawn that fails (missing binary, bad cwd) must not fail silently.
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`torc: could not start ${spec.kind} in ${resolved}:`, error)
      set({
        error: `Couldn't start ${spec.kind === 'claude' ? 'an agent' : 'a terminal'} in ${resolved}. ${detail}`,
      })
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
    set((s) => ({ activeId: id, view: 'workspace', recent: touch(s.recent, id) }))
  },

  jumpBack() {
    const { recent, panes, activeId } = get()
    const target = previous(
      recent,
      activeId,
      panes.map((p) => p.id),
    )
    if (target) get().setActive(target)
  },

  focusIndex(index) {
    // Through setActive, so ⌘1-9 feeds the recency list that ⌃⇥ walks. Setting
    // activeId directly here meant ⌃⇥ did nothing until you'd used the rail.
    const pane = get().panes[index]
    if (pane) get().setActive(pane.id)
  },

  cyclePane(delta) {
    const { panes, activeId } = get()
    if (panes.length === 0) return
    const current = panes.findIndex((p) => p.id === activeId)
    const next = (current + delta + panes.length) % panes.length
    get().setActive(panes[next].id)
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

  async restore() {
    // Guarding on panes.length is not enough: restore awaits, and React's
    // StrictMode calls the mount effect twice, so both calls would see an empty
    // fleet and every pane would come back doubled.
    if (restoreStarted) return
    restoreStarted = true

    const saved = await window.torc.loadState()
    if (!saved || saved.panes.length === 0) return

    const savedTheme = migrateThemeId(saved.theme)
    if (savedTheme) get().setTheme(savedTheme)

    // Sequential, not parallel: five Claude Code boots at once thrash the CPU
    // and the first pane should be usable immediately.
    for (const pane of saved.panes) {
      await get().newSession({
        kind: pane.kind,
        cwd: pane.cwd,
        title: pane.title,
        renamed: pane.renamed,
        // Resume only when the transcript is still there; otherwise the pane
        // comes back as a fresh agent in the right repo.
        resumeSessionId: pane.resumable ? pane.claudeSessionId : undefined,
      })
    }

    const panes = get().panes
    const target = panes[saved.activeIndex ?? 0] ?? panes[0]
    if (target) set({ activeId: target.id })
  },

  focusNextAttention() {
    const { panes, activeId } = get()
    const waiting = panes.filter((p) => p.needsAttention)
    if (waiting.length === 0) return
    // Start after the current pane so repeated presses walk the queue.
    const currentIndex = panes.findIndex((p) => p.id === activeId)
    const next =
      waiting.find((p) => panes.indexOf(p) > currentIndex) ?? waiting[0]
    get().setActive(next.id)
  },

  async restartPane(id) {
    const target = id ?? get().activeId
    if (!target) return
    const pane = get().panes.find((p) => p.id === target)
    if (!pane) return
    await get().closePane(target)
    await get().newSession({
      kind: pane.kind,
      cwd: pane.cwd,
      title: pane.title,
      renamed: pane.renamed,
      resumeSessionId: pane.kind === 'claude' ? pane.claudeSessionId : undefined,
    })
  },
  startRename(id) {
    const target = id ?? get().activeId
    if (!target) return
    // Renaming a pane you can't see is disorienting; the editor is in the rail.
    set({ renamingId: target, view: 'workspace' })
  },

  renamePane(id, title) {
    // Main owns the title, as it owns every other field on a snapshot; it
    // normalises the string and pushes the result back through onUpdate.
    window.torc.sessions.rename(id, title)
    set((s) => ({ renamingId: s.renamingId === id ? null : s.renamingId }))
  },

  cancelRename: () => set({ renamingId: null }),

  // Opening always starts from a clean query.
  setPalette: (open) => set({ paletteOpen: open, paletteQuery: '' }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen, paletteQuery: '' })),
  setPaletteQuery: (paletteQuery) => set({ paletteQuery }),
  setFind: (findOpen) => set({ findOpen }),
  setError: (error) => set({ error }),

  setGridSize(size) {
    localStorage.setItem(GRID_KEY, String(size))
    set({ gridSize: size, view: 'workspace' })
  },

  sendToPane(id, text) {
    if (text.length === 0) return
    // Text and Enter separately: a single bulk write can be read as a paste,
    // which types the prompt without submitting it.
    window.torc.sessions.write(id, text)
    setTimeout(() => window.torc.sessions.write(id, '\r'), 120)
  },

  broadcast(text) {
    const agents = get().panes.filter((p) => p.kind === 'claude')
    // Stagger: several agents starting a turn in the same tick is a thundering
    // herd on both the CPU and the API.
    agents.forEach((pane, index) => {
      setTimeout(() => get().sendToPane(pane.id, text), index * 400)
    })
  },
}))

/** Apply the persisted theme before first paint. */
document.documentElement.dataset.theme = useStore.getState().theme

/**
 * Mirror the layout to disk whenever it changes. Debounced because a busy fleet
 * updates snapshots several times a second and none of that churn affects what
 * we'd restore.
 */
let saveTimer: ReturnType<typeof setTimeout> | undefined
useStore.subscribe((state, previous) => {
  // Titles are in the key because a rename is a change worth persisting on its
  // own; without it the new name only reaches disk if a pane later opens, closes
  // or moves.
  const relevant = (s: typeof state) =>
    `${s.theme}|${s.activeId}|${s.panes.map((p) => `${p.kind}:${p.cwd}:${p.title}:${p.claudeSessionId ?? ''}`).join(',')}`
  if (relevant(state) === relevant(previous)) return

  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const s = useStore.getState()
    window.torc.saveState({
      theme: s.theme,
      activeIndex: Math.max(
        0,
        s.panes.findIndex((p) => p.id === s.activeId),
      ),
      panes: s.panes.map((p) => ({
        kind: p.kind,
        cwd: p.cwd,
        title: p.title,
        renamed: p.renamed,
        claudeSessionId: p.claudeSessionId,
      })),
    })
  }, 600)
})

/**
 * Dev-only handle for the QA harness in src/main/qa.ts, which drives the UI
 * through executeJavaScript and screenshots each step.
 */
if (import.meta.env.DEV || window.torc.qaEnabled) {
  ;(window as unknown as { __torc: unknown }).__torc = {
    store: useStore,
    report: () => {
      const s = useStore.getState()
      return {
        theme: s.theme,
        view: s.view,
        paletteOpen: s.paletteOpen,
        renamingId: s.renamingId,
        activeId: s.activeId,
        paneCount: s.panes.length,
        panes: s.panes.map((p) => ({
          kind: p.kind,
          title: p.title,
          renamed: p.renamed,
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
