import { setRuntime } from '@core/runtime'
import { mobileRuntime } from './runtime'
import { createMobileApi } from './api'

// On the desktop the preload script exposes window.boostline; here the same API runs in-app.
setRuntime(mobileRuntime)
;(window as unknown as { boostline: unknown }).boostline = createMobileApi()
