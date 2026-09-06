export type DropEdge = 'before' | 'after'

/**
 * Moves one item beside another without changing the identity of either. The
 * same array is returned for invalid and self moves so callers can avoid a
 * pointless render.
 */
export function reorderById<T extends { id: string }>(
  items: T[],
  movedId: string,
  targetId: string,
  edge: DropEdge,
): T[] {
  if (movedId === targetId) return items

  const movedIndex = items.findIndex((item) => item.id === movedId)
  const targetIndex = items.findIndex((item) => item.id === targetId)
  if (movedIndex < 0 || targetIndex < 0) return items

  const next = [...items]
  const [moved] = next.splice(movedIndex, 1)
  const remainingTargetIndex = next.findIndex((item) => item.id === targetId)
  const insertAt = remainingTargetIndex + (edge === 'after' ? 1 : 0)
  next.splice(insertAt, 0, moved)
  return next
}
