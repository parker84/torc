import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { BRAND } from '@shared/brand'
import { IPC, type AgentKind, type SavedState, type SessionSpec } from '@shared/types'
import { SessionManager } from './pty/SessionManager'
import { FleetMonitor } from './fleet/monitor'
import { writeHooksSettings } from './fleet/hooksSettings'
import { writeClaudeShim } from './fleet/claudeShim'
import { resolveUserEnv } from './env'
import { updateAttention } from './notify'
import { loadState } from './store/persist'
import { WindowManager } from './windows'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Must happen before `ready`: the appMenu role reads app.name when it builds,
// and in dev the bundle would otherwise report itself as "Electron".
app.setName(BRAND.name)

/**
 * A harness drives a throwaway window on purpose, usually while the real app is
 * open — so it is exempt from the lock below. It still shares `~/.torc/`, so a
 * harness run can overwrite a saved layout; that is the cost of not giving it a
 * userData directory of its own, and it is why the harnesses are opt-in.
 */
const isHarness = Boolean(
  process.env.TORC_SCENARIOS ||
    process.env.TORC_QA ||
    process.env.TORC_DEMO ||
    process.env.TORC_PROBE,
)

/**
 * A second instance with somewhere else to keep its state. Electron takes
 * userData from the passwd database rather than `$HOME`, so overriding HOME
 * alone still leaves two instances sharing one singleton lock — which is what
 * stands between a dev build and being testable beside the real app. Set this
 * together with HOME and the two share nothing: own lock, own `~/.torc`, own
 * shim, own hook bridge. Must land before the lock is requested.
 */
if (process.env.TORC_USER_DATA) {
  app.setPath('userData', process.env.TORC_USER_DATA)
}

/**
 * Two Torc instances silently corrupt each other. `~/.torc/state.json` is
 * rewritten on every layout change, so whichever quits last overwrites the
 * other's fleet — and a dev build left running beside the packaged app is the
 * normal way to end up with two. The lock is taken before anything is created
 * because the loser must not bind a hook bridge port or rewrite the `claude`
 * shim on its way back out. Note this is one *instance*, not one window: ⌘N
 * opens another window inside the process that already holds the lock.
 */
const hasInstanceLock = isHarness || app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()

/**
 * Where a new agent goes when there's no better answer. `process.cwd()` is the
 * repo you ran `npm run dev` from, which is almost always what you want; in a
 * packaged app it's "/" so fall back to the home directory.
 */
const launchCwd = process.cwd() === '/' ? homedir() : process.cwd()

/**
 * Quitting closes every window, which must not be read as the user closing them
 * one by one — that would erase the layout on the way out. See WindowManager.
 */
let quitting = false

const windows = new WindowManager({
  preload: join(__dirname, '../preload/index.mjs'),
  devUrl: process.env.ELECTRON_RENDERER_URL,
  rendererFile: join(__dirname, '../renderer/index.html'),
  logConsole: !app.isPackaged,
  onClosed: (windowId) => {
    // A pane with no window is a `claude` nobody can see or type into.
    for (const id of sessions.idsIn(windowId)) sessions.kill(id)
  },
  isQuitting: () => quitting,
})

const sessions = new SessionManager({
  onData: (id, chunk) => windows.sendTo(sessions.windowIdOf(id), IPC.sessionData, id, chunk),
  onExit: (id, exitCode) =>
    windows.sendTo(sessions.windowIdOf(id), IPC.sessionExit, id, exitCode),
  onUpdate: (snapshot) => {
    windows.sendTo(sessions.windowIdOf(snapshot.id), IPC.sessionUpdate, snapshot)
    updateAttention(
      windows.all().map((window) => ({
        window,
        snapshots: sessions.list(window.webContents.id),
      })),
      (window, paneId) => window.webContents.send(IPC.focusPane, paneId),
    )
  },
  onCreated: (snapshot) => monitor.track(snapshot),
  onClosed: (id) => monitor.untrack(id),
})

const monitor = new FleetMonitor(sessions)

/** Menu commands and dev autostart go to whichever window you're looking at. */
function send(channel: string, ...args: unknown[]): void {
  windows.sendToFocused(channel, ...args)
}

