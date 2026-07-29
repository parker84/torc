import { describe, expect, it } from 'vitest'
import { parseLsofCwd, probeCwds } from './cwdProbe'

describe('parseLsofCwd', () => {
  it('reads one directory per process set', () => {
    const stdout = [
      'p18210',
      'fcwd',
      'n/Users/b/Documents/stan',
      'p35430',
      'fcwd',
      'n/Users/b/Documents/side/torc',
      '',
    ].join('\n')

    expect(parseLsofCwd(stdout)).toEqual(
      new Map([
        [18210, '/Users/b/Documents/stan'],
        [35430, '/Users/b/Documents/side/torc'],
      ]),
    )
  })

  it('keeps directories with spaces intact', () => {
    const parsed = parseLsofCwd('p1\nfcwd\nn/Users/b/My Projects/side thing\n')
    expect(parsed.get(1)).toBe('/Users/b/My Projects/side thing')
  })

  it('ignores a path with no process set to attach to', () => {
    expect(parseLsofCwd('n/Users/b/orphan\n').size).toBe(0)
  })

  it('returns nothing for empty output', () => {
    expect(parseLsofCwd('').size).toBe(0)
  })
})

describe('probeCwds', () => {
  it('skips the subprocess entirely when there is nothing to ask about', async () => {
    expect((await probeCwds([])).size).toBe(0)
    // node-pty reports pid 0 for a spawn that never got off the ground.
    expect((await probeCwds([0, -1])).size).toBe(0)
  })

  it('reports this process own working directory', async () => {
    const cwds = await probeCwds([process.pid])
    // Only darwin and linux can answer; elsewhere an empty map is the contract.
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(cwds.get(process.pid)).toBe(process.cwd())
    } else {
      expect(cwds.size).toBe(0)
    }
  })
})
