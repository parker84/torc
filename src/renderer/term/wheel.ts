/** xterm's default multiplier for Option/Alt wheel scrolling. */
const FAST_SCROLL_SENSITIVITY = 5

/**
 * Converts the three DOM wheel units into the fractional rows xterm's browser
 * viewport accepts. Keeping the fraction is important: rounding here turns a
 * trackpad gesture into a sequence of visible one-row jumps.
 */
export function wheelLines(
  deltaY: number,
  deltaMode: number,
  rowHeight: number,
  rows: number,
  fast: boolean,
): number {
  const lines =
    deltaMode === 1 ? deltaY : deltaMode === 2 ? deltaY * rows : deltaY / rowHeight
  return lines * (fast ? FAST_SCROLL_SENSITIVITY : 1)
}
