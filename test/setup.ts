// The core reaches sockets and files through the registered runtime; tests use Node's.
import { setRuntime } from '../src/core/runtime'
import { nodeRuntime } from '../src/main/nodeRuntime'

setRuntime(nodeRuntime)
