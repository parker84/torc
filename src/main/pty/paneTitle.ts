import { basename } from 'node:path'

/** What a pane is called when the user hasn't named it: the folder it sits in. */
export function titleFor(cwd: string): string {
  return basename(cwd) || 'session'
}

/**
 * True when `title` is one Torc derived from `cwd` — the bare basename, or a
 * numbered repeat of it. Auto-titled panes follow their directory as it changes;
 * a name the user chose is left alone.
 */
export function isAutoTitle(title: string, cwd: string): boolean {
  const base = titleFor(cwd)
  if (title === base) return true
  if (!title.startsWith(`${base} `)) return false
  return /^\d+$/.test(title.slice(base.length + 1))
}

/**
 * Several panes in one repo all want to be called "torc"; number the repeats so
 * the rail and the palette stay tellable apart.
 */
export function uniqueTitle(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!used.has(candidate)) return candidate
  }
}
