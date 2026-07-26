import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveUserEnv } from '../env'

const execFileAsync = promisify(execFile)

/**
 * `claude agents --json` is a ready-made registry of every live session on the
 * machine — including ones Torc never launched, which is how a `claude` you
 * typed yourself into a ⌘T shell still gets monitored.
 */
export interface DiscoveredAgent {
  pid: number
  cwd: string
  kind: string
  startedAt: number
  sessionId: string
  name: string
  status: 'busy' | 'idle' | string
}

const POLL_MS = 2500

export class AgentsPoller {
  private timer?: NodeJS.Timeout
  private running = false

  constructor(private onPoll: (agents: DiscoveredAgent[]) => void) {}

  start(): void {
    if (this.timer) return
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async poll(): Promise<void> {
    // Skip if the previous run is still going; a slow machine shouldn't stack
    // up overlapping `claude` invocations.
    if (this.running) return
    this.running = true
    try {
      const env = await resolveUserEnv()
      const { stdout } = await execFileAsync('claude', ['agents', '--json'], {
        env,
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      })
      const parsed = JSON.parse(stdout) as DiscoveredAgent[]
      if (Array.isArray(parsed)) this.onPoll(parsed)
    } catch {
      // claude missing, no sessions, or malformed output — the next tick retries.
    } finally {
      this.running = false
    }
  }
}

/**
 * Maps every pid to its parent so a discovered agent can be traced back to the
 * pane whose PTY it was started under. Without this, a `claude` typed into a
 * shell pane could only be matched by cwd, which is ambiguous the moment two
 * panes sit in the same repo.
 */
export async function processParents(): Promise<Map<number, number>> {
  const parents = new Map<number, number>()
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-eo', 'pid=,ppid='], {
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    })
    for (const line of stdout.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (Number.isFinite(pid) && Number.isFinite(ppid)) parents.set(pid, ppid)
    }
  } catch {
    // Without the table we simply fall back to cwd matching.
  }
  return parents
}

/** Walks up the parent chain looking for `ancestor`. */
export function isDescendantOf(
  pid: number,
  ancestor: number,
  parents: Map<number, number>,
): boolean {
  let current = pid
  // Bounded: a runaway or cyclic table must not spin forever.
  for (let hops = 0; hops < 64; hops++) {
    const parent = parents.get(current)
    if (parent === undefined || parent <= 1) return false
    if (parent === ancestor) return true
    current = parent
  }
  return false
}
