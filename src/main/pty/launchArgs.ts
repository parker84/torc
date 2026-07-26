import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { SessionSpec } from '@shared/types'

export interface LaunchPlan {
  file: string
  args: string[]
  title: string
  /**
   * Set for claude panes. We assign the UUID ourselves rather than discovering
   * it later, which is what lets M1 tail
   * ~/.claude/projects/<cwd-slug>/<uuid>.jsonl from the moment the pane opens.
   */
  claudeSessionId?: string
}

/**
 * Turns a SessionSpec into an argv. Kept pure and separate from SessionManager
 * so it can be unit-tested without spawning anything.
 */
export function planLaunch(spec: SessionSpec, shell: string): LaunchPlan {
  const title = spec.title?.trim() || basename(spec.cwd) || 'session'

  if (spec.kind === 'shell') {
    return { file: shell, args: ['-l'], title }
  }

  const args: string[] = []
  let claudeSessionId: string | undefined

  if (spec.resumeSessionId) {
    // --resume reuses the original id, so we already know the transcript path.
    args.push('--resume', spec.resumeSessionId)
    claudeSessionId = spec.resumeSessionId
  } else {
    claudeSessionId = randomUUID()
    args.push('--session-id', claudeSessionId)
  }

  // Shows up in claude's own prompt box, the /resume picker and the terminal
  // title — worth setting so external tooling agrees with Torc's labels.
  args.push('--name', title)

  if (spec.model) args.push('--model', spec.model)
  if (spec.permissionMode) args.push('--permission-mode', spec.permissionMode)
  if (spec.worktree === true) args.push('--worktree')
  else if (typeof spec.worktree === 'string') args.push('--worktree', spec.worktree)

  return { file: 'claude', args, title, claudeSessionId }
}
