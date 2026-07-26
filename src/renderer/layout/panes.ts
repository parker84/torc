import type { GridSize } from '../state/store'

/**
 * Pure layout maths, kept free of React and the store so it can be tested
 * without a DOM.
 */
export interface Slot {
  left: string
  top: string
  width: string
  height: string
}

export const SLOTS: Record<GridSize, Slot[]> = {
  1: [{ left: '0%', top: '0%', width: '100%', height: '100%' }],
  2: [
    { left: '0%', top: '0%', width: '50%', height: '100%' },
    { left: '50%', top: '0%', width: '50%', height: '100%' },
  ],
  4: [
    { left: '0%', top: '0%', width: '50%', height: '50%' },
    { left: '50%', top: '0%', width: '50%', height: '50%' },
    { left: '0%', top: '50%', width: '50%', height: '50%' },
    { left: '50%', top: '50%', width: '50%', height: '50%' },
  ],
}

/**
 * Which panes are on screen: a window of `size` panes that always contains the
 * active one, so ⌘⇧] past the edge scrolls the window rather than losing your
 * place.
 */
export function visibleWindow(count: number, activeIndex: number, size: GridSize): number {
  if (count <= size || activeIndex < 0) return 0
  return Math.min(Math.max(activeIndex - Math.floor(size / 2), 0), count - size)
}
