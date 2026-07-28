import type { SessionSnapshot } from '@shared/types'
import { useStore } from '../state/store'
import { SLOTS, visibleWindow } from '../layout/panes'
import { TerminalPane } from './TerminalPane'

/**
 * Every terminal stays mounted in one stable parent and is *positioned* by
 * inline style. Moving a pane between DOM parents would unmount xterm and take
 * its scrollback with it, so slots change geometry rather than structure.
 */

export function PaneGrid({ panes }: { panes: SessionSnapshot[] }) {
  const activeId = useStore((s) => s.activeId)
  const gridSize = useStore((s) => s.gridSize)
  const setActive = useStore((s) => s.setActive)

  const activeIndex = panes.findIndex((p) => p.id === activeId)
  const start = visibleWindow(panes.length, activeIndex, gridSize)
  const slots = SLOTS[gridSize]

  return (
    <>
      {panes.map((pane, index) => {
        const slotIndex = index - start
        const slot = slotIndex >= 0 && slotIndex < slots.length ? slots[slotIndex] : undefined
        const isActive = pane.id === activeId

        return (
          <div
            key={pane.id}
            // Hidden panes keep their geometry so a refit on reveal is cheap.
            style={slot ?? SLOTS[1][0]}
            className={`absolute ${slot ? '' : 'pointer-events-none invisible'} ${
              gridSize > 1 && slot ? 'border-line border-r border-b' : ''
            }`}
            onMouseDown={() => {
              if (slot && !isActive) setActive(pane.id)
            }}
          >
            {/* With several panes on screen, the focused one needs to be obvious. */}
            {gridSize > 1 && slot && (
              <div
                className={`pointer-events-none absolute inset-0 z-20 border-2 ${
                  isActive ? 'border-accent/70 neon' : 'border-transparent'
                }`}
              />
            )}
            {gridSize > 1 && slot && (
              <div className="pointer-events-none absolute top-1 right-2 z-20 font-mono text-[10px] text-muted opacity-70">
                {pane.title}
              </div>
            )}
            <TerminalPane pane={pane} active={isActive} visible={Boolean(slot)} />
          </div>
        )
      })}
    </>
  )
}
