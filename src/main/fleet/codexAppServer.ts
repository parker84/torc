import { spawn, type ChildProcess } from 'node:child_process'
import { resolveUserEnv } from '../env'

export interface CodexThread {
  id: string
  cwd: string
  name?: string
  preview?: string
  model?: string
  status?: { type?: string; activeFlags?: string[] }
  gitInfo?: { branch?: string }
  createdAt?: number
}

export type CodexEvent =
  | { type: 'thread'; thread: CodexThread }
  | { type: 'status'; threadId: string; status: CodexThread['status'] }
  | { type: 'name'; threadId: string; name?: string }
  | { type: 'turn-started'; threadId: string; startedAt?: number }
  | { type: 'turn-completed'; threadId: string; failed: boolean }
  | { type: 'item-started'; threadId: string; item: Record<string, unknown>; startedAt: number }
  | { type: 'item-completed'; threadId: string; item: Record<string, unknown>; completedAt: number }
  | { type: 'tokens'; threadId: string; usage: Record<string, number> }
  | { type: 'request'; threadId: string }
  | { type: 'request-resolved'; threadId: string }
  | { type: 'closed'; threadId: string }

/**
 * Owns one local Codex app-server and observes it through its stdio proxy. Codex
 * panes connect to the Unix socket, keeping terminal rendering in the TUI while
 * Torc consumes the same structured protocol as a second client.
 */
export class CodexAppServer {
  private server?: ChildProcess
  private socket?: WebSocket
  private buffer = ''
  private nextId = 1
  private initializeRequestId?: number
  private listRequestId?: number
  private remote?: string

  constructor(private onEvent: (event: CodexEvent) => void) {}

  get remoteUrl(): string | undefined {
    return this.remote
  }

  async start(): Promise<void> {
    const env = await resolveUserEnv()
    this.server = spawn('codex', ['app-server', '--listen', 'ws://127.0.0.1:0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    this.remote = await new Promise<string>((resolve, reject) => {
      let startup = ''
      const timeout = setTimeout(() => reject(new Error('Codex app-server did not start')), 5000)
      const consume = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        startup += String(chunk)
        if (process.env.TORC_DEBUG_CODEX) process.stderr.write(`[codex-server:${stream}] ${chunk}`)
        const match = startup.match(/listening on:\s+(ws:\/\/127\.0\.0\.1:\d+)/)
        if (!match) return
        clearTimeout(timeout)
        resolve(match[1])
      }
      this.server?.stdout?.on('data', (chunk: Buffer) => consume(chunk, 'stdout'))
      this.server?.stderr?.on('data', (chunk: Buffer) => consume(chunk, 'stderr'))
      this.server?.once('error', reject)
      this.server?.once('exit', (code) => {
        if (!this.remote) reject(new Error(`Codex app-server exited during startup (${code})`))
      })
    })
    this.server.once('exit', () => {
      this.server = undefined
      this.remote = undefined
    })
    await this.connect()
  }

  stop(): void {
    this.socket?.close()
    this.server?.kill()
    this.socket = undefined
    this.server = undefined
    this.remote = undefined
  }

  private async connect(): Promise<void> {
    if (!this.remote) throw new Error('Codex app-server has not started')
    const socket = new WebSocket(this.remote)
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('Could not connect to Codex app-server')), {
        once: true,
      })
    })
    socket.addEventListener('message', (event) => this.read(`${String(event.data)}\n`))
    this.initializeRequestId = this.send('initialize', {
      clientInfo: { name: 'torc', title: 'Torc', version: '0.0.1' },
      capabilities: null,
    })
  }

  private send(method: string, params: unknown): number {
    const id = this.nextId++
    this.write({ method, id, params })
    return id
  }

  private write(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  private read(chunk: string): void {
    const lines = (this.buffer + chunk).split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      try {
        this.handle(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // App-server logs and partial writes are not protocol messages.
      }
    }
  }

  private handle(message: Record<string, unknown>): void {
    if (message.id === this.initializeRequestId) {
      this.write({ method: 'initialized' })
      this.listRequestId = this.send('thread/list', { limit: 100, sortKey: 'updated_at' })
      return
    }
    if (message.id === this.listRequestId) {
      const result = message.result as { data?: CodexThread[] } | undefined
      for (const thread of result?.data ?? []) this.onEvent({ type: 'thread', thread })
      return
    }

    const method = message.method
    const params = (message.params ?? {}) as Record<string, unknown>
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    if (typeof method !== 'string') return

    if (method === 'thread/started') {
      this.onEvent({ type: 'thread', thread: params.thread as CodexThread })
    } else if (method === 'thread/status/changed' && threadId) {
      this.onEvent({ type: 'status', threadId, status: params.status as CodexThread['status'] })
    } else if (method === 'thread/name/updated' && threadId) {
      this.onEvent({ type: 'name', threadId, name: params.threadName as string | undefined })
    } else if (method === 'turn/started' && threadId) {
      const turn = params.turn as { startedAt?: number }
      this.onEvent({ type: 'turn-started', threadId, startedAt: turn.startedAt })
    } else if (method === 'turn/completed' && threadId) {
      const turn = params.turn as { status?: string }
      this.onEvent({ type: 'turn-completed', threadId, failed: turn.status === 'failed' })
    } else if (method === 'item/started' && threadId) {
      this.onEvent({
        type: 'item-started',
        threadId,
        item: params.item as Record<string, unknown>,
        startedAt: Number(params.startedAtMs) || Date.now(),
      })
    } else if (method === 'item/completed' && threadId) {
      this.onEvent({
        type: 'item-completed',
        threadId,
        item: params.item as Record<string, unknown>,
        completedAt: Number(params.completedAtMs) || Date.now(),
      })
    } else if (method === 'thread/tokenUsage/updated' && threadId) {
      const tokenUsage = params.tokenUsage as { total?: Record<string, number> }
      this.onEvent({ type: 'tokens', threadId, usage: tokenUsage.total ?? {} })
    } else if (method === 'serverRequest/resolved' && threadId) {
      this.onEvent({ type: 'request-resolved', threadId })
    } else if (method === 'thread/closed' && threadId) {
      this.onEvent({ type: 'closed', threadId })
    } else if (message.id !== undefined && threadId && method.includes('request')) {
      this.onEvent({ type: 'request', threadId })
    }
  }
}
