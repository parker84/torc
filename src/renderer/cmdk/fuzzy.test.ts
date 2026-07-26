import { describe, expect, it } from 'vitest'
import { fuzzy } from './fuzzy'

describe('fuzzy', () => {
  it('rejects non-subsequences', () => {
    expect(fuzzy('zzz', 'New agent')).toBeNull()
  })

  it('matches everything on an empty query', () => {
    expect(fuzzy('', 'New agent')).toEqual({ score: 0, indices: [] })
  })

  it('ranks word-start initials above buried matches', () => {
    const initials = fuzzy('nag', 'New agent')
    const buried = fuzzy('nag', 'Manage settings')
    expect(initials).not.toBeNull()
    expect(buried).not.toBeNull()
    expect(initials!.score).toBeGreaterThan(buried!.score)
  })

  it('prefers the shorter of two otherwise equal matches', () => {
    const short = fuzzy('new agent', 'New agent')!
    const long = fuzzy('new agent', 'New agent in a git worktree')!
    expect(short.score).toBeGreaterThan(long.score)
  })

  it('reports match indices for highlighting', () => {
    expect(fuzzy('mat', 'Theme: Matrix')!.indices).toEqual([7, 8, 9])
  })

  it('is case insensitive', () => {
    expect(fuzzy('MATRIX', 'Theme: Matrix')).not.toBeNull()
  })
})
