import { useStore } from '../state/store'
import { THEME_IDS, THEMES, THEME_LIST } from '../themes'

export interface Command {
  id: string
  title: string
  subtitle?: string
  group: string
  keywords?: string[]
  /** Shown right-aligned, e.g. ⌘T. Display only — accelerators live in the menu. */
  hint?: string
  run(): void | Promise<void>
}

/**
 * Order the palette shows groups in when there's no query. Appearance sits near
 * the top because flipping themes is a thing you do constantly and want to be
 * able to arrow through without typing.
 */
export const GROUP_ORDER = ['Go', 'Agents', 'Appearance', 'Session', 'Navigate', 'View'] as const

/**
 * Commands are rebuilt each time the palette opens so they can reflect current
 * state, and they read actions via getState() at run time rather than closing
 * over a stale snapshot.
 */
export function buildCommands(): Command[] {
  const commands: Command[] = [
    {
      id: 'session.new-terminal',
      title: 'New terminal',
      subtitle: 'A login shell — run claude, git, anything',
      group: 'Session',
      keywords: ['shell', 'zsh', 'bash', 'console'],
      hint: '⌘T',
      run: () => useStore.getState().newSession({ kind: 'shell' }),
    },
    {
      id: 'session.new-agent',
      title: 'New agent',
      subtitle: 'Skips the shell and starts Claude Code directly',
      group: 'Session',
      keywords: ['claude', 'spawn', 'start'],
      hint: '⇧⌘T',
      run: () => useStore.getState().newSession({ kind: 'claude' }),
    },
    {
      id: 'session.new-agent-in',
      title: 'New agent in folder…',
      subtitle: 'Pick a repo, then launch Claude Code there',
      group: 'Session',
      keywords: ['open', 'directory', 'repo', 'project'],
      run: async () => {
        const cwd = await window.torc.pickDirectory()
        if (cwd) await useStore.getState().newSession({ kind: 'claude', cwd })
      },
    },
    {
      id: 'session.new-terminal-in',
      title: 'New terminal in folder…',
      group: 'Session',
      keywords: ['shell', 'directory', 'repo', 'cd'],
      run: async () => {
        const cwd = await window.torc.pickDirectory()
        if (cwd) await useStore.getState().newSession({ kind: 'shell', cwd })
      },
    },
    {
      id: 'session.new-agent-worktree',
      title: 'New agent in a git worktree',
      subtitle: 'Isolated checkout so parallel agents cannot collide',
      group: 'Session',
      keywords: ['branch', 'isolate', 'parallel'],
      run: () => useStore.getState().newSession({ kind: 'claude', worktree: true }),
    },
    {
      id: 'session.new-agent-plan',
      title: 'New agent in plan mode',
      subtitle: 'Starts with --permission-mode plan',
      group: 'Session',
      keywords: ['planning', 'readonly', 'safe'],
      run: () => useStore.getState().newSession({ kind: 'claude', permissionMode: 'plan' }),
    },
    {
      id: 'session.restart',
      title: 'Restart pane',
      subtitle: 'Agents come back with their conversation intact',
      group: 'Session',
      keywords: ['reload', 'resume', 'respawn'],
      hint: '⇧⌘R',
      run: () => useStore.getState().restartPane(),
    },
    {
      id: 'session.close',
      title: 'Close pane',
      group: 'Session',
      keywords: ['kill', 'quit', 'stop'],
      hint: '⌘W',
      run: () => useStore.getState().closePane(),
    },
    {
      id: 'nav.back',
      title: 'Jump back',
      subtitle: 'The pane you were just in',
      group: 'Navigate',
      keywords: ['previous', 'last', 'toggle', 'recent'],
      hint: '⌃⇥',
      run: () => useStore.getState().jumpBack(),
    },
    {
      id: 'nav.attention',
      title: 'Next agent needing you',
      subtitle: 'Walks the queue of blocked and unread agents',
      group: 'Navigate',
      keywords: ['blocked', 'waiting', 'attention', 'permission'],
      hint: '⇧⌘A',
      run: () => useStore.getState().focusNextAttention(),
    },
    {
      id: 'nav.find',
      title: 'Find in terminal',
      group: 'Navigate',
      keywords: ['search', 'grep', 'scrollback'],
      hint: '⌘F',
      run: () => useStore.getState().setFind(true),
    },
    {
      id: 'nav.next',
      title: 'Next agent',
      group: 'Navigate',
      keywords: ['tab', 'switch', 'right'],
      hint: '⇧⌘]',
      run: () => useStore.getState().cyclePane(1),
    },
    {
      id: 'nav.prev',
      title: 'Previous agent',
      group: 'Navigate',
      keywords: ['tab', 'switch', 'left'],
      hint: '⇧⌘[',
      run: () => useStore.getState().cyclePane(-1),
    },
    {
      id: 'view.grid-2',
      title: 'Two panes side by side',
      subtitle: 'Watch a second agent while the first works',
      group: 'View',
      keywords: ['split', 'grid', 'layout', 'side'],
      hint: '⌥⌘2',
      run: () => useStore.getState().setGridSize(2),
    },
    {
      id: 'view.grid-4',
      title: 'Four panes',
      group: 'View',
      keywords: ['split', 'grid', 'layout', 'quad'],
      hint: '⌥⌘4',
      run: () => useStore.getState().setGridSize(4),
    },
    {
      id: 'view.grid-1',
      title: 'Single pane',
      group: 'View',
      keywords: ['split', 'grid', 'layout', 'full'],
      hint: '⌥⌘1',
      run: () => useStore.getState().setGridSize(1),
    },
    {
      id: 'session.open-editor',
      title: 'Open this folder in VS Code',
      group: 'Session',
      keywords: ['edit', 'code', 'cursor'],
      run: () => {
        const { panes, activeId } = useStore.getState()
        const pane = panes.find((p) => p.id === activeId)
        if (pane) window.torc.openIn(pane.cwd, 'editor')
      },
    },
    {
      id: 'session.open-finder',
      title: 'Reveal this folder in Finder',
      group: 'Session',
      keywords: ['finder', 'reveal', 'folder'],
      run: () => {
        const { panes, activeId } = useStore.getState()
        const pane = panes.find((p) => p.id === activeId)
        if (pane) window.torc.openIn(pane.cwd, 'finder')
      },
    },
    {
      id: 'view.mission',
      title: 'Mission Control',
      subtitle: 'See every agent at once',
      group: 'View',
      keywords: ['dashboard', 'overview', 'grid', 'monitor'],
      hint: '⌘⏎',
      run: () => {
        const { view, setView } = useStore.getState()
        setView(view === 'mission' ? 'workspace' : 'mission')
      },
    },
    {
      id: 'theme.cycle',
      title: 'Cycle theme',
      // Derived, so renaming a theme can't leave a stale label here.
      subtitle: THEME_IDS.map((id) => THEMES[id].label).join(' → '),
      group: 'Appearance',
      keywords: ['next', 'toggle', 'switch', 'color'],
      hint: '⌥⌘T',
      run: () => useStore.getState().cycleTheme(),
    },
  ]

  for (const theme of THEME_LIST) {
    commands.push({
      id: `theme.${theme.id}`,
      title: `Theme: ${theme.label}`,
      subtitle: theme.hint,
      group: 'Appearance',
      keywords: ['color', 'colour', 'appearance', 'dark', 'light'],
      run: () => useStore.getState().setTheme(theme.id),
    })
  }

  return commands
}
