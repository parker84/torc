import { app, BrowserWindow, Notification } from 'electron'
import type { SessionSnapshot } from '@shared/types'
import { BRAND } from '@shared/brand'

/**
 * The point of Torc is to stop you polling tabs, which only works if it can
 * reach you when you're looking somewhere else. Notifications fire on the
 * *transition* into needing attention, never repeatedly, and never while you're
 * already looking at that pane.
 */
const attentive = new Set<string>()

function summarize(snapshot: SessionSnapshot): string {
  if (snapshot.status === 'error') {
    return `exited with code ${snapshot.exitCode ?? 1}`
  }
  if (snapshot.status === 'needs-input') return 'is waiting on you'
  return 'finished and is waiting for a look'
}

/**
 * One window and the panes that live in it. Attention is worked out per window
 * rather than per app: a pane in a window you can't see still needs to reach
 * you, even while another Torc window has focus.
 */
export interface AttentionGroup {
  window: BrowserWindow
  snapshots: SessionSnapshot[]
}

/** Returns how many notifications were actually shown, so QA can assert on it. */
export function updateAttention(
  groups: AttentionGroup[],
  onActivate: (window: BrowserWindow, paneId: string) => void,
): number {
  let shown = 0
  // Pruned against every window's panes at once. Pruning per group would have
  // each window forgetting the others' panes and re-notifying for them.
  const live = new Set(groups.flatMap((group) => group.snapshots.map((s) => s.id)))
  for (const id of attentive) {
    if (!live.has(id)) attentive.delete(id)
  }

  let waitingOverall = 0

  for (const { window, snapshots } of groups) {
    const focused = window.isFocused()

    for (const snapshot of snapshots) {
      if (!snapshot.needsAttention) {
        attentive.delete(snapshot.id)
        continue
      }
      if (attentive.has(snapshot.id)) continue
      attentive.add(snapshot.id)

      // Don't interrupt for the pane the user is already watching.
      if (focused) continue
      if (!Notification.isSupported()) continue

      const notification = new Notification({
        title: `${snapshot.title} ${summarize(snapshot)}`,
        body: snapshot.aiTitle || snapshot.cwd,
        silent: false,
      })
      notification.on('click', () => {
        if (window.isDestroyed()) return
        window.show()
        window.focus()
        onActivate(window, snapshot.id)
      })
      notification.show()
      shown++
    }

    // Each window says what it is holding up; the dock badge totals them.
    const waiting = snapshots.filter((s) => s.needsAttention).length
    waitingOverall += waiting
    window.setTitle(waiting > 0 ? `${BRAND.name} — ${waiting} waiting` : BRAND.name)
  }

  if (process.platform === 'darwin') {
    app.dock?.setBadge(waitingOverall > 0 ? String(waitingOverall) : '')
  }
  return shown
}

/** Called when a window regains focus: the user is looking, so stop badging. */
export function clearBadge(): void {
  if (process.platform === 'darwin') app.dock?.setBadge('')
}
