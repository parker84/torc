import { describe, expect, it } from 'vitest'
import { reorderById } from './reorder'

const panes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
const ids = (items: typeof panes) => items.map((item) => item.id)

describe('reorderById', () => {
  it('moves a pane forward before its target', () => {
    expect(ids(reorderById(panes, 'a', 'd', 'before'))).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves a pane backward after its target', () => {
    expect(ids(reorderById(panes, 'd', 'a', 'after'))).toEqual(['a', 'd', 'b', 'c'])
  })

  it('can move panes to either end', () => {
    expect(ids(reorderById(panes, 'c', 'a', 'before'))).toEqual(['c', 'a', 'b', 'd'])
    expect(ids(reorderById(panes, 'b', 'd', 'after'))).toEqual(['a', 'c', 'd', 'b'])
  })

  it('keeps the original array for self moves and unknown panes', () => {
    expect(reorderById(panes, 'b', 'b', 'before')).toBe(panes)
    expect(reorderById(panes, 'missing', 'a', 'before')).toBe(panes)
    expect(reorderById(panes, 'a', 'missing', 'after')).toBe(panes)
  })
})
