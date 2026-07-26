import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { clearSearch, findInPane } from '../term/search'

/** ⌘F over the active terminal's scrollback. */
export function FindBar() {
  const open = useStore((s) => s.findOpen)
  const setFind = useStore((s) => s.setFind)
  const activeId = useStore((s) => s.activeId)
  const theme = useStore((s) => s.theme)
  const [query, setQuery] = useState('')
  const [missing, setMissing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else if (activeId) clearSearch(activeId)
  }, [open, activeId])

  if (!open) return null

  const search = (direction: 'next' | 'previous') => {
    if (!activeId) return
    const { found } = findInPane(activeId, query, theme, direction)
    setMissing(query.length > 0 && !found)
  }

  return (
    <div className="absolute top-2 right-3 z-30 flex items-center gap-1 rounded-lg border border-line bg-raised px-2 py-1 shadow-lg">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setMissing(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setFind(false)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            search(event.shiftKey ? 'previous' : 'next')
          }
        }}
        placeholder="Find in terminal"
        spellCheck={false}
        className={`w-48 bg-transparent px-1 py-0.5 text-xs outline-none placeholder:text-muted ${
          missing ? 'text-danger' : 'text-fg'
        }`}
      />
      <button
        onClick={() => search('previous')}
        className="px-1 font-mono text-[11px] text-muted hover:text-fg"
        title="Previous (⇧⏎)"
      >
        ↑
      </button>
      <button
        onClick={() => search('next')}
        className="px-1 font-mono text-[11px] text-muted hover:text-fg"
        title="Next (⏎)"
      >
        ↓
      </button>
      <button
        onClick={() => setFind(false)}
        className="px-1 font-mono text-[11px] text-muted hover:text-fg"
        title="Close (esc)"
      >
        ✕
      </button>
    </div>
  )
}
