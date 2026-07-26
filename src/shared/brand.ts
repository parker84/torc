/**
 * The product name lives here and nowhere else, so renaming is a one-line change.
 * `id` is used for on-disk paths (~/.torc), env vars (TORC_*) and the app id.
 */
export const BRAND = {
  name: 'Torc',
  id: 'torc',
  tagline: 'A fleet console for CLI coding agents',
  appId: 'dev.torc.app',
} as const

/** Env var name for the hook bridge URL handed to each agent (M1). */
export const HOOK_URL_ENV = `${BRAND.id.toUpperCase()}_HOOK_URL`
