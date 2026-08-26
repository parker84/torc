import { BrowserWindow, shell } from 'electron'
import { IPC, type SavedState, type WindowInit } from '@shared/types'
import { clearBadge } from './notify'
import { saveState, type SavedWindow } from './store/persist'

/**
 * Every window is its own workspace: it owns its panes, shows nothing else's,
 * and closing it closes them. That isn't a simplification — a second xterm
 * attached to a live pty would open on an empty screen, because a pane's
 * scrollback is built from the data stream as it arrives and main keeps no copy
 * to replay. Partitioning the fleet by window is the only version where both
 * windows show a terminal that reads correctly.
 *
 * Which panes belong to which window is recorded by SessionManager, keyed by the
 * `webContents.id` handed out here — that number is what every IPC event already
 * carries, so routing an update back to its own window costs no extra plumbing.
 */
export interface WindowManagerOptions {
  preload: string
  /** The dev server, when there is one; otherwise the built index.html. */
  devUrl?: string
  rendererFile: string
  /** Renderer console into the dev server log. Off in packaged builds. */
  logConsole: boolean
  /** A closed window's panes belong to nobody, so they go with it. */
  onClosed(windowId: number): void
  /** True once the app is on its way out — see persist() for why it matters. */
  isQuitting(): boolean
}

interface Entry {
  window: BrowserWindow
  init: WindowInit
  /** The last layout this window asked us to remember. */
  layout: SavedWindow
  /** windowInit has been answered once; a reload must not re-seed the window. */
  booted?: boolean
}

export class WindowManager {
  /** Insertion-ordered, which is the order windows are saved and restored in. */
  private entries = new Map<number, Entry>()
  private lastFocusedId?: number
  /** Windows share one theme; whichever saves last states it. */
  private theme?: string

  constructor(private options: WindowManagerOptions) {}

  create(init: Partial<WindowInit> = {}): BrowserWindow {
    const window = new BrowserWindow({
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
        preload: this.options.preload,
        // Required so the bundled ESM preload can load; contextIsolation stays on.
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    const id = window.webContents.id
    const full: WindowInit = {
      theme: init.theme ?? this.theme,
      panes: init.panes ?? [],
      activeIndex: init.activeIndex,
      seed: init.seed,
    }
    this.entries.set(id, {
      window,
      init: full,
      // Seeded from what the window was told to restore, so a window closed
      // before its renderer got round to saving still persists what it held.
      layout: { panes: full.panes, activeIndex: full.activeIndex },
    })

    if (this.options.logConsole) this.logConsole(window)

    window.on('focus', () => {
      this.lastFocusedId = id
      clearBadge()
    })

    window.on('closed', () => {
      this.entries.delete(id)
      if (this.lastFocusedId === id) this.lastFocusedId = undefined
      this.options.onClosed(id)
      // Deliberately not on the way out: quitting closes every window, and
      // treating that as "the user closed them" would erase the layout we exist
      // to restore.
      if (!this.options.isQuitting()) this.persist()
    })

    // Anything that isn't the app itself opens in the real browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    window.on('ready-to-show', () => window.show())

    if (this.options.devUrl) {
      window.loadURL(this.options.devUrl)
    } else {
      window.loadFile(this.options.rendererFile)
    }

    return window
  }

  /**
   * Answered once per renderer. The seed is dropped afterwards so a ⌘R reload
   * doesn't open a second pane the user never asked for.
   */
  initFor(windowId: number): WindowInit {
    const entry = this.entries.get(windowId)
    if (!entry) return { panes: [] }
    const init = entry.init
    if (entry.booted) return { ...init, seed: undefined }
    entry.booted = true
    return init
  }

  /**
   * A theme picked in one window is the app's theme, so every other window
   * catches up at once. Relayed rather than left to localStorage: the windows
   * share it on disk but not in memory, so without this the others stay on the
   * old theme until they are reloaded.
   */
  shareTheme(windowId: number, theme: string): void {
    this.theme = theme
    for (const [id, entry] of this.entries) {
      if (id === windowId || entry.window.isDestroyed()) continue
      entry.window.webContents.send(IPC.themeApply, theme)
    }
  }

  /** A window reporting its layout. Theme is shared; panes are not. */
  remember(windowId: number, state: SavedState): void {
    const entry = this.entries.get(windowId)
    if (!entry) return
    this.theme = state.theme ?? this.theme
    entry.layout = { panes: state.panes, activeIndex: state.activeIndex }
    this.persist()
  }

  get(windowId: number): BrowserWindow | undefined {
    return this.entries.get(windowId)?.window
  }

  /** In creation order. */
  all(): BrowserWindow[] {
    return [...this.entries.values()].map((entry) => entry.window)
  }

  count(): number {
    return this.entries.size
  }

  /**
   * Where a menu command goes. Menu accelerators are app-wide on macOS and can
   * fire with no window focused at all, so the last window to hold focus is the
   * fallback rather than nothing happening.
   */
  focused(): BrowserWindow | undefined {
    const current = BrowserWindow.getFocusedWindow()
    if (current && this.entries.has(current.webContents.id)) return current
    if (this.lastFocusedId !== undefined) {
      const remembered = this.entries.get(this.lastFocusedId)
      if (remembered) return remembered.window
    }
    return this.all().at(-1)
  }

  sendTo(windowId: number | undefined, channel: string, ...args: unknown[]): void {
    if (windowId === undefined) return
    const window = this.entries.get(windowId)?.window
    if (!window || window.isDestroyed()) return
    window.webContents.send(channel, ...args)
  }

  sendToFocused(channel: string, ...args: unknown[]): void {
    const window = this.focused()
    if (!window || window.isDestroyed()) return
    window.webContents.send(channel, ...args)
  }

  /** Someone tried to launch a second Torc; they wanted the one they have. */
  raise(): void {
    const window = this.focused()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  private persist(): void {
    saveState({
      theme: this.theme,
      windows: [...this.entries.values()].map((entry) => entry.layout),
    })
  }

  private logConsole(window: BrowserWindow): void {
    // Without this, a failure inside the renderer is invisible unless devtools
    // happen to be open.
    window.webContents.on('console-message', (...args: unknown[]) => {
      // Electron changed this signature; accept both shapes.
      const details = args[1]
      if (details && typeof details === 'object' && 'message' in details) {
        const d = details as { level?: string; message: string; lineNumber?: number }
        console.log(`[renderer:${d.level ?? 'log'}] ${d.message}`)
      } else {
        console.log(`[renderer] ${String(args[2] ?? details)}`)
      }
    })
  }
}
