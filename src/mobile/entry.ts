// Evaluated in order: polyfills, then the in-app API, then the shared UI, then the
// phone/tablet styles (last, so they override the desktop styles they adjust).
import './polyfills'
import './install'
import '../renderer/src/main'
import './mobile.css'