/**
 * The first window is the one the harnesses drive, so everything env-triggered
 * hangs off it. Later windows — ⌘N, or a second saved workspace — are plain.
 */
function createFirstWindow(): BrowserWindow {
  const saved = loadState()
  // A harness gets exactly one window whatever the file says: it drives `win`
  // and counts panes, and a second restored workspace would put panes it never
  // opened into the fleet it is asserting on.
  const slots = saved?.windows.length ? saved.windows : [undefined]
  const [first, ...rest] = isHarness ? slots.slice(0, 1) : slots

  const window = windows.create({ theme: saved?.theme, ...first })

  window.on('ready-to-show', () => {
    if (process.env.TORC_SCENARIOS) {
      // A red assertion has to reach the shell, or the suite is decoration.
      // `app.quit()` honours process.exitCode, so setting it before quitting is
      // enough — and a harness that *threw* has not passed either, which is what
      // the catch is for: without it the rejection is swallowed and the run
      // still looks clean.
      const finish = (code: number): void => {
        process.exitCode = code
        if (!process.env.TORC_QA_EXIT) return
        // Getting the code out of Electron takes some care. Its own shutdown
        // exits 0 whatever `process.exitCode` says — the same bug this ticket is
        // about, one layer out. But leaving abruptly is worse: both `app.exit()`
        // and a bare `process.exit()` orphan the GPU and renderer helpers, which
        // keep the inherited stdout open, so the runner sits on a pipe that never
        // closes and the run hangs instead of failing. So: quit in order, and set
        // the code once the helpers are down.
        app.once('quit', () => process.exit(code))
        sessions.disposeAll()
        app.quit()
      }
      void import('./scenarios')
        .then(({ runScenarios }) =>
          runScenarios(window, process.env.TORC_SCENARIOS!, {
            windows: () => windows.all(),
            liveSessions: () => sessions.list().length,
            savedWindows: () => loadState()?.windows.length ?? 0,
          }),
        )
        .then(({ passed, failed }) => {
          console.log(
            failed > 0
              ? `[scenario] FAILED — ${failed} of ${passed + failed} assertions`
              : `[scenario] all ${passed} assertions passed`,
          )
          finish(failed > 0 ? 1 : 0)
        })
        .catch((error) => {
          console.error('[scenario] harness threw before it could finish:', error)
          finish(1)
        })
      return
    }

    if (process.env.TORC_DEMO) {
      void import('./demo').then(({ runDemo }) =>
        runDemo(window, process.env.TORC_DEMO!).then(() => {
          if (process.env.TORC_QA_EXIT) {
            sessions.disposeAll()
            app.quit()
          }
        }),
      )
      return
    }

    if (process.env.TORC_QA) {
      void import('./qa').then(({ runQa }) =>
        runQa(window, process.env.TORC_QA!).then(() => {
          if (process.env.TORC_QA_EXIT) {
            sessions.disposeAll()
            app.quit()
          }
        }),
      )
      return
    }
    // Dev convenience: TORC_AUTOSTART=1 opens one agent on boot so the app can
    // be smoke-tested without touching the keyboard.
    if (process.env.TORC_AUTOSTART) {
      const which = process.env.TORC_AUTOSTART === 'agent' ? 'new-agent' : 'new-terminal'
      setTimeout(() => send(`menu:${which}`), 300)
    }
  })

  // Every other workspace the last session had open. Opened after the first so
  // the window you were last in is the one that ends up in front.
  for (const slot of rest) windows.create({ theme: saved?.theme, ...slot })

  return window
}

