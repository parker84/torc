/** Side-effect CSS imports are handled by Vite, not TypeScript. */
declare module '*.css'

interface ImportMeta {
  readonly env: { readonly DEV: boolean; readonly PROD: boolean; readonly MODE: string }
}
