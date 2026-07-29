import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Parses `lsof -Fn` output. A `p<pid>` line opens a process set and the `n` line
 * inside it carries the path; lsof also emits the `f` (descriptor) field whether
 * we asked for it or not, so anything that isn't `p` or `n` is skipped.
 */
export function parseLsofCwd(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | undefined
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const parsed = Number(line.slice(1))
      pid = Number.isFinite(parsed) ? parsed : undefined
    } else if (line.startsWith('n') && pid !== undefined) {
      cwds.set(pid, line.slice(1))
    }
  }
  return cwds
}

/**
 * The live working directory of each pid. A `cd` leaves no trace in a pty's
 * output that we could parse, so asking the kernel is the only way to know where
 * a shell pane has got to. One call for the whole fleet — batched, an lsof
 * restricted to a pid list costs a few tens of milliseconds.
 */
export async function probeCwds(pids: number[]): Promise<Map<number, string>> {
  const wanted = pids.filter((pid) => Number.isFinite(pid) && pid > 0)
  if (wanted.length === 0) return new Map()

  if (process.platform === 'linux') {
    const entries = await Promise.all(
      wanted.map(async (pid) => {
        try {
          return [pid, await readlink(`/proc/${pid}/cwd`)] as const
        } catch {
          // Process gone, or not ours to read.
          return undefined
        }
      }),
    )
    return new Map(entries.filter((entry): entry is [number, string] => entry !== undefined))
  }

  // Windows has no cheap equivalent; panes there simply keep their launch cwd.
  if (process.platform !== 'darwin') return new Map()

  try {
    const { stdout } = await execFileAsync(
      // Absolute path: a GUI-launched Electron app inherits a bare PATH.
      '/usr/sbin/lsof',
      ['-a', '-w', '-d', 'cwd', '-Fn', '-p', wanted.join(',')],
      { timeout: 4000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    )
    return parseLsofCwd(stdout)
  } catch (error) {
    // lsof exits non-zero when some of the pids have already gone, having still
    // printed what it found for the rest.
    const stdout = (error as { stdout?: string }).stdout
    return stdout ? parseLsofCwd(stdout) : new Map()
  }
}
