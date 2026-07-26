import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

/**
 * Receives Claude Code hook events over loopback. Hooks are the only source
 * that reports state the instant it changes — in particular `Notification`,
 * which is what tells us an agent is sitting blocked on a permission prompt.
 *
 * Guarded by a per-run token in the query string. The port is ephemeral and
 * bound to 127.0.0.1 only.
 */
export interface HookEvent {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  message?: string
  [key: string]: unknown
}

export class HookBridge {
  private server?: Server
  private token = randomBytes(16).toString('hex')
  private port = 0

  constructor(private onEvent: (event: HookEvent) => void) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      // Always answer immediately and cheaply: a hook waiting on us is an agent
      // waiting on us.
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method !== 'POST' || url.pathname !== '/hook' || url.searchParams.get('t') !== this.token) {
        res.writeHead(404).end()
        return
      }

      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        // Cap the body; a hook payload is small and we never want to buffer a
        // runaway writer.
        if (chunks.length < 256) chunks.push(chunk)
      })
      req.on('end', () => {
        res.writeHead(204).end()
        try {
          this.onEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookEvent)
        } catch {
          // Not JSON — nothing useful to do with it.
        }
      })
      req.on('error', () => res.writeHead(400).end())
    })

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address()
        if (address && typeof address === 'object') this.port = address.port
        resolve()
      })
    })
  }

  /** The value handed to each PTY as $TORC_HOOK_URL. */
  get url(): string {
    return `http://127.0.0.1:${this.port}/hook?t=${this.token}`
  }

  stop(): void {
    this.server?.close()
    this.server = undefined
  }
}
