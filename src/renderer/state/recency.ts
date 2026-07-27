/**
 * Recency bookkeeping for ⌃⇥, kept pure so the ordering rules are testable
 * without a store or a DOM.
 */
const MAX_RECENT = 20

/** Records a focus event, most recent first, without duplicates. */
export function touch(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, MAX_RECENT)
}

/**
 * The pane ⌃⇥ should go to: the most recent one that isn't where we are and
 * still exists. Returns undefined when there's nowhere to go back to.
 */
export function previous(
  recent: readonly string[],
  activeId: string | null,
  alive: readonly string[],
): string | undefined {
  return recent.find((id) => id !== activeId && alive.includes(id))
}
