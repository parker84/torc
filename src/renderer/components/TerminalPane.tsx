import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import type { SessionSnapshot } from '@shared/types'
import { THEMES } from '../themes'
import { useStore } from '../state/store'
import { attachWriter } from '../term/bus'
import { registerSearch, unregisterSearch } from '../term/search'

/*
 * Wheel scroll multipliers. Mapping wheel pixels to rows 1:1 is faithful and
 * reads as sluggish — a terminal row is ~16px, so the flick that carries you
 * down a document moves a handful of dense lines here. These are what xterm's
 * own `scrollSensitivity` and `fastScrollSensitivity` would do for us if owning
 * the wheel (see onWheel) hadn't put its options out of reach. Tune freely;
 * they're a matter of taste, not correctness.
 */
const SCROLL_SENSITIVITY = 5
/** ⌥ held — a coarse pass through a long scrollback. xterm's own modifier too. */
const FAST_SCROLL_SENSITIVITY = 15

/**
 * Fraction of the gesture's velocity kept per ~16ms frame while coasting. About
 * three quarters of a second of glide. Set to 0 to disable inertia entirely.
 */
const INERTIA_DECAY = 0.93
/** Silence after the last wheel event that counts as the gesture having ended. */
const GESTURE_END_MS = 50

interface Props {
  pane: SessionSnapshot
  /** Holds keyboard focus. Exactly one pane at a time. */
  active: boolean
  /** On screen. With splits, several panes are visible but only one is active. */
  visible: boolean
}

