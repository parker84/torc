import { contextBridge, ipcRenderer } from 'electron'
import { BRAND } from '@shared/brand'
import { IPC, type SessionSnapshot, type SessionSpec, type TorcApi } from '@shared/types'

/**
 * Unsubscribe is handed back as a numeric token rather than a function.
 * Functions returned across contextBridge are proxied, and relying on that
 * proxy to still identify the original listener is fragile — a cleanup that
 * silently fails leaves duplicate listeners behind, which showed up as one
 * ⌘T spawning two agents after a StrictMode remount.
 */
type IpcListener = (event: Electron.IpcRendererEvent, ...args: unknown[]) => void

let nextToken = 1
const listeners = new Map<number, { channel: string; listener: IpcListener }>()

function register<T extends unknown[]>(channel: string, cb: (...args: T) => void): number {
  const token = nextToken++
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  listeners.set(token, { channel, listener })
  return token
}

function unregister(token: number): void {
  const entry = listeners.get(token)
  if (!entry) return
  ipcRenderer.removeListener(entry.channel, entry.listener)
  listeners.delete(token)
}

/** Wraps register/unregister so callers still get a tidy unsubscribe closure. */
function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const token = register(channel, cb)
  return () => unregister(token)
}

const api: TorcApi = {
  brand: { name: BRAND.name, id: BRAND.id, tagline: BRAND.tagline },
  platform: process.platform,
  /** Dev-only override so QA can boot straight into a given theme. */
  devTheme: process.env.TORC_THEME,
  /** True when a harness is driving, including in a packaged build. */
  qaEnabled: Boolean(process.env.TORC_QA || process.env.TORC_DEMO),
  sessions: {
    create: (spec: SessionSpec) => ipcRenderer.invoke(IPC.sessionCreate, spec),
    write: (id, data) => ipcRenderer.send(IPC.sessionWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.sessionResize, id, cols, rows),
    kill: (id) => ipcRenderer.invoke(IPC.sessionKill, id),
    list: () => ipcRenderer.invoke(IPC.sessionList),
    markRead: (id) => ipcRenderer.send(IPC.sessionMarkRead, id),
  },
  home: () => ipcRenderer.invoke(IPC.appHome),
  defaultCwd: () => ipcRenderer.invoke(IPC.appDefaultCwd),
  pickDirectory: () => ipcRenderer.invoke(IPC.appPickDir),
  loadState: () => ipcRenderer.invoke(IPC.appLoadState),
  saveState: (state) => ipcRenderer.send(IPC.appSaveState, state),
  openIn: (path, target) => ipcRenderer.send(IPC.appOpenIn, path, target),
  onFocusPane: (cb) => subscribe<[string]>(IPC.focusPane, cb),
  onData: (cb) => subscribe<[string, string]>(IPC.sessionData, cb),
  onExit: (cb) => subscribe<[string, number]>(IPC.sessionExit, cb),
  onUpdate: (cb) => subscribe<[SessionSnapshot]>(IPC.sessionUpdate, cb),
}

contextBridge.exposeInMainWorld(BRAND.id, api)

/** Menu accelerators are owned by main; the renderer just listens. */
contextBridge.exposeInMainWorld(`${BRAND.id}Menu`, {
  on: (event: string, cb: () => void) => subscribe(`menu:${event}`, cb),
})
