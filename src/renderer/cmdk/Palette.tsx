import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { fuzzy } from './fuzzy'
import { buildCommands, GROUP_ORDER, type Command } from './registry'
import { statusLabel } from '../components/StatusDot'

interface Row {
  key: string
  title: string
  subtitle?: string
  group: string
  hint?: string
  score: number
  run(): void | Promise<void>
}

/**
 * Prefix modes turn the palette into a control surface rather than a launcher:
 *   (none) commands   @ jump to an agent   > commands only
 * `/` and `!` (send-to-agent and broadcast) arrive with M2.
 */
function parse(input: string): { mode: 'all' | 'panes'; query: string } {
  if (input.startsWith('@')) return { mode: 'panes', query: input.slice(1).trim() }
  if (input.startsWith('>')) return { mode: 'all', query: input.slice(1).trim() }
  return { mode: 'all', query: input.trim() }
}

export function Palette() {
  const open = useStore((s) => s.paletteOpen)
  const setPalette = useStore((s) => s.setPalette)
  const panes = useStore((s) => s.panes)
  const setActive = useStore((s) => s.setActive)

  const input = useStore((s) => s.paletteQuery)
  const setInput = useStore((s) => s.setPaletteQuery)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Rebuilt per open so commands see current state.
  const commands = useMemo<Command[]>(() => (open ? buildCommands() : []), [open])

  useEffect(() => {
    if (open) {
      setCursor(0)
      inputRef.current?.focus()
    }
  }, [open])

  const rows = useMemo<Row[]>(() => {
    const { mode, query } = parse(input)

    const paneRows: Row[] = panes.map((pane, index) => ({
      key: `pane:${pane.id}`,
      title: pane.aiTitle || pane.title,
      subtitle: `${statusLabel(pane.status)} · ${pane.cwd}`,
      group: 'Agents',
      hint: index < 9 ? `⌘${index + 1}` : undefined,
      score: 0,
      run: () => setActive(pane.id),
    }))

    const candidates: Row[] =
      mode === 'panes'
        ? paneRows
        : [
            ...paneRows,
            ...commands.map((c) => ({
              key: c.id,
              title: c.title,
              subtitle: c.subtitle,
              group: c.group,
              hint: c.hint,
              score: 0,
              run: c.run,
            })),
          ]

    // With no query, present groups in a deliberate order rather than however
    // the registry happens to be written.
    if (!query) {
      const rank = (group: string) => {
        const index = (GROUP_ORDER as readonly string[]).indexOf(group)
        return index === -1 ? GROUP_ORDER.length : index
      }
      return candidates
        .map((row, index) => ({ row, index }))
        .sort((a, b) => rank(a.row.group) - rank(b.row.group) || a.index - b.index)
        .map(({ row }) => row)
    }

    return candidates
      .map((row) => {
        const haystack = `${row.title} ${row.group} ${row.subtitle ?? ''}`
        const match = fuzzy(query, haystack)
        return match ? { ...row, score: match.score } : null
      })
      .filter((row): row is Row => row !== null)
      .sort((a, b) => b.score - a.score)
  }, [input, commands, panes, setActive])

  useEffect(() => {
    if (cursor >= rows.length) setCursor(Math.max(0, rows.length - 1))
  }, [rows.length, cursor])

  // Keep the highlighted row in view when navigating with the keyboard.
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null

  const runRow = (row: Row | undefined) => {
    if (!row) return
    setPalette(false)
    void row.run()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setPalette(false)
    } else if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault()
      setCursor((c) => Math.min(c + 1, rows.length - 1))
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      runRow(rows[cursor])
    }
  }

  let lastGroup = ''

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-[12vh]"
      onMouseDown={() => setPalette(false)}
    >
      <div
        className="w-[min(640px,92vw)] overflow-hidden rounded-xl border border-line bg-raised shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setCursor(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Run a command, or @ to jump to an agent…"
          spellCheck={false}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-fg outline-none placeholder:text-muted"
        />

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1">
          {rows.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-muted">No matches</p>
          )}

          {rows.map((row, index) => {
            const showGroup = row.group !== lastGroup
            lastGroup = row.group
            const selected = index === cursor
            return (
              <div key={row.key}>
                {showGroup && (
                  <div className="px-4 pt-2 pb-1 text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
                    {row.group}
                  </div>
                )}
                <button
                  data-selected={selected}
                  onMouseMove={() => setCursor(index)}
                  onClick={() => runRow(row)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                    selected ? 'bg-accent-soft' : ''
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{row.title}</span>
                    {row.subtitle && (
                      <span className="block truncate text-[11px] text-muted">{row.subtitle}</span>
                    )}
                  </span>
                  {row.hint && <kbd className="font-mono text-[10px] text-muted">{row.hint}</kbd>}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
