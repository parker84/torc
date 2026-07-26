/** Shared vocabulary between main, preload and renderer. No node imports here. */

export type AgentKind = 'claude' | 'shell'

/**
 * Lifecycle of an agent pane. M0 only produces launching → idle → exited/error;
 * the full reducer that drives `working`/`needs-input` from hooks lands in M1.
 */
export type AgentStatus =
  | 'launching'
  | 'idle'
  | 'working'
  | 'needs-input'
  | 'exited'
  | 'error'

export type PermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'dontAsk'
  | 'plan'

/** What the renderer asks for when opening a new pane. */
export interface SessionSpec {
  kind: AgentKind
  cwd: string
  /** Human label; defaults to the basename of cwd. */
  title?: string
  /** claude only */
  model?: string
  permissionMode?: PermissionMode
  /** claude only: create/attach a git worktree (`-w`). */
  worktree?: string | true
  /** claude only: resume an existing session id instead of starting fresh. */
  resumeSessionId?: string
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ToolCall {
  name: string
  summary?: string
  startedAt: number
  endedAt?: number
}

/** The single source of truth per pane, owned by main and mirrored to the renderer. */
export interface SessionSnapshot {
  /** Torc's pane id. Stable for the life of the pane. */
  id: string
  /** Claude's session id — we assign it at spawn so we can find the transcript. */
  claudeSessionId?: string
  kind: AgentKind
  cwd: string
  title: string
  /** Claude's own `ai-title` for the conversation, once it exists (M1). */
  aiTitle?: string
  status: AgentStatus
  startedAt: number
  exitCode?: number
  /** True while the agent is blocked on the user (permission prompt, question). */
  needsAttention: boolean
  currentTool?: ToolCall
  recentTools: ToolCall[]
  branch?: string
  model?: string
  tokens?: TokenUsage
  /** Rough running spend, for a sense of scale rather than billing. */
  costUsd?: number
}

export const IPC = {
  sessionCreate: 'session:create',
  sessionWrite: 'session:write',
  sessionResize: 'session:resize',
  sessionKill: 'session:kill',
  sessionList: 'session:list',
  sessionMarkRead: 'session:mark-read',
  /** main → renderer */
  sessionData: 'session:data',
  sessionExit: 'session:exit',
  sessionUpdate: 'session:update',
  appHome: 'app:home',
  appDefaultCwd: 'app:default-cwd',
  appPickDir: 'app:pick-dir',
  appLoadState: 'app:load-state',
  appSaveState: 'app:save-state',
  appOpenIn: 'app:open-in',
  /** main → renderer: the user clicked a notification. */
  focusPane: 'app:focus-pane',
} as const

/** Layout restored on the next launch. */
export interface SavedPane {
  kind: AgentKind
  cwd: string
  title: string
  claudeSessionId?: string
  /** False when the transcript is gone, so resuming would fail. */
  resumable?: boolean
}

export interface SavedState {
  theme?: string
  panes: SavedPane[]
  activeIndex?: number
}

export interface TorcApi {
  brand: { name: string; id: string; tagline: string }
  platform: NodeJS.Platform
  /** Set by TORC_THEME in dev to boot into a specific theme. */
  devTheme?: string
  /** True when TORC_QA/TORC_DEMO is set, so the packaged build stays testable. */
  qaEnabled?: boolean
  sessions: {
    create(spec: SessionSpec): Promise<SessionSnapshot>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<void>
    list(): Promise<SessionSnapshot[]>
    /** Clears the "finished, unread" attention flag for a pane. */
    markRead(id: string): void
  }
  home(): Promise<string>
  /** Where to open an agent when the user hasn't said. */
  defaultCwd(): Promise<string>
  loadState(): Promise<SavedState | undefined>
  saveState(state: SavedState): void
  openIn(path: string, target: 'editor' | 'finder'): void
  onFocusPane(cb: (claudeSessionId: string) => void): () => void
  /** Native folder picker; resolves null if the user cancels. */
  pickDirectory(): Promise<string | null>
  /** Each returns an unsubscribe function. */
  onData(cb: (id: string, chunk: string) => void): () => void
  onExit(cb: (id: string, exitCode: number) => void): () => void
  onUpdate(cb: (snapshot: SessionSnapshot) => void): () => void
}
