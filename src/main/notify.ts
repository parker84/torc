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

export function updateAttention(
  snapshots: SessionSnapshot[],
  window: BrowserWindow | null,
  onActivate: (paneId: string) => void,
): void {
  const live = new Set(snapshots.map((s) => s.id))
  for (const id of attentive) {
    if (!live.has(id)) attentive.delete(id)
  }

  const focused = window?.isFocused() ?? false

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
      window?.show()
      window?.focus()
      onActivate(snapshot.id)
    })
    notification.show()
  }

  // Badge the dock with how many agents are waiting.
  const waiting = snapshots.filter((s) => s.needsAttention).length
  if (process.platform === 'darwin') {
    app.dock?.setBadge(waiting > 0 ? String(waiting) : '')
  }
  window?.setTitle(waiting > 0 ? `${BRAND.name} — ${waiting} waiting` : BRAND.name)
}

/** Called when the window regains focus: the user is looking, so stop badging. */
export function clearBadge(): void {
  if (process.platform === 'darwin') app.dock?.setBadge('')
}