function buildMenu(): void {
  // Roles matter here: without them Cmd-C/Cmd-V don't reach xterm.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'Session',
        submenu: [
          {
            // ⌘T is a plain shell, as in every other terminal. You run `claude`
            // yourself; Torc discovers the session and starts monitoring it.
            label: 'New Terminal',
            accelerator: 'CmdOrCtrl+T',
            click: () => send('menu:new-terminal'),
          },
          {
            label: 'New Agent',
            accelerator: 'CmdOrCtrl+Shift+T',
            click: () => send('menu:new-agent'),
          },
          { type: 'separator' },
          {
            // ⌘N/⇧⌘N mirror ⌘T/⇧⌘T one level up: same pair of things to open,
            // in a window of their own rather than a pane of the current one.
            label: 'New Window',
            accelerator: 'CmdOrCtrl+N',
            click: () => windows.create({ seed: 'shell' }),
          },
          {
            label: 'New Agent Window',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => windows.create({ seed: 'claude' }),
          },
          { type: 'separator' },
          {
            label: 'Restart Pane',
            accelerator: 'Shift+CmdOrCtrl+R',
            click: () => send('menu:restart-pane'),
          },
          {
            label: 'Close Pane',
            accelerator: 'CmdOrCtrl+W',
            click: () => send('menu:close-pane'),
          },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          {
            label: 'Command Palette…',
            accelerator: 'CmdOrCtrl+K',
            click: () => send('menu:palette'),
          },
          {
            label: 'Mission Control',
            // One key that toggles both ways, within reach of the home row.
            // (Not ⇧⌘M: ⌘M is minimize on macOS.)
            accelerator: 'CmdOrCtrl+Return',
            // Shown in the menu but handled in the renderer: a registered
            // accelerator plus a renderer handler would toggle twice and cancel
            // itself out, and the renderer path is the one proven to fire while
            // xterm holds keyboard focus.
            registerAccelerator: false,
            click: () => send('menu:mission-control'),
          },
          {
            // The quickest jump there is: back to where you just were.
            label: 'Jump Back',
            accelerator: 'Control+Tab',
            click: () => send('menu:jump-back'),
          },
          {
            label: 'Quick Switch…',
            accelerator: 'CmdOrCtrl+P',
            click: () => send('menu:quick-switch'),
          },
          {
            label: 'Next Agent Needing You',
            accelerator: 'Shift+CmdOrCtrl+A',
            click: () => send('menu:next-attention'),
          },
          {
            label: 'Find in Terminal…',
            accelerator: 'CmdOrCtrl+F',
            click: () => send('menu:find'),
          },
          { type: 'separator' },
          {
            label: 'Single Pane',
            accelerator: 'CmdOrCtrl+Alt+1',
            click: () => send('menu:grid-1'),
          },
          {
            label: 'Two Panes',
            accelerator: 'CmdOrCtrl+Alt+2',
            click: () => send('menu:grid-2'),
          },
          {
            label: 'Four Panes',
            accelerator: 'CmdOrCtrl+Alt+4',
            click: () => send('menu:grid-4'),
          },
          { type: 'separator' },
          {
            // The tab-switching gesture every other Mac app uses.
            label: 'Next Agent',
            accelerator: 'Shift+CmdOrCtrl+]',
            click: () => send('menu:next-agent'),
          },
          {
            label: 'Previous Agent',
            accelerator: 'Shift+CmdOrCtrl+[',
            click: () => send('menu:prev-agent'),
          },
          { type: 'separator' },
          {
            label: 'Cycle Theme',
            // ⌥⌘ is this app's appearance group (⌥⌘1/2/4 size the grid), and
            // ⇧⌘T is already New Agent.
            accelerator: 'CmdOrCtrl+Alt+T',
            click: () => send('menu:cycle-theme'),
          },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          // Deliberately not `role: 'windowMenu'`: its Close item also claims
          // ⌘W, which would fight with Close Pane above.
          { role: 'close', accelerator: 'Shift+CmdOrCtrl+W', label: 'Close Window' },
          // macOS only, and the only way to reach a window sitting behind
          // something else. Electron rejects the role on other platforms.
          ...(process.platform === 'darwin'
            ? ([{ type: 'separator' }, { role: 'front' }] as const)
            : []),
        ],
      },
    ]),
  )
}

