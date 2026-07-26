import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'

const execFileAsync = promisify(execFile)

/**
 * A GUI-launched Electron app inherits a bare PATH (`/usr/bin:/bin:...`), so
 * `claude` — which lives in ~/.local/bin — is invisible to it. Ask the user's
 * login shell for the real environment once at startup and reuse it for every
 * PTY we spawn. This is why panes behave the same in `npm run dev` and in a
 * packaged .app.
 */
let cached: Record<string, string> | undefined

/**
 * Session-scoped variables that must never reach a spawned agent. If Torc is
 * launched from inside a Claude Code session — which is exactly how you'd try
 * it the first time — these leak down into every pane, and the inherited
 * CLAUDE_CODE_CHILD_SESSION marker makes Claude skip writing a transcript.
 * That would silently disable Torc's own monitoring, since the transcript is
 * what we tail.
 */
const STRIP_PREFIXES = ['CLAUDE_CODE_', 'TORC_']
const STRIP_EXACT = new Set(['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_PID'])
/** Genuine user preferences that happen to share the prefix. */
const KEEP_EXACT = new Set(['CLAUDE_CODE_ENABLE_TELEMETRY'])

function scrubSessionMarkers(env: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(env)) {
    if (KEEP_EXACT.has(key)) continue
    if (STRIP_EXACT.has(key) || STRIP_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key]
    }
  }
  return env
}

export async function resolveUserEnv(): Promise<Record<string, string>> {
  if (cached) return cached

  const base = { ...process.env } as Record<string, string>

  if (process.platform === 'win32') {
    cached = scrubSessionMarkers(base)
    return cached
  }

  const shell = process.env.SHELL || '/bin/zsh'
  // A unique marker keeps us from parsing whatever the user's profile prints.
  const marker = '__TORC_ENV__'

  try {
    const { stdout } = await execFileAsync(
      shell,
      ['-lic', `printf "%s" "${marker}"; /usr/bin/env; printf "%s" "${marker}"`],
      { timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    )

    const body = stdout.split(marker)[1]
    if (body) {
      for (const line of body.split('\n')) {
        const eq = line.indexOf('=')
        if (eq > 0) base[line.slice(0, eq)] = line.slice(eq + 1)
      }
    }
  } catch {
    // A broken or slow profile must never stop the app from opening — fall
    // back to a best-effort PATH that at least covers the usual install spots.
    const home = os.homedir()
    base.PATH = [
      `${home}/.local/bin`,
      `${home}/.bun/bin`,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      base.PATH ?? '/usr/bin:/bin',
    ].join(':')
  }

  // Scrub after merging: the login shell is our child, so it hands the same
  // markers back to us in its own environment.
  cached = scrubSessionMarkers(base)
  return cached
}
