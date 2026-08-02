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
 * The grid actually rendered, which is not always the one that was chosen.
 *
 * Grid size is a persisted preference, so a 2×2 outlives the panes that
 * justified it — close three of four and the survivor keeps a quarter of the
 * window with three empty slots beside it. Worse, a QA run that sets a split
 * leaves the preference behind, and the next launch opens ⌘T into a quadrant
 * for no reason the user can see.
 *
 * So: the smallest grid that still shows every pane, never larger than the
 * preference. Three panes in a 2×2 keep the 2×2 — shrinking to a half would
 * hide one, which is worse than an empty slot. The preference itself is left
 * alone; opening more panes brings the split straight back.
 */
export function effectiveGrid(size: GridSize, paneCount: number): GridSize {
  const fits = ([1, 2, 4] as const).find((n) => n >= paneCount) ?? 4
  return Math.min(fits, size) as GridSize
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
