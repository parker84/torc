import { useEffect, useRef, useState } from 'react'
import type { SessionSnapshot } from '@shared/types'
import { useStore } from '../state/store'
import { StatusDot, statusLabel } from './StatusDot'

function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Agents blocked on the user come first — that's the whole point of this view. */
function byAttention(a: SessionSnapshot, b: SessionSnapshot): number {
  if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1
  const rank = (s: SessionSnapshot) => (s.status === 'working' ? 0 : s.status === 'idle' ? 1 : 2)
  return rank(a) - rank(b) || a.startedAt - b.startedAt
}

function AgentCard({ pane, now }: { pane: SessionSnapshot; now: number }) {
  const setActive = useStore((s) => s.setActive)
  const totalTokens = pane.tokens
    ? pane.tokens.input + pane.tokens.output + pane.tokens.cacheRead + pane.tokens.cacheWrite
    : 0

  return (
    <button
      onClick={() => setActive(pane.id)}
      className={`flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors ${
        pane.needsAttention
          ? 'border-warn bg-raised neon-warn'
          : 'border-line bg-surface hover:border-accent/40'
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={pane.status} needsAttention={pane.needsAttention} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{pane.title}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted">
          {elapsed(pane.startedAt, now)}
        </span>
      </div>

      {pane.aiTitle && (
        <p className="line-clamp-2 text-[11px] leading-snug text-muted">{pane.aiTitle}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted">
        <span className={pane.needsAttention ? 'text-warn' : ''}>
          {pane.needsAttention ? '⚠ needs you' : statusLabel(pane.status)}
        </span>
        {pane.needsAttention && pane.status === 'working' && <span>still working</span>}
        {pane.branch && <span className="truncate">⑂ {pane.branch}</span>}
        {totalTokens > 0 && <span>{compactTokens(totalTokens)} tok</span>}
        {pane.costUsd !== undefined && pane.costUsd >= 0.01 && (
          <span>${pane.costUsd.toFixed(2)}</span>
        )}
      </div>

      {/* The live tool feed is the thing you actually want to glance at. */}
      {(pane.currentTool || pane.recentTools.length > 0) && (
        <div className="flex flex-col gap-0.5 border-t border-line pt-2 font-mono text-[10px]">
          {pane.currentTool && (
            <div className="truncate text-fg">
              <span className="text-ok">▍</span> {pane.currentTool.name}
              {pane.currentTool.summary ? ` ${pane.currentTool.summary}` : ''}
            </div>
          )}
          {pane.recentTools
            .filter((tool) => tool !== pane.currentTool)
            .slice(0, 3)
            .map((tool, index) => (
              <div key={`${tool.name}-${index}`} className="truncate text-muted opacity-70">
                · {tool.name}
                {tool.summary ? ` ${tool.summary}` : ''}
              </div>
            ))}
        </div>
      )}

      <div className="truncate font-mono text-[10px] text-muted opacity-50">{pane.cwd}</div>
    </button>
  )
}

export function MissionControl() {
  const panes = useStore((s) => s.panes)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  /*
   * Take keyboard focus off the terminal. Without this the hidden xterm textarea
   * keeps it, swallows esc (it means "interrupt" to an agent) and the overview
   * can't be dismissed — while stray keystrokes would also leak into whichever
   * agent happened to be focused.
   */
  useEffect(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    rootRef.current?.focus()
  }, [])

  const sorted = [...panes].sort(byAttention)
  const attention = panes.filter((p) => p.needsAttention).length
  const working = panes.filter((p) => p.status === 'working').length

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="absolute inset-0 z-20 overflow-y-auto bg-bg p-4 outline-none"
    >
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="text-xs font-semibold tracking-[0.14em] text-muted uppercase">
          Mission Control
        </h1>
        <span className="font-mono text-[10px] text-muted">
          {working} working
          {attention > 0 && <span className="text-warn"> · {attention} need you</span>}
        </span>
      </div>

      {sorted.length === 0 ? (
        <p className="text-xs text-muted">
          Nothing running. Press ⌘T for a terminal, or ⌘K for everything else.
        </p>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
          {sorted.map((pane) => (
            <AgentCard key={pane.id} pane={pane} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}
