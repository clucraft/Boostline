import { setRuntime } from '@core/runtime'
import { mobileRuntime } from './runtime'
import { createMobileApi } from './api'
import { runLaunchTest } from './smoke'

// On the desktop the preload script exposes window.boostline; here the same API runs in-app.
setRuntime(mobileRuntime)
const api = createMobileApi()
;(window as unknown as { boostline: unknown }).boostline = api
void runLaunchTest(api)
