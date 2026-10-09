import type { BoostlineApi } from '../shared/ipc'

declare global {
  interface Window {
    boostline: BoostlineApi
  }
}

export {}
