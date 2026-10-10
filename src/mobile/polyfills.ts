// The core uses Node's Buffer as a global (as it does in Electron's main process).
import { Buffer } from 'buffer'

const g = globalThis as unknown as { Buffer?: typeof Buffer; structuredClone?: <T>(v: T) => T }
g.Buffer ??= Buffer

// Safari before 15.4 (iOS 15.0–15.3) lacks these.
if (!Object.hasOwn) {
  Object.defineProperty(Object, 'hasOwn', {
    value: (obj: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(obj, key),
    configurable: true,
    writable: true
  })
}
if (!Array.prototype.at) {
  Object.defineProperty(Array.prototype, 'at', {
    value: function at<T>(this: T[], index: number): T | undefined {
      const i = Math.trunc(index) || 0
      return this[i < 0 ? this.length + i : i]
    },
    configurable: true,
    writable: true
  })
}
// Only used for plain JSON data (settings, presets).
g.structuredClone ??= <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
