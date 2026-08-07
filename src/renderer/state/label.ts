import type { SessionSnapshot } from '@shared/types'

/** Everything a label needs, so callers can pass a snapshot or a saved pane. */
type Labelled = Pick<SessionSnapshot, 'title' | 'aiTitle' | 'renamed'>

/**
 * What a pane is called in the rail, the palette and Mission Control. Claude's
 * own title for the conversation says far more than "torc 2", so it beats the
 * name derived from the folder — but a name the user typed beats both, or
 * renaming a pane would look undone the moment the agent titled its next turn.
 */
export function paneLabel(pane: Labelled): string {
  if (pane.renamed) return pane.title
  return pane.aiTitle || pane.title
}
