import type { AgentStatus } from '@shared/types'

// A live agent glows; a dormant one doesn't. In the light theme every glow
// resolves to none, so the classes are safe to apply unconditionally.
const STYLES: Record<AgentStatus, { className: string; label: string }> = {
  launching: { className: 'bg-muted animate-pulse', label: 'starting' },
  idle: { className: 'bg-muted/60', label: 'idle' },
  working: { className: 'bg-ok neon-ok animate-pulse', label: 'working' },
  'needs-input': { className: 'bg-warn neon-warn', label: 'needs you' },
  exited: { className: 'bg-muted/40', label: 'exited' },
  error: { className: 'bg-danger neon-warn', label: 'error' },
}

/**
 * Attention outranks the raw status everywhere it's shown: an agent that
 * finished and hasn't been read is still something you need to look at, and a
 * green dot next to "needs you" reads as a contradiction.
 */
export function StatusDot({
  status,
  needsAttention = false,
}: {
  status: AgentStatus
  needsAttention?: boolean
}) {
  const style = needsAttention ? STYLES['needs-input'] : STYLES[status]
  return (
    <span
      aria-label={style.label}
      title={style.label}
      className={`inline-block size-2 shrink-0 rounded-full ${style.className}`}
    />
  )
}

export function statusLabel(status: AgentStatus, needsAttention = false): string {
  return needsAttention ? STYLES['needs-input'].label : STYLES[status].label
}
