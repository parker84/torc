import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BRAND, HOOK_URL_ENV } from '@shared/brand'

/**
 * Writes the settings file handed to each agent via `claude --settings`, so
 * Torc's hooks apply per session and the user's own ~/.claude/settings.json is
 * never touched.
 *
 * The command is a single curl rather than a script for two reasons: process
 * startup is on the agent's hot path (~5ms vs ~40ms for node), and the
 * `-m 0.3 … || true` shape guarantees a slow or dead Torc can never hang or
 * fail the agent's tool call.
 */
const EVENTS_WITH_MATCHER = ['PreToolUse', 'PostToolUse'] as const
const EVENTS_PLAIN = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
] as const

export function hookCommand(): string {
  return (
    `curl -s -m 0.3 -X POST -H 'content-type: application/json' ` +
    `--data-binary @- "$${HOOK_URL_ENV}" >/dev/null 2>&1 || true`
  )
}

export function buildHooksSettings(): Record<string, unknown> {
  const command = hookCommand()
  const entry = { hooks: [{ type: 'command', command }] }
  const hooks: Record<string, unknown[]> = {}

  for (const event of EVENTS_WITH_MATCHER) hooks[event] = [{ matcher: '*', ...entry }]
  for (const event of EVENTS_PLAIN) hooks[event] = [entry]

  return { hooks }
}

export function settingsDir(): string {
  return join(homedir(), `.${BRAND.id}`)
}

/** Returns the path to pass to `claude --settings`. */
export function writeHooksSettings(): string {
  const dir = settingsDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'hooks.settings.json')
  writeFileSync(path, `${JSON.stringify(buildHooksSettings(), null, 2)}\n`)
  return path
}
