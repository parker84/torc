import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { SessionSnapshot } from '@shared/types'
import { THEMES } from '../themes'
import { useStore } from '../state/store'
import { attachWriter } from '../term/bus'

interface Props {
  pane: SessionSnapshot
  active: boolean
}

export function TerminalPane({ pane, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const theme = useStore((s) => s.theme)

  // One terminal per pane, created once. Deliberately does not depend on
  // `theme` or `active` — those are handled by the effects below so a theme
  // switch never tears down scrollback.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10_000,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: THEMES[useStore.getState().theme].terminal,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)))
    term.open(host)

    // WebGL keeps many panes cheap, but it can fail on some GPUs and its
    // context can be lost — fall back rather than showing a dead pane.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // DOM renderer is the fallback; nothing to do.
    }

    termRef.current = term
    fitRef.current = fit

    const detach = attachWriter(pane.id, (chunk) => term.write(chunk))
    const keystrokes = term.onData((data) => window.torc.sessions.write(pane.id, data))

    const syncSize = () => {
      try {
        fit.fit()
      } catch {
        return
      }
      window.torc.sessions.resize(pane.id, term.cols, term.rows)
    }

    syncSize()
    const observer = new ResizeObserver(syncSize)
    observer.observe(host)

    return () => {
      observer.disconnect()
      keystrokes.dispose()
      detach()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [pane.id])

  // Repaint on theme change without touching the buffer.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = THEMES[theme].terminal
  }, [theme])

  // A pane that was hidden has stale dimensions; refit and take focus.
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit()
        window.torc.sessions.resize(pane.id, term.cols, term.rows)
      } catch {
        // Pane not laid out yet; the ResizeObserver will catch up.
      }
      term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, pane.id])

  return (
    <div
      className={`absolute inset-0 bg-bg px-2 py-1.5 ${
        active ? 'z-10' : 'pointer-events-none invisible z-0'
      }`}
    >
      <div ref={hostRef} className="h-full w-full" />
    </div>
  )
}
