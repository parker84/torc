import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'

/**
 * The per-pane menu behind the rail's ⋮ button and its right-click. Rendered in
 * the renderer rather than popped as a native Electron menu — unlike the pane
 * body's Copy/Paste menu, which has to be native because the clipboard lives in
 * main. Here everything is a store action, and a React menu is themed, scriptable
 * from the QA harnesses, and can hand off to the inline name editor without a
 * round trip.
 *
 * Nothing lives here that isn't also in ⌘K; this is the pointer-shaped route to
 * the same actions.
 */
export interface MenuAnchor {
  paneId: string
  x: number
  y: number
}

interface Item {
  label: string
  hint?: string
  run(): void
  /** Sets it apart at the bottom, the way Close usually is. */
  danger?: boolean
  /** Draws a rule above it. */
  separated?: boolean
}

const WIDTH = 190
/** Enough for the tallest menu below; only used to keep it on screen. */
const MAX_HEIGHT = 260

export function PaneMenu({ anchor, onClose }: { anchor: MenuAnchor; onClose(): void }) {
  const pane = useStore((s) => s.panes.find((p) => p.id === anchor.paneId))
  const ref = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState(0)

  // Any click that isn't on the menu dismisses it, including one in a terminal.
  useEffect(() => {
    const dismiss = () => onClose()
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [onClose])

  // Focused on open so Escape and the arrows work without a click first.
  useLayoutEffect(() => {
    ref.current?.focus()
  }, [])

  if (!pane) return null

  const items: Item[] = [
    {
      label: 'Rename…',
      hint: '⏎',
      run: () => useStore.getState().startRename(pane.id),
    },
    {
      label: 'Copy path',
      run: () => void navigator.clipboard.writeText(pane.cwd),
    },
    {
      label: 'Open in VS Code',
      run: () => window.torc.openIn(pane.cwd, 'editor'),
      separated: true,
    },
    {
      label: 'Reveal in Finder',
      run: () => window.torc.openIn(pane.cwd, 'finder'),
    },
    {
      label: 'Restart',
      hint: '⇧⌘R',
      run: () => void useStore.getState().restartPane(pane.id),
      separated: true,
    },
    {
      label: 'Close',
      hint: '⌘W',
      run: () => void useStore.getState().closePane(pane.id),
      danger: true,
    },
  ]

  const choose = (item: Item) => {
    onClose()
    item.run()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((c) => (c + 1) % items.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((c) => (c - 1 + items.length) % items.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(items[cursor])
    }
  }

  // Clamped so a right-click near the bottom of the window doesn't open a menu
  // half of which is off screen.
  const left = Math.min(anchor.x, window.innerWidth - WIDTH - 8)
  const top = Math.min(anchor.y, Math.max(8, window.innerHeight - MAX_HEIGHT))

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="menu"
      data-testid="pane-menu"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ left, top, width: WIDTH }}
      className="fixed z-50 overflow-hidden rounded-lg border border-line bg-raised py-1 shadow-2xl outline-none"
    >
      <div className="truncate px-3 pt-1 pb-2 text-[10px] tracking-wide text-muted uppercase">
        {pane.title}
      </div>
      {items.map((item, index) => (
        <button
          key={item.label}
          role="menuitem"
          onMouseEnter={() => setCursor(index)}
          onClick={() => choose(item)}
          className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs ${
            item.separated ? 'mt-1 border-t border-line pt-2' : ''
          } ${item.danger ? 'text-danger' : 'text-fg'} ${cursor === index ? 'bg-accent-soft' : ''}`}
        >
          <span className="flex-1 truncate">{item.label}</span>
          {item.hint && <kbd className="font-mono text-[10px] text-muted">{item.hint}</kbd>}
        </button>
      ))}
    </div>
  )
}
