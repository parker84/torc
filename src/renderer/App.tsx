import { useEffect } from 'react'
import { useStore } from './state/store'
import { Rail } from './components/Rail'
import { StatusBar } from './components/StatusBar'
import { PaneGrid } from './components/PaneGrid'
import { MissionControl } from './components/MissionControl'
import { FindBar } from './components/FindBar'
import { Palette } from './cmdk/Palette'

function ErrorBanner() {
  const error = useStore((s) => s.error)
  const setError = useStore((s) => s.setError)
  if (!error) return null
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-danger bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
      <span className="flex-1">{error}</span>
      <button onClick={() => setError(null)} className="font-mono opacity-70 hover:opacity-100">
        ✕
      </button>
    </div>
  )
}

export function App() {
  const panes = useStore((s) => s.panes)
  const activeId = useStore((s) => s.activeId)
  const view = useStore((s) => s.view)

  // Menu accelerators are owned by the main process so they fire even while
  // xterm has keyboard focus. The renderer only reacts.
  useEffect(() => {
    const {
      newSession,
      closePane,
      togglePalette,
      setView,
      cyclePane,
      cycleTheme,
      focusNextAttention,
      restartPane,
      setFind,
    } = useStore.getState()
    const offs = [
      window.torcMenu.on('new-terminal', () => void newSession({ kind: 'shell' })),
      window.torcMenu.on('new-agent', () => void newSession({ kind: 'claude' })),
      window.torcMenu.on('close-pane', () => void closePane()),
      window.torcMenu.on('restart-pane', () => void restartPane()),
      window.torcMenu.on('palette', () => togglePalette()),
      window.torcMenu.on('next-agent', () => cyclePane(1)),
      window.torcMenu.on('prev-agent', () => cyclePane(-1)),
      window.torcMenu.on('next-attention', () => focusNextAttention()),
      window.torcMenu.on('find', () => setFind(true)),
      window.torcMenu.on('grid-1', () => useStore.getState().setGridSize(1)),
      window.torcMenu.on('grid-2', () => useStore.getState().setGridSize(2)),
      window.torcMenu.on('grid-4', () => useStore.getState().setGridSize(4)),
      window.torcMenu.on('cycle-theme', () => cycleTheme()),
      window.torcMenu.on('mission-control', () =>
        setView(useStore.getState().view === 'mission' ? 'workspace' : 'mission'),
      ),
      // Clicking a notification jumps straight to the agent that sent it.
      window.torc.onFocusPane((paneId) => useStore.getState().setActive(paneId)),
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // Bring back last session's panes.
  useEffect(() => {
    void useStore.getState().restore()
  }, [])

  // ⌘1-9 to jump between agents, ⌥⌘←/→ to cycle. Kept out of the menu so they
  // don't show up as menu items.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return
      const { focusIndex, cyclePane } = useStore.getState()

      if (/^[1-9]$/.test(event.key) && !event.altKey) {
        event.preventDefault()
        focusIndex(Number(event.key) - 1)
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault()
        cyclePane(1)
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        cyclePane(-1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const { applyUpdate, markExited } = useStore.getState()
    const offUpdate = window.torc.onUpdate(applyUpdate)
    const offExit = window.torc.onExit(markExited)
    return () => {
      offUpdate()
      offExit()
    }
  }, [])

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {/* Draggable title strip; leaves room for the traffic lights. */}
      <header className="drag-region flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface pr-3 pl-20">
        <span className="glow text-xs font-semibold tracking-wide text-accent">torc</span>
        <span className="truncate text-[11px] text-muted">
          {panes.find((p) => p.id === activeId)?.cwd ?? 'nothing running'}
        </span>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => useStore.getState().togglePalette()}
          className="no-drag ml-auto rounded-md border border-line px-2 py-0.5 font-mono text-[10px] text-muted hover:text-fg"
        >
          ⌘K
        </button>
      </header>

      <ErrorBanner />

      <div className="flex min-h-0 flex-1">
        <Rail />
        <main className="relative min-w-0 flex-1">
          {panes.length === 0 && view === 'workspace' && (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm text-muted">Nothing running</p>
              <p className="font-mono text-[11px] text-muted opacity-70">
                ⌘T terminal · ⇧⌘T agent · ⌘K commands · ⌘0 mission control
              </p>
            </div>
          )}

          <PaneGrid panes={panes} />

          {view === 'mission' && <MissionControl />}
          <FindBar />
        </main>
      </div>

      <StatusBar />
      <Palette />
    </div>
  )
}
