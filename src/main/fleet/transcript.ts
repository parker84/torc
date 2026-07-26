import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ToolCall, TokenUsage } from '@shared/types'

/**
 * Claude Code writes every session to ~/.claude/projects/<cwd-slug>/<id>.jsonl.
 * Because Torc assigns the session id at spawn (--session-id), we know that
 * path before the agent produces a single byte, and tailing it gives the rich
 * detail — title, tool calls, tokens, model, branch — with no TUI scraping.
 *
 * Polling on a timer rather than fs.watch: we track ≤ a few dozen files, macOS
 * fs events on files that don't exist yet are awkward, and a byte offset makes
 * incremental reads trivial.
 */
export interface TranscriptState {
  aiTitle?: string
  model?: string
  branch?: string
  permissionMode?: string
  currentTool?: ToolCall
  recentTools: ToolCall[]
  tokens: TokenUsage
  /** Number of assistant turns seen — cheap "is it doing anything" signal. */
  turns: number
}

const POLL_MS = 400
const MAX_RECENT_TOOLS = 12

/** Mirrors Claude Code's directory naming: every "/" in the cwd becomes "-". */
export function projectSlug(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

export function transcriptPath(cwd: string, sessionId: string): string | undefined {
  const root = join(homedir(), '.claude', 'projects')
  const direct = join(root, projectSlug(cwd), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct

  // A worktree or a resumed session can live under a different slug than the
  // cwd we spawned with, so fall back to scanning for the id.
  try {
    for (const dir of readdirSync(root)) {
      const candidate = join(root, dir, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // No projects directory yet.
  }
  return undefined
}

function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** A one-line human summary of a tool call, e.g. `Bash pytest -q`. */
export function summarizeTool(name: string, input: Record<string, unknown>): string | undefined {
  const str = (value: unknown) => (typeof value === 'string' ? value : undefined)
  const raw =
    str(input.command) ??
    str(input.file_path) ??
    str(input.pattern) ??
    str(input.description) ??
    str(input.path) ??
    str(input.url) ??
    str(input.prompt)
  if (!raw) return undefined
  const compact = (
    name === 'Read' || name === 'Edit' || name === 'Write' ? basename(raw) : raw
  ).replace(/\s+/g, ' ')
  return compact.length > 64 ? `${compact.slice(0, 63)}…` : compact
}

interface Watch {
  path?: string
  cwd: string
  sessionId: string
  offset: number
  partial: string
  state: TranscriptState
}

export class TranscriptTailer {
  private watches = new Map<string, Watch>()
  private timer?: NodeJS.Timeout

  /** paneId → state, so callers don't need to know about claude session ids. */
  constructor(private onUpdate: (paneId: string, state: TranscriptState) => void) {}

  watch(paneId: string, cwd: string, sessionId: string): void {
    this.watches.set(paneId, {
      cwd,
      sessionId,
      offset: 0,
      partial: '',
      state: { recentTools: [], tokens: emptyTokens(), turns: 0 },
    })
    this.ensureTimer()
  }

  unwatch(paneId: string): void {
    this.watches.delete(paneId)
    if (this.watches.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  dispose(): void {
    this.watches.clear()
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), POLL_MS)
    this.timer.unref?.()
  }

  private tick(): void {
    for (const [paneId, watch] of this.watches) {
      try {
        this.pump(paneId, watch)
      } catch {
        // A transcript that vanishes or is mid-write is not worth surfacing.
      }
    }
  }

  private pump(paneId: string, watch: Watch): void {
    if (!watch.path) {
      watch.path = transcriptPath(watch.cwd, watch.sessionId)
      if (!watch.path) return
    }

    const { size } = statSync(watch.path)
    if (size <= watch.offset) {
      // Truncated or replaced (e.g. /clear) — start over.
      if (size < watch.offset) {
        watch.offset = 0
        watch.partial = ''
      }
      return
    }

    // Read only the new bytes; transcripts reach tens of megabytes.
    const fd = readFileSync(watch.path)
    const chunk = fd.subarray(watch.offset, size).toString('utf8')
    watch.offset = size

    const lines = (watch.partial + chunk).split('\n')
    watch.partial = lines.pop() ?? ''

    let changed = false
    for (const line of lines) {
      if (line.trim().length === 0) continue
      try {
        if (this.apply(watch.state, JSON.parse(line))) changed = true
      } catch {
        // Partial or malformed line — skip it.
      }
    }

    if (changed) this.onUpdate(paneId, { ...watch.state })
  }

  /** Returns true when the record moved the needle. */
  private apply(state: TranscriptState, record: Record<string, unknown>): boolean {
    let changed = false

    if (typeof record.gitBranch === 'string' && record.gitBranch !== state.branch) {
      state.branch = record.gitBranch
      changed = true
    }

    switch (record.type) {
      case 'ai-title': {
        if (typeof record.aiTitle === 'string') {
          state.aiTitle = record.aiTitle
          changed = true
        }
        break
      }
      case 'permission-mode': {
        if (typeof record.permissionMode === 'string') {
          state.permissionMode = record.permissionMode
          changed = true
        }
        break
      }
      case 'assistant': {
        const message = record.message as
          | { model?: string; usage?: Record<string, number>; content?: unknown[] }
          | undefined
        if (!message) break

        if (message.model && message.model !== state.model) {
          state.model = message.model
          changed = true
        }

        const usage = message.usage
        if (usage) {
          state.tokens.input += usage.input_tokens ?? 0
          state.tokens.output += usage.output_tokens ?? 0
          state.tokens.cacheRead += usage.cache_read_input_tokens ?? 0
          state.tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0
          state.turns += 1
          changed = true
        }

        for (const block of message.content ?? []) {
          const b = block as { type?: string; name?: string; input?: Record<string, unknown> }
          if (b.type !== 'tool_use' || !b.name) continue
          const call: ToolCall = {
            name: b.name,
            summary: summarizeTool(b.name, b.input ?? {}),
            startedAt: Date.now(),
          }
          state.currentTool = call
          state.recentTools = [call, ...state.recentTools].slice(0, MAX_RECENT_TOOLS)
          changed = true
        }
        break
      }
      case 'user': {
        // A tool_result coming back means the current call finished.
        const message = record.message as { content?: unknown[] } | undefined
        const hasResult = (message?.content ?? []).some(
          (block) => (block as { type?: string }).type === 'tool_result',
        )
        if (hasResult && state.currentTool) {
          state.currentTool.endedAt = Date.now()
          state.currentTool = undefined
          changed = true
        }
        break
      }
      default:
        break
    }

    return changed
  }
}