export function TerminalPane({ pane, active, visible }: Props) {
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
      /*
       * Rows are the currency an agent's UI spends. Claude Code sizes its
       * composer as a share of the terminal's rows and scrolls it internally
       * once it runs out, so a tall line height doesn't just look airy — it
       * clips a long paste. 1.2 is close to what Warp and iTerm ship and buys
       * back about one line in nine.
       */
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10_000,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: THEMES[useStore.getState().theme].terminal,
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)))
    term.open(host)
    registerSearch(pane.id, search)

    // WebGL keeps many panes cheap, but it can fail on some GPUs and its
    // context can be lost — fall back rather than showing a dead pane.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // DOM renderer is the fallback; nothing to do.
    }

    term.attachCustomKeyEventHandler((event) => {
      /*
       * ⌘-chords belong to the app, not the pty. Without this xterm consumes ⌘⏎ —
       * it looks like a plain Enter to the terminal — so Mission Control could
       * never be toggled from inside a focused agent. Returning false makes xterm
       * ignore the event entirely so it bubbles to the window handler.
       *
       * Only the Cmd modifier: Ctrl combos (⌃C to interrupt) and Alt combos must
       * still reach the agent.
       */
      if (event.metaKey) return false

      /*
       * ⇧⏎ is a newline, not a submit. Two separate things are needed for that.
       *
       * The byte is LF, not CR. A bare CR is exactly what plain ⏎ sends, so no
       * REPL can tell the two apart — Claude Code submitted the prompt. LF is
       * the byte behind its own ⌃J newline binding, so it inserts a line break.
       *
       * And every phase of the key has to be swallowed, not just keydown.
       * xterm checks `_keyDownHandled` at the top of its keypress path, but our
       * returning false from keydown means it never got set — so xterm went on
       * to send its own bare CR from keypress and submitted anyway, right after
       * we'd written the newline.
       */
      if (event.key === 'Enter' && event.shiftKey && !event.altKey && !event.ctrlKey) {
        if (event.type === 'keydown') window.torc.sessions.write(pane.id, '\n')
        return false
      }

      return true
    })

    termRef.current = term
    fitRef.current = fit

    // Dev-only handle, like the store's own in state/store.ts: pane behaviour
    // (scrollback, buffer state) can only be asserted from the Terminal itself.
    if (import.meta.env.DEV || window.torc.qaEnabled) {
      ;(host as unknown as { __term: Terminal }).__term = term
    }

    const detach = attachWriter(pane.id, (chunk) => term.write(chunk))
    const keystrokes = term.onData((data) => {
      // Typing jumps the view back to the bottom (xterm's scrollOnUserInput), so
      // a fling still in flight would be fighting it.
      stopFling()
      window.torc.sessions.write(pane.id, data)
    })

    // One row's height in pixels, which the wheel handler below needs on every
    // event. Measured rather than derived from fontSize × lineHeight because the
    // renderer rounds, and cached because a trackpad fires at ~120Hz per pane and
    // a DOM query per event is pure waste. Re-measured whenever the layout moves.
    let rowHeight = 17
    const measureRow = () => {
      const screen = host.querySelector<HTMLElement>('.xterm-screen')
      // Falls back to the initial guess while a pane is still being laid out and
      // the screen has no height to divide up yet.
      if (screen && term.rows > 0 && screen.clientHeight > 0) {
        rowHeight = screen.clientHeight / term.rows
      }
    }

    const syncSize = () => {
      try {
        fit.fit()
      } catch {
        return
      }
      measureRow()
      window.torc.sessions.resize(pane.id, term.cols, term.rows)
    }

    syncSize()
    const observer = new ResizeObserver(syncSize)
    observer.observe(host)

    /*
     * Wheel scrolling, handled here rather than left to xterm. xterm forwards
     * the wheel to the program as mouse events the moment that program turns on
     * mouse reporting — which Claude Code does — so scrollback was unreachable
     * in exactly the panes you most want to scroll back through.
     *
     * Only in the normal buffer: a full-screen program (vim, less, htop) draws
     * its own view in the alternate buffer, and there the wheel belongs to it.
     * Capture phase plus stopPropagation so xterm's own handler never also runs
     * and double-scrolls.
     */
    let pixels = 0
    /**
     * Moves the view by a pixel delta. The buffer only scrolls in whole rows, so
     * the sub-row remainder is carried: a trackpad sends deltas far smaller than
     * a row, and dropping them would make slow scrolling do nothing at all.
     */
    const scrollByPixels = (delta: number): void => {
      pixels += delta
      const lines = Math.trunc(pixels / rowHeight)
      if (lines === 0) return
      pixels -= lines * rowHeight
      term.scrollLines(lines)
    }

    /*
     * Inertia. Calling preventDefault() on every event is what keeps scrollback
     * reachable, and the fling is what it costs: a native scroll view coasts
     * after you lift your finger, and ours stopped dead the instant you did.
     *
     * macOS emits its own momentum events, but only for gestures the compositor
     * owns — and we've taken this one. Rather than guess whether they arrive,
     * this coasts only in the *silence* after the last event, and any wheel event
     * cancels it. So if real momentum does show up it simply takes over, and the
     * two can never compound into a double fling.
     */
    let velocity = 0 // pixels per ms, signed
    let lastWheelAt = 0
    let flingFrame = 0
    let gestureEnd: ReturnType<typeof setTimeout> | undefined

    const stopFling = (): void => {
      if (flingFrame) cancelAnimationFrame(flingFrame)
      flingFrame = 0
    }

    const fling = (previous: number): void => {
      flingFrame = requestAnimationFrame((now) => {
        // Clamped both ways: a dropped frame shouldn't teleport the view, and a
        // zero-length one must not leave the decay a no-op.
        const elapsed = Math.max(1, Math.min(now - previous, 32))
        velocity *= INERTIA_DECAY ** (elapsed / 16)

        // Below half a row per frame there's nothing left to see. Bailing at the
        // ends of the scrollback too, rather than spinning frames against a
        // scrollLines() that can't move.
        const buffer = term.buffer.active
        const stalled =
          Math.abs(velocity) * 16 < rowHeight / 2 ||
          (velocity < 0 && buffer.viewportY === 0) ||
          (velocity > 0 && buffer.viewportY >= buffer.baseY)
        if (stalled) {
          flingFrame = 0
          return
        }

        scrollByPixels(velocity * elapsed)
        fling(now)
      })
    }

    const onWheel = (event: WheelEvent) => {
      if (term.buffer.active.type === 'alternate') return
      event.preventDefault()
      event.stopPropagation()
      stopFling()

      // DOM_DELTA_LINE / DOM_DELTA_PAGE arrive from some mice and from the
      // page-scroll gesture; normalise everything to pixels first.
      const scale = event.deltaMode === 1 ? rowHeight : event.deltaMode === 2 ? term.rows * rowHeight : 1
      const sensitivity = event.altKey ? FAST_SCROLL_SENSITIVITY : SCROLL_SENSITIVITY
      const delta = event.deltaY * scale * sensitivity

      // A remainder carried from the other direction is a dead zone of up to a
      // full row in front of the new one, which is most of what reversing
      // direction feels sticky.
      if ((delta < 0 && pixels > 0) || (delta > 0 && pixels < 0)) pixels = 0

      // Smoothed, so one jittery event can't define the whole fling. `timeStamp`
      // shares performance.now()'s origin, so mixing the two below is safe.
      const elapsed = Math.max(1, Math.min(event.timeStamp - lastWheelAt, 100))
      const instant = delta / elapsed
      velocity = lastWheelAt === 0 ? instant : velocity * 0.7 + instant * 0.3
      lastWheelAt = event.timeStamp

      scrollByPixels(delta)

      if (gestureEnd) clearTimeout(gestureEnd)
      gestureEnd = setTimeout(() => {
        gestureEnd = undefined
        lastWheelAt = 0
        if (term.buffer.active.type !== 'alternate') fling(performance.now())
      }, GESTURE_END_MS)
    }
    host.addEventListener('wheel', onWheel, { capture: true, passive: false })

    return () => {
      observer.disconnect()
      host.removeEventListener('wheel', onWheel, { capture: true })
      stopFling()
      if (gestureEnd) clearTimeout(gestureEnd)
      keystrokes.dispose()
      detach()
      unregisterSearch(pane.id)
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

  // A pane that was hidden, or whose slot changed size, has stale dimensions.
  useEffect(() => {
    if (!visible) return
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
      if (active) term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, visible, pane.id])

  return (
    <div
      // Horizontal breathing room only. Vertical padding here is a whole row of
      // the agent's UI spent on empty space.
      className={`absolute inset-0 bg-bg px-2 ${
        visible ? 'z-10' : 'pointer-events-none invisible z-0'
      }`}
    >
      <div ref={hostRef} className="h-full w-full" />
    </div>
  )
}
