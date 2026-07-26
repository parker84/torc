import { useStore } from '../state/store'
import { THEMES } from '../themes'

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function StatusBar() {
  const panes = useStore((s) => s.panes)
  const theme = useStore((s) => s.theme)
  const activeId = useStore((s) => s.activeId)
  const active = panes.find((p) => p.id === activeId)

  // Panes and agents are different counts now that ⌘T opens a plain shell.
  const agents = panes.filter((p) => p.kind === 'claude').length
  const attention = panes.filter((p) => p.needsAttention).length

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 font-mono text-[10px] text-muted">
      <span>{plural(panes.length, 'session')}</span>
      {agents > 0 && <span>{plural(agents, 'agent')}</span>}
      {attention > 0 && (
        <span className="text-warn">
          ⚠ {attention} need{attention === 1 ? 's' : ''} you
        </span>
      )}
      {active && <span className="truncate">{active.cwd}</span>}
      <span className="ml-auto">{THEMES[theme].label}</span>
      <span className="opacity-60">⌘K</span>
    </footer>
  )
}
