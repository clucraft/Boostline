// Screenshots of the mobile UI at an exact device size (App Store sets, layout reviews), driven by
// the simulator: Live, live graphs, Dyno, Drag, Analyze and a heatmap. Needs the mobile dev server
// (npm run mobile:dev). Writes .checks/screens/<OUTDIR>/.
//   W=402 H=874 DPR=3 OUTDIR=iphone npx electron scripts/checks/mobile-screens.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const URL = process.argv.find((a) => /^https?:/.test(a)) || 'http://localhost:5199/'
const WORK = path.join(__dirname, '../../.checks')
const OUT = path.join(WORK, 'screens', process.env.OUTDIR || 'screens')
const W = Number(process.env.W || 402)
const H = Number(process.env.H || 874)
const DPR = Number(process.env.DPR || 3)
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const USER = path.join(WORK, 'screens-user')
fs.rmSync(USER, { recursive: true, force: true })
app.setPath('userData', USER)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: Math.min(W, 1200), height: Math.min(H, 900), useContentSize: true, show: true, backgroundColor: '#050505' })
  // Emulation must be set on a loaded page, or Electron crashes.
  await win.loadURL('data:text/html,<body style="background:#050505"></body>')
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true })
  await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await win.loadURL(URL)
  await wait(2500)
  const js = (code) => win.webContents.executeJavaScript(code)
  await js(`window.__vis = (el) => !!el && el.getClientRects().length > 0;
    const s = document.createElement('style'); s.textContent = '.toast-stack{display:none!important}'; document.head.appendChild(s); true`)
  const click = async (text, scope) => {
    const ok = await js(`(() => { const t = ${JSON.stringify(text.toLowerCase())}; const roots = ${scope ? `[...document.querySelectorAll(${JSON.stringify(scope)})].filter(__vis)` : '[document]'}; const b = roots.flatMap(r => [...r.querySelectorAll('button')]).find(b => __vis(b) && !b.disabled && b.textContent.trim().toLowerCase().startsWith(t)); if (!b) return false; b.click(); return true })()`)
    if (!ok) log('  (button not found)', text)
    await wait(300)
    return ok
  }
  const clickSel = async (sel, idx = 0) => {
    const ok = await js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(__vis)[${idx}]; if (!e) return false; e.click(); return true })()`)
    if (!ok) log('  (element not found)', sel)
    await wait(300)
    return ok
  }
  const waitFor = async (expr, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await js(expr).catch(() => false)) return true
      await wait(300)
    }
    log('  timeout', expr)
    return false
  }
  // Captures at the emulated size and pixel ratio (BrowserWindow.capturePage would not).
  const shot = async (name, scrollTo) => {
    if (scrollTo !== undefined) await js(`(() => { const p = [...document.querySelectorAll('.page')].filter(__vis)[0]; if (p) p.scrollTop = ${scrollTo}; })()`)
    await wait(800)
    const { data } = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'))
    log('shot', name)
  }
  const scrollPageTo = (selector, offset) =>
    js(`(() => { const g = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(__vis)[0]; const p = [...document.querySelectorAll('.page')].filter(__vis)[0]; if (g && p) p.scrollTop = Math.max(0, g.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop - ${offset}) })()`)

  try {
    await click('connect · simulator', '.app-header')
    await waitFor(`!!document.querySelector('.app-header .dot.live')`, 10000)
    await wait(6000)
    await shot('1-live', 0)
    await scrollPageTo('.live-page .logviewer', 8)
    await shot('2-live-graphs')
    await click('start capture', '.app-header')
    await wait(500)
    await clickSel('.rail-item[title="Dyno"]')
    await click('arm run')
    await click('i understand', '.modal')
    await waitFor(`[...document.querySelectorAll('.status-line.done')].some(e => e.offsetParent)`, 150000)
    await wait(1000)
    await clickSel('.app-header .pill.rec')
    await wait(1500)
    await shot('3-dyno', 0)
    await clickSel('.rail-item[title="Drag"]')
    await click('arm run')
    await waitFor(`[...document.querySelectorAll('.status-line.done')].some(e => e.offsetParent)`, 150000)
    await wait(1500)
    await shot('4-drag', 0)
    await clickSel('.rail-item[title="Analyze"]')
    await waitFor(`[...document.querySelectorAll('.library-item')].filter(__vis).length >= 1`, 5000)
    await clickSel('.library-item')
    await waitFor(`[...document.querySelectorAll('.log-chip b')].some(e => e.offsetParent)`, 6000)
    await wait(1500)
    await scrollPageTo('.logviewer', 8)
    await shot('5-analyze')
    await click('heatmap', '.logviewer .segmented')
    await wait(1200)
    // The boost preset has data in a short simulator log; the knock map needs per-cylinder timing.
    await js(`(() => { const s = [...document.querySelectorAll('select')].filter(__vis).find(e => [...e.options].some(o => o.value === 'boost')); if (!s) return; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'boost'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await wait(1800)
    await scrollPageTo('.hm-toolbar', 12)
    await shot('6-heatmap')
  } catch (err) {
    log('ERROR', err && err.stack)
  }
  app.exit(0)
})
