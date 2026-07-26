import type { TorcApi } from '@shared/types'

declare global {
  interface Window {
    torc: TorcApi
    torcMenu: { on(event: string, cb: () => void): () => void }
  }
}
