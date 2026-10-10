// The mobile runtime's TCP socket (src/mobile/runtime.ts) driven through a stand-in for the
// native BoostlineNet plugin that is backed by real Node sockets, so the shared protocol code
// runs exactly as in the iOS app, against the fake gateway.
import net from 'node:net'
import { CH } from '@shared/types'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setRuntime } from '../src/core/runtime'
import { EnetAdapter } from '../src/core/vehicle/enet'
import { probeTcpPort } from '../src/core/vehicle/discovery'
import { nodeRuntime } from '../src/main/nodeRuntime'
import { FakeGateway } from './fakeGateway'

type Listener = (e: Record<string, string>) => void
const listeners = new Map<string, Listener[]>()
const sockets = new Map<string, net.Socket>()
let nextId = 0
/** Native → JS events are asynchronous, as over the Capacitor bridge. */
const notify = (event: string, data: Record<string, string>): void =>
  void setImmediate(() => (listeners.get(event) ?? []).forEach((l) => l(data)))

const fakeNative = {
  tcpConnect: ({ host, port }: { host: string; port: number }) =>
    new Promise<{ id: string }>((resolve, reject) => {
      const socket = net.createConnection({ host, port })
      const id = String(++nextId)
      socket.once('connect', () => {
        sockets.set(id, socket)
        socket.on('data', (chunk) => notify('tcpData', { id, data: chunk.toString('base64') }))
        socket.on('close', () => {
          if (sockets.delete(id)) notify('tcpClose', { id })
        })
        socket.on('error', (err: NodeJS.ErrnoException) => {
          if (sockets.delete(id)) notify('tcpClose', { id, error: err.message, code: err.code ?? '' })
        })
        resolve({ id })
      })
      socket.once('error', (err: NodeJS.ErrnoException) => {
        if (!sockets.has(id)) reject(Object.assign(new Error(`Cannot connect to ${host}:${port}: ${err.message}`), { code: err.code }))
      })
    }),
  tcpWrite: async ({ id, data }: { id: string; data: string }) => {
    const socket = sockets.get(id)
    if (!socket) throw Object.assign(new Error('Socket is closed'), { code: 'EPIPE' })
    socket.write(Buffer.from(data, 'base64'))
  },
  tcpClose: async ({ id }: { id: string }) => {
    const socket = sockets.get(id)
    sockets.delete(id)
    socket?.destroy()
  },
  interfaces: async () => ({ interfaces: [] }),
  addListener: async (event: string, l: Listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), l])
    return { remove: async () => undefined }
  }
}

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
  registerPlugin: () => ({})
}))
vi.mock('@capacitor/filesystem', () => ({ Directory: { Documents: 'DOCUMENTS' }, Encoding: { UTF8: 'utf8' }, Filesystem: {} }))
vi.mock('../src/mobile/plugins', () => ({ BoostlineNet: fakeNative, BoostlineData: {} }))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let gw: FakeGateway | undefined
let adapter: EnetAdapter | undefined

beforeAll(async () => {
  const { mobileRuntime } = await import('../src/mobile/runtime')
  setRuntime(mobileRuntime)
})
afterAll(() => setRuntime(nodeRuntime))
afterEach(async () => {
  await adapter?.disconnect()
  await gw?.close()
  adapter = undefined
  gw = undefined
})

describe('mobile runtime (native TCP bridge)', () => {
  it('connects, identifies the car and streams through the native socket', async () => {
    gw = await FakeGateway.start()
    adapter = new EnetAdapter({ kind: 'mhd-wifi', host: '127.0.0.1', port: gw.port })
    const info = await adapter.connect()
    expect(info.vin).toBe('WBATEST0000000001')
    const ids = [CH.rpm, CH.speed]
    const frames: number[][] = []
    const errors: Error[] = []
    const handle = await adapter.startStreaming(ids, (f) => frames.push(f.values), { onError: (e) => errors.push(e) })
    await sleep(500)
    await handle.stop()
    expect(errors).toEqual([])
    expect(frames.length).toBeGreaterThan(5)
    expect(frames.every((v) => Number.isFinite(v[0]) && v[0] > 0)).toBe(true)
  })

  it('reports a lost connection while streaming', async () => {
    gw = await FakeGateway.start()
    adapter = new EnetAdapter({ kind: 'mhd-wifi', host: '127.0.0.1', port: gw.port })
    await adapter.connect()
    const errors: Error[] = []
    const handle = await adapter.startStreaming([CH.rpm], () => undefined, { onError: (e) => errors.push(e) })
    await sleep(150)
    gw.dropConnections()
    for (let i = 0; i < 40 && errors.length === 0; i++) await sleep(25)
    await handle.stop()
    expect(errors.map((e) => e.message).join(' ')).toMatch(/lost/)
  })

  it('fails cleanly when nothing listens', async () => {
    const server = net.createServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    await new Promise<void>((r) => server.close(() => r()))
    adapter = new EnetAdapter({ kind: 'mhd-wifi', host: '127.0.0.1', port })
    await expect(adapter.connect()).rejects.toThrow(/Cannot connect to 127\.0\.0\.1/)
    const probe = await probeTcpPort('127.0.0.1', port, 800)
    expect(probe).toMatchObject({ open: false, error: 'ECONNREFUSED' })
  })
})
