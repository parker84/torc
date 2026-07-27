import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { BRAND } from '@shared/brand'
import { IPC, type SessionSpec } from '@shared/types'
import { SessionManager } from './pty/SessionManager'
import { FleetMonitor } from './fleet/monitor'
import { writeHooksSettings } from './fleet/hooksSettings'
import { writeClaudeShim } from './fleet/claudeShim'
import { resolveUserEnv } from './env'
import { clearBadge, updateAttention } from './notify'
import { loadState, saveState } from './store/persist'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Must happen before `ready`: the appMenu role reads app.name when it builds,
// and in dev the bundle would otherwise report itself as "Electron".
app.setName(BRAND.name)

/**
 * Where a new agent goes when there's no better answer. `process.cwd()` is the
 * repo you ran `npm run dev` from, which is almost always what you want; in a
 * packaged app it's "/" so fall back to the home directory.
 */
const launchCwd = process.cwd() === '/' ? homedir() : process.cwd()

let mainWindow: BrowserWindow | null = null

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

const sessions = new SessionManager({
  onData: (id, chunk) => send(IPC.sessionData, id, chunk),
  onExit: (id, exitCode) => send(IPC.sessionExit, id, exitCode),
  onUpdate: (snapshot) => {
    send(IPC.sessionUpdate, snapshot)
    updateAttention(sessions.list(), mainWindow, (paneId) => send(IPC.focusPane, paneId))
  },
  onCreated: (snapshot) => monitor.track(snapshot),
  onClosed: (id) => monitor.untrack(id),
})

const monitor = new FleetMonitor(sessions)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
    // Frameless-with-traffic-lights: the pane grid reads as one surface.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // Required so the bundled ESM preload can load; contextIsolation stays on.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Renderer console into the dev server log — without this, a failure inside
  // the renderer is invisible unless devtools happen to be open.
  if (!app.isPackaged) {
    mainWindow.webContents.on(
      'console-message',
      (...args: unknown[]) => {
        // Electron changed this signature; accept both shapes.
        const details = args[1]
        if (details && typeof details === 'object' && 'message' in details) {
          const d = details as { level?: string; message: string; lineNumber?: number }
          console.log(`[renderer:${d.level ?? 'log'}] ${d.message}`)
        } else {
          console.log(`[renderer] ${String(args[2] ?? details)}`)
        }
      },
    )
  }

  mainWindow.on('focus', clearBadge)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()

    if (process.env.TORC_DEMO && mainWindow) {
      const win = mainWindow
      void import('./demo').then(({ runDemo }) =>
        runDemo(win, process.env.TORC_DEMO!).then(() => {
          if (process.env.TORC_QA_EXIT) {
            sessions.disposeAll()
            app.quit()
          }
        }),
      )
      return
    }

    if (process.env.TORC_QA && mainWindow) {
      const win = mainWindow
      void import('./qa').then(({ runQa }) =>
        runQa(win, process.env.TORC_QA!).then(() => {
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

  // Anything that isn't the app itself opens in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
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
            // (⌘0 still works as an alias, and esc leaves the overview —
            // both handled in the renderer. Not ⇧⌘M: ⌘M is minimize.)
            accelerator: 'CmdOrCtrl+Return',
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
            accelerator: 'Control+CmdOrCtrl+T',
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
        ],
      },
    ]),
  )
}

function registerIpc(): void {
  ipcMain.handle(IPC.sessionCreate, (_e, spec: SessionSpec) => sessions.create(spec))
  ipcMain.handle(IPC.sessionList, () => sessions.list())
  ipcMain.handle(IPC.sessionKill, (_e, id: string) => sessions.kill(id))
  ipcMain.on(IPC.sessionWrite, (_e, id: string, data: string) => sessions.write(id, data))
  ipcMain.on(IPC.sessionResize, (_e, id: string, cols: number, rows: number) =>
    sessions.resize(id, cols, rows),
  )
  // Looking at a pane clears its "finished, unread" attention flag.
  ipcMain.on(IPC.sessionMarkRead, (_e, id: string) => monitor.markRead(id))
  ipcMain.handle(IPC.appHome, () => homedir())
  ipcMain.handle(IPC.appDefaultCwd, () => launchCwd)
  ipcMain.handle(IPC.appLoadState, () => loadState())
  ipcMain.on(IPC.appSaveState, (_e, state: Parameters<typeof saveState>[0]) => saveState(state))
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

app.whenReady().then(() => {
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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  monitor.stop()
  sessions.disposeAll()
})

// `before-quit` does not fire when the dev runner is killed with a signal, which
// left orphaned `claude` processes running after every restart.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    sessions.disposeAll()
    app.quit()
    process.exit(0)
  })
}
