// Renders the App Store product page header (3840×1646) and search results image (3840×2560)
// from header.html and search.html. The search image uses iPhone screens from
// scripts/checks/mobile-screens.cjs, so run that first:
//   W=402 H=874 DPR=3 OUTDIR=hero-iphone npx electron scripts/checks/mobile-screens.cjs
//   npx electron scripts/store-art/render.cjs
// Writes .checks/store-art/: the two images, plus copies with Apple's safe area drawn on them.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const OUT = path.join(__dirname, '../../.checks/store-art')
fs.mkdirSync(OUT, { recursive: true })
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Pages are laid out at half size and captured at a pixel ratio of 2.
const PAGES = [
  { name: 'header', width: 1920, height: 823 },
  { name: 'search', width: 1920, height: 1280 }
]

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 900, show: true, backgroundColor: '#050505' })
  // Emulation must be set on a loaded page, or Electron crashes.
  await win.loadURL('data:text/html,<body style="background:#050505"></body>')
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  try {
    for (const page of PAGES) {
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: page.width, height: page.height, deviceScaleFactor: 2, mobile: false })
      for (const safe of [false, true]) {
        const url = pathToFileURL(path.join(__dirname, `${page.name}.html`)).href + (safe ? '?safe' : '')
        await win.loadURL(url)
        await win.webContents.executeJavaScript(`document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {})))).then(() => true)`)
        await wait(500)
        const { data } = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' })
        const file = path.join(OUT, `${page.name}${safe ? '-safe' : ''}.png`)
        fs.writeFileSync(file, Buffer.from(data, 'base64'))
        console.log('wrote', path.relative(process.cwd(), file))
      }
    }
  } catch (err) {
    console.log('ERROR', err && err.stack)
  }
  app.exit(0)
})