function registerIpc(): void {
  // The window is recorded before the pty spawns — see SessionManager.create.
  ipcMain.handle(IPC.sessionCreate, (event, spec: SessionSpec) =>
    sessions.create(spec, event.sender.id),
  )
  // A window only ever hears about its own panes.
  ipcMain.handle(IPC.sessionList, (event) => sessions.list(event.sender.id))
  ipcMain.handle(IPC.sessionKill, (_e, id: string) => sessions.kill(id))
  ipcMain.on(IPC.sessionWrite, (_e, id: string, data: string) => sessions.write(id, data))
  ipcMain.on(IPC.sessionResize, (_e, id: string, cols: number, rows: number) =>
    sessions.resize(id, cols, rows),
  )
  // Looking at a pane clears its "finished, unread" attention flag.
  ipcMain.on(IPC.sessionMarkRead, (_e, id: string) => monitor.markRead(id))
  ipcMain.on(IPC.sessionRename, (_e, id: string, title: string) => sessions.rename(id, title))
  ipcMain.on(IPC.paneContextMenu, (event, id: string, selection: string) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const pasteable = clipboard.readText()
    Menu.buildFromTemplate([
      {
        label: 'Copy',
        // Written from the selection we were handed rather than the `copy`
        // role: xterm keeps its selection outside the DOM, so the role would
        // find nothing to copy.
        enabled: selection.length > 0,
        click: () => clipboard.writeText(selection),
      },
      {
        label: 'Paste',
        enabled: pasteable.length > 0,
        click: () => event.sender.send(IPC.panePaste, id, pasteable),
      },
    ]).popup({ window })
  })
  ipcMain.handle(IPC.appHome, () => homedir())
  ipcMain.handle(IPC.appDefaultCwd, () => launchCwd)
  ipcMain.handle(IPC.windowInit, (event) => windows.initFor(event.sender.id))
  ipcMain.on(IPC.windowNew, (_e, seed?: AgentKind) => windows.create({ seed }))
  ipcMain.on(IPC.themeShare, (event, theme: string) =>
    windows.shareTheme(event.sender.id, theme),
  )
  // Each window states its own layout; main is what assembles the file.
  ipcMain.on(IPC.appSaveState, (event, state: SavedState) =>
    windows.remember(event.sender.id, state),
  )
  ipcMain.on(IPC.appOpenIn, async (_e, path: string, target: 'editor' | 'finder') => {
    if (target === 'finder') {
      shell.openPath(path)
      return
    }
    // `code` lives on the login-shell PATH, not the app's.
    const env = await resolveUserEnv()
    execFile('code', [path], { env }, (error) => {
      // No `code` on PATH — fall back to whatever owns the folder.
      if (error) shell.openPath(path)
    })
  })
  ipcMain.handle(IPC.appPickDir, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: homedir(),
      buttonLabel: 'Open agent here',
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}

// Someone tried to launch a second Torc. They wanted the one they already have,
// so raise it rather than leaving the click looking like it did nothing.
app.on('second-instance', () => windows.raise())

app.whenReady().then(() => {
  // We lost the lock and app.quit() is already pending. Returning before the
  // monitor starts is the point: the loser must not bind a hook bridge port,
  // rewrite the shim, or open a window that would save its layout over the
  // instance that actually owns it.
  if (!hasInstanceLock) return

  // In dev the process is Electron's own signed bundle, so macOS takes the menu
  // bar title and dock icon from *its* Info.plist. Setting the dock icon
  // explicitly is the part we can fix without touching a signed bundle; the
  // menu bar reads "Torc" only in packaged builds (`npm run dist`).
  if (process.platform === 'darwin' && !app.isPackaged) {
    try {
      app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
    } catch {
      // Missing icon (never ran `npm run icon`) — not worth failing startup.
    }
  }
  // Warm the login-shell environment now so the first pane opens instantly.
  void resolveUserEnv()
  buildMenu()
  registerIpc()

  // Start the hook bridge before any pane can spawn, so every agent gets a live
  // $TORC_HOOK_URL and a settings file to report through.
  monitor
    .start()
    .then(async () => {
      const settingsPath = writeHooksSettings()
      sessions.configureAgents({
        settingsPath,
        hookUrl: monitor.hookUrl,
        shimDir: await writeClaudeShim(settingsPath),
      })
    })
    .catch((error) => console.error('torc: fleet monitor failed to start', error))

  createFirstWindow()

  app.on('activate', () => {
    // Clicking the dock icon with every window closed. There is nothing left to
    // restore — closing a window closed its panes — so this is a fresh one.
    if (windows.count() === 0) windows.create({ seed: 'shell' })
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  monitor.stop()
  sessions.disposeAll()
})

// `before-quit` does not fire when the dev runner is killed with a signal, which
// left orphaned `claude` processes running after every restart.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    quitting = true
    sessions.disposeAll()
    app.quit()
    process.exit(0)
  })
}
