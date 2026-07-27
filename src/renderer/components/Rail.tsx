import { useStore } from '../state/store'
import { StatusDot, statusLabel } from './StatusDot'

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function Rail() {
  const panes = useStore((s) => s.panes)
  const activeId = useStore((s) => s.activeId)
  const setActive = useStore((s) => s.setActive)
  const newSession = useStore((s) => s.newSession)

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface">
      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
        Fleet
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {panes.length === 0 && (
          <p className="px-2 py-3 text-xs leading-relaxed text-muted">
            Nothing running. Press{' '}
            <kbd className="rounded border border-line bg-raised px-1 font-mono">⌘T</kbd> for a
            terminal.
          </p>
        )}

        {panes.map((pane, index) => {
          const isActive = pane.id === activeId
          return (
            <button
              key={pane.id}
              onClick={() => setActive(pane.id)}
              className={`group mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                isActive ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-raised hover:text-fg'
              }`}
            >
              {/* Always visible, not on hover: the number is how you jump. */}
              <kbd
                className={`w-3.5 shrink-0 text-center font-mono text-[10px] ${
                  isActive ? 'text-fg' : 'text-muted'
                }`}
              >
                {index < 9 ? index + 1 : ''}
              </kbd>
              <StatusDot status={pane.status} needsAttention={pane.needsAttention} />
              <span className="min-w-0 flex-1">
                {/* Claude's own title for the conversation says far more than
                    "torc 2" — fall back to the pane name until it exists. */}
                <span className="block truncate text-xs font-medium">
                  {pane.aiTitle || pane.title}
                </span>
                <span
                  className={`block truncate text-[10px] ${
                    pane.needsAttention ? 'text-warn' : 'text-muted'
                  }`}
                >
                  {pane.kind === 'shell' && !pane.claudeSessionId
                    ? 'shell'
                    : statusLabel(pane.status, pane.needsAttention)}{' '}
                  · {basename(pane.cwd)}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {/*
        One way in. Run `claude` in a terminal and Torc picks it up with full
        monitoring — the agent presets (worktree, plan mode) live in ⌘K, where
        they belong, rather than presenting two kinds of pane up front.
      */}
      <div className="flex flex-col border-t border-line p-1.5">
        <button
          onClick={() => void newSession({ kind: 'shell' })}
          className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-muted transition-colors hover:bg-raised hover:text-fg"
        >
          + New terminal
          <kbd className="ml-auto font-mono text-[10px] opacity-60">⌘T</kbd>
        </button>
      </div>
    </aside>
  )
}
