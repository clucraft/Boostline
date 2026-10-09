import { app, BrowserWindow, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { registerIpc } from './ipc'
import { Session } from './session'

const isMac = process.platform === 'darwin'

let mainWindow: BrowserWindow | null = null
const session = new Session()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    // Windows/Linux: frameless with Boostline's own window buttons. macOS: hidden title
    // bar with the native traffic lights inset into Boostline's top bar.
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 22 } } : { frame: false }),
    show: false,
    backgroundColor: '#070b10',
    title: 'Boostline',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep the dyno / drag detectors and live graphs running at full rate
      // while the window is in the background during a logging session.
      backgroundThrottling: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  const sendMax = (): void => mainWindow?.webContents.send(IPC.evMaximized, mainWindow.isMaximized())
  mainWindow.on('maximize', sendMax)
  mainWindow.on('unmaximize', sendMax)
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // External links open in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.BOOSTLINE_SMOKE_TEST) smokeTest(mainWindow, process.env.BOOSTLINE_SMOKE_TEST)

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

/**
 * CI launch check for packaged builds: waits for the UI to render, writes a JSON
 * result to the given file and exits (0 = the app started and rendered).
 */
function smokeTest(win: BrowserWindow, resultFile: string): void {
  const finish = (ok: boolean, detail: Record<string, unknown>): void => {
    writeFileSync(resultFile, JSON.stringify({ ok, platform: process.platform, arch: process.arch, version: app.getVersion(), ...detail }))
    app.exit(ok ? 0 : 1)
  }
  const timeout = setTimeout(() => finish(false, { error: 'UI did not render within 30 s' }), 30_000)
  win.webContents.once('did-finish-load', async () => {
    for (let i = 0; i < 100; i++) {
      const ui = (await win.webContents.executeJavaScript(
        `({ titlebar: !!document.querySelector('.titlebar'), tabs: document.querySelectorAll('.nav button').length, platform: window.boostline?.platform })`
      )) as { titlebar: boolean; tabs: number; platform?: string }
      if (ui.titlebar && ui.tabs === 4) {
        clearTimeout(timeout)
        finish(ui.platform === process.platform, { ui })
        return
      }
      await new Promise((r) => setTimeout(r, 200))
    }
  })
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('app.boostline.logger')
  registerIpc(session, () => mainWindow)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void session.disconnect().finally(() => {
    if (!isMac) app.quit()
  })
})
