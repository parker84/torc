import { describe, expect, it } from 'vitest'
import { previous, touch } from './recency'

describe('touch', () => {
  it('puts the newest first', () => {
    expect(touch(['b', 'c'], 'a')).toEqual(['a', 'b', 'c'])
  })

  it('moves a revisited pane to the front rather than duplicating it', () => {
    expect(touch(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('caps the history', () => {
    const long = Array.from({ length: 30 }, (_, i) => `p${i}`)
    expect(touch(long, 'new')).toHaveLength(20)
  })
})

describe('previous', () => {
  const alive = ['a', 'b', 'c']

  it('skips the pane we are already on', () => {
    // This is the bug that shipped: ⌘1-9 set activeId without recording focus,
    // so the history was empty and ⌃⇥ did nothing.
    expect(previous(['a', 'b'], 'a', alive)).toBe('b')
  })

  it('ignores panes that have been closed', () => {
    expect(previous(['a', 'gone', 'c'], 'a', alive)).toBe('c')
  })

  it('returns undefined when there is nowhere to go', () => {
    expect(previous(['a'], 'a', alive)).toBeUndefined()
    expect(previous([], null, alive)).toBeUndefined()
  })

  it('alternates between two panes on repeated presses', () => {
    let recent = touch(touch([], 'a'), 'b')
    const first = previous(recent, 'b', alive)
    expect(first).toBe('a')
    recent = touch(recent, first!)
    expect(previous(recent, 'a', alive)).toBe('b')
  })
})
