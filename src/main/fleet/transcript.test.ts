import { describe, expect, it } from 'vitest'
import { projectSlug, summarizeTool } from './transcript'
import { isDescendantOf } from './agentsPoller'

describe('projectSlug', () => {
  it('matches Claude Code’s directory naming', () => {
    // Verified against ~/.claude/projects on this machine.
    expect(projectSlug('/Users/brydonparker/Documents/side')).toBe(
      '-Users-brydonparker-Documents-side',
    )
  })
})

describe('summarizeTool', () => {
  it('shows the command for Bash', () => {
    expect(summarizeTool('Bash', { command: 'pytest -q' })).toBe('pytest -q')
  })

  it('reduces file paths to a basename', () => {
    expect(summarizeTool('Read', { file_path: '/a/b/c/store.py' })).toBe('store.py')
    expect(summarizeTool('Edit', { file_path: '/a/b/c/store.py' })).toBe('store.py')
  })

  it('keeps full paths for tools where the location is the point', () => {
    expect(summarizeTool('Glob', { path: '/a/b/c' })).toBe('/a/b/c')
  })

  it('collapses whitespace and truncates long commands', () => {
    const summary = summarizeTool('Bash', { command: `grep -rn "x"${' '.repeat(10)}${'y'.repeat(90)}` })
    expect(summary).toHaveLength(64)
    expect(summary?.endsWith('…')).toBe(true)
    expect(summary).not.toContain('  ')
  })

  it('returns undefined when there is nothing worth showing', () => {
    expect(summarizeTool('TodoWrite', {})).toBeUndefined()
  })
})

describe('isDescendantOf', () => {
  // pid 400 → 300 → 200 (the pane's pty) → 100
  const parents = new Map([
    [400, 300],
    [300, 200],
    [200, 100],
  ])

  it('finds an indirect descendant', () => {
    expect(isDescendantOf(400, 200, parents)).toBe(true)
  })

  it('rejects an unrelated process', () => {
    expect(isDescendantOf(400, 999, parents)).toBe(false)
  })

  it('does not spin on a cycle', () => {
    const cyclic = new Map([
      [10, 11],
      [11, 10],
    ])
    expect(isDescendantOf(10, 42, cyclic)).toBe(false)
  })
})
