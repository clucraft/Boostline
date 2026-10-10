// The core uses Node's Buffer as a global (as it does in Electron's main process).
import { Buffer } from 'buffer'

const g = globalThis as unknown as { Buffer?: typeof Buffer }
g.Buffer ??= Buffer
