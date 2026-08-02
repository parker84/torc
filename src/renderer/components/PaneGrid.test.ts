import { describe, expect, it } from 'vitest'
import { SLOTS, effectiveGrid, visibleWindow } from '../layout/panes'

describe('effectiveGrid', () => {
  it('gives a lone pane the whole window, whatever the preference', () => {
    expect(effectiveGrid(4, 1)).toBe(1)
    expect(effectiveGrid(2, 1)).toBe(1)
  })

  it('keeps every pane on screen rather than shrinking the grid', () => {
    // Three panes in a 2×2 stay a 2×2; a half would hide one.
    expect(effectiveGrid(4, 3)).toBe(4)
    expect(effectiveGrid(4, 2)).toBe(2)
  })

  it('never exceeds the chosen size', () => {
    expect(effectiveGrid(1, 4)).toBe(1)
    expect(effectiveGrid(2, 9)).toBe(2)
  })

  it('handles an empty fleet', () => {
    expect(effectiveGrid(4, 0)).toBe(1)
  })
})

describe('visibleWindow', () => {
  it('starts at zero when everything fits', () => {
    expect(visibleWindow(2, 1, 4)).toBe(0)
    expect(visibleWindow(4, 3, 4)).toBe(0)
  })

  it('centres the window on the active pane', () => {
    // 6 panes, showing 2, active at index 3 → window starts at 2.
    expect(visibleWindow(6, 3, 2)).toBe(2)
  })

  it('clamps at the start', () => {
    expect(visibleWindow(6, 0, 4)).toBe(0)
  })

  it('clamps at the end so the window is always full', () => {
    // Active is the last pane; the window must not run off the end.
    expect(visibleWindow(6, 5, 4)).toBe(2)
    expect(visibleWindow(6, 5, 2)).toBe(4)
  })

  it('handles no active pane', () => {
    expect(visibleWindow(6, -1, 2)).toBe(0)
  })
})

describe('SLOTS', () => {
  it('provides exactly as many slots as the grid claims', () => {
    expect(SLOTS[1]).toHaveLength(1)
    expect(SLOTS[2]).toHaveLength(2)
    expect(SLOTS[4]).toHaveLength(4)
  })

  it('tiles the area without gaps or overlap', () => {
    for (const size of [1, 2, 4] as const) {
      const area = SLOTS[size].reduce(
        (sum, slot) => sum + (parseFloat(slot.width) / 100) * (parseFloat(slot.height) / 100),
        0,
      )
      expect(area).toBeCloseTo(1, 5)
    }
  })
})
