import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import type { AdapterKind } from '@shared/types'
import type { BoostlineApi } from '@shared/ipc'
import { BoostlineNet } from './plugins'
import { netStats } from './runtime'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * CI launch test (.github/workflows/ios.yml): when the app is started with
 * BOOSTLINE_AUTOCONNECT=<kind>[@host:port] it connects, captures BOOSTLINE_CAPTURE_SECONDS of
 * data and writes the outcome to Documents/smoke.json. With BOOSTLINE_IMPORT_BMW=1 it first
 * downloads and imports the BMW DME data. Does nothing in normal use.
 */
export async function runLaunchTest(api: BoostlineApi): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  const opts = await BoostlineNet.launchOptions().catch(() => ({}) as { autoconnect?: string; captureSeconds?: string; importBmw?: string })
  if (!opts.autoconnect) return
  const result: Record<string, unknown> = { started: new Date().toISOString(), autoconnect: opts.autoconnect }
  try {
    await wait(3000)
    // Screen size in points and which layout is active (tab bar or rail), e.g. for iPhone Duo.
    const rail = document.querySelector('.rail')
    result.viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: window.devicePixelRatio,
      rail: rail ? getComputedStyle(rail).flexDirection : undefined
    }
    // 1. Connect and capture (before importing BMW data, so the fake car's OBD values are logged).
    const [kind, target] = opts.autoconnect.split('@')
    const [host, port] = target ? target.split(':') : []
    const connect = () => api.connect({ kind: kind as AdapterKind, host, port: port ? Number(port) : undefined })
    // Up to three tries, as a user would (a just-booted Simulator can be very slow).
    const attempts: unknown[] = []
    let status = await connect()
    for (let i = 1; i < 3 && status.state === 'error'; i++) {
      attempts.push({ error: status.error, net: { ...netStats } })
      await wait(5000)
      status = await connect()
    }
    result.attempts = attempts
    result.connect = status
    result.channels = (await api.channels()).map((c) => c.id)
    if (status.state === 'error') throw new Error(status.error ?? 'connect failed')
    await wait(2000)
    await api.startRecording()
    await wait(Number(opts.captureSeconds ?? 8) * 1000)
    const file = await api.stopRecording()
    result.file = file
    result.status = await api.status()
    result.net = { ...netStats }
    let rows: string[][] = []
    if (file) {
      const lines = (await api.readFile(file)).text.split('\n')
      result.lines = lines.length
      result.header = lines.find((l) => l.startsWith('Time'))
      result.sample = lines.slice(-3)
      rows = lines.filter((l) => /^\d/.test(l)).map((l) => l.split(','))
    }
    // Engine speed (first channel) must have real values.
    result.rpmValues = rows.filter((r) => Number(r[1]) > 0).length
    const captured = rows.length > 20 && (result.rpmValues as number) > 20
    await api.disconnect()

    // 2. Optionally download and import the BMW DME data through the native plugin.
    let imported = true
    if (opts.importBmw) {
      const t0 = Date.now()
      const off = api.onBmwDataProgress((p) => console.log(`[bmw] ${JSON.stringify(p)}`))
      try {
        const summary = await api.bmwDataDownload()
        result.bmw = {
          source: summary.source,
          dmes: summary.dmes.length,
          measurements: summary.dmes.reduce((n, d) => n + d.measurements, 0),
          seconds: Math.round((Date.now() - t0) / 1000)
        }
        imported = summary.dmes.length >= 10
      } catch (err) {
        result.bmwError = err instanceof Error ? err.message : String(err)
        imported = false
      } finally {
        off()
      }
      // Reconnect so the screenshot shows the app connected with the DME data in use.
      result.reconnect = (await connect()).state
    }
    result.ok = captured && imported
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    result.net = { ...netStats }
    result.ok = false
  }
  await Filesystem.writeFile({ path: 'smoke.json', data: JSON.stringify(result, null, 2), directory: Directory.Documents, encoding: Encoding.UTF8 })
}
