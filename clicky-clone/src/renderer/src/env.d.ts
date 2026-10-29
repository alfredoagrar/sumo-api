/// <reference types="vite/client" />
import type { BuddyApi } from '../../shared/types'

declare global {
  interface Window {
    buddy: BuddyApi
  }
}

export {}
