import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { paneLabel } from '../state/label'
import { PaneMenu, type MenuAnchor } from './PaneMenu'
import { StatusDot, statusLabel } from './StatusDot'

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/**
 * The name editor, in place of the title so the row doesn't jump. Enter and blur
 * commit, Escape backs out — a rename you started by accident should cost one
 * key, not an undo.
 */
function NameInput({ paneId, initial }: { paneId: string; initial: string }) {
  const [value, setValue] = useState(initial)
  const renamePane = useStore((s) => s.renamePane)
  const cancelRename = useStore((s) => s.cancelRename)
  const ref = useRef<HTMLInputElement>(null)
  // Selected, not just focused: the common case is replacing the name outright.
  useEffect(() => ref.current?.select(), [])

  return (
    <input
      ref={ref}
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      // The row underneath is a button; a click in the input must not focus the
      // pane and unmount the editor mid-edit.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => renamePane(paneId, value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') renamePane(paneId, value)
        else if (e.key === 'Escape') cancelRename()
      }}
      className="w-full rounded border border-accent bg-bg px-1 py-px text-xs font-medium text-fg outline-none"
    />
  )
}

export function Rail() {
  const panes = useStore((s) => s.panes)
  const activeId = useStore((s) => s.activeId)
  const renamingId = useStore((s) => s.renamingId)
  const setActive = useStore((s) => s.setActive)
  const newSession = useStore((s) => s.newSession)
  const closePane = useStore((s) => s.closePane)
  const [menu, setMenu] = useState<MenuAnchor | null>(null)

  // Opened from the ⋮ button and from a right-click anywhere on the row, because
  // both are things people try first.
  const openMenu = (event: React.MouseEvent, paneId: string) => {
    event.preventDefault()
    event.stopPropagation()
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ paneId, x: event.clientX, y: box.bottom + 4 })
  }

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
          const label = paneLabel(pane)
          const isRenaming = renamingId === pane.id
          const body = (
            <>
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
                    "torc 2", but a name the user typed beats both — see
                    paneLabel. */}
                {isRenaming ? (
                  <NameInput paneId={pane.id} initial={pane.title} />
                ) : (
                  <span className="block truncate text-xs font-medium">{label}</span>
                )}
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
            </>
          )
          const rowClass = 'flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left'
          return (
            <div
              key={pane.id}
              onContextMenu={(e) => openMenu(e, pane.id)}
              className={`group relative mb-0.5 flex items-center rounded-md transition-colors ${
                isActive ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-raised hover:text-fg'
              }`}
            >
              {/* A plain div while renaming: an <input> inside a <button> is
                  invalid, and the button swallows clicks meant for the field. */}
              {isRenaming ? (
                <div className={rowClass}>{body}</div>
              ) : (
                <button
                  onClick={() => setActive(pane.id)}
                  onDoubleClick={() => useStore.getState().startRename(pane.id)}
                  className={rowClass}
                >
                  {body}
                </button>
              )}

              {/*
                Rename, restart and the rest shouldn't mean remembering ⌘K.
                Absolute rather than in flow so titles don't reflow on hover, and
                bg-inherit so the buttons sit on the row's own colour instead of
                punching a hole in it. They stay up while this row's menu is open
                — the thing you just clicked shouldn't vanish under you — and go
                entirely while the name is being edited, since they'd sit on top
                of the field.
              */}
              {!isRenaming && (
                <div
                  className={`absolute right-1 flex items-center bg-inherit ${
                    menu?.paneId === pane.id ? '' : 'opacity-0 group-hover:opacity-100'
                  } focus-within:opacity-100`}
                >
                  <button
                    onClick={(e) => openMenu(e, pane.id)}
                    title={`Options for ${label}`}
                    aria-label={`Options for ${label}`}
                    data-testid="pane-menu-button"
                    className="rounded p-1 font-mono text-[11px] leading-none text-muted hover:bg-line hover:text-fg"
                  >
                    ⋮
                  </button>
                  <button
                    onClick={() => void closePane(pane.id)}
                    title={`Close ${label} (⌘W)`}
                    aria-label={`Close ${label}`}
                    className="rounded p-1 font-mono text-[11px] leading-none text-muted hover:bg-line hover:text-fg"
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
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

      {/* Outside the scrolling list: a menu clipped by its own rail is useless. */}
      {menu && <PaneMenu anchor={menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}
