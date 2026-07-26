import { useStore } from '../state/store'
import { THEME_LIST } from '../themes'

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
export const GROUP_ORDER = ['Agents', 'Appearance', 'Session', 'Navigate', 'View'] as const

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
      subtitle: 'Claude Code in the current folder',
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
      id: 'view.mission',
      title: 'Mission Control',
      subtitle: 'See every agent at once',
      group: 'View',
      keywords: ['dashboard', 'overview', 'grid', 'monitor'],
      hint: '⌘0',
      run: () => {
        const { view, setView } = useStore.getState()
        setView(view === 'mission' ? 'workspace' : 'mission')
      },
    },
    {
      id: 'theme.cycle',
      title: 'Cycle theme',
      subtitle: 'Notion → Synthwave → Matrix',
      group: 'Appearance',
      keywords: ['next', 'toggle', 'switch', 'color'],
      hint: '⌃⌘T',
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
