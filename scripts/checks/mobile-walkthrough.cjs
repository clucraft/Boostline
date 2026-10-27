// Walks through the mobile UI in a phone- or tablet-sized, touch-emulating window, driven by the
// simulator: checks the layout (tab bar or rail, no sideways overflow) and every screen works,
// with screenshots in .checks/<OUTDIR>/. Needs the mobile dev server (npm run mobile:dev).
//   W=390 H=844 OUTDIR=phone npx electron scripts/checks/mobile-walkthrough.cjs [url]
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const URL = process.argv.find((a) => /^https?:/.test(a)) || 'http://localhost:5199/'
const WORK = path.join(__dirname, '../../.checks')
const OUT = path.join(WORK, process.env.OUTDIR || 'mobile')
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
fs.rmSync(path.join(WORK, 'mobile-user'), { recursive: true, force: true })
app.setPath('userData', path.join(WORK, 'mobile-user'))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
const W = Number(process.env.W || 390)
const H = Number(process.env.H || 844)
const T0 = Date.now()
const log = (...a) => {
  const line = `${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s ${a.join(' ')}`
  console.log(line)
  fs.appendFileSync(path.join(OUT, 'run.log'), line + '\n')
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  log(ok ? 'PASS' : 'FAIL', name, detail ? `· ${String(detail).slice(0, 160)}` : '')
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: true, backgroundColor: '#050505' })
  const errors = []
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') {
      errors.push(e.message)
      log('[console error]', e.message)
    }
  })
  await win.loadURL('data:text/html,<body style="background:#050505"></body>')
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true })
  await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await dbg.sendCommand('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' })
  await win.loadURL(URL)
  await wait(2500)
  const js = (code) => win.webContents.executeJavaScript(code)
  await js(`window.__vis = (el) => !!el && el.getClientRects().length > 0; true`)
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
  const shot = async (name, scrollTo) => {
    if (scrollTo !== undefined) await js(`(() => { const p = [...document.querySelectorAll('.page')].filter(__vis)[0]; if (p) p.scrollTop = ${scrollTo}; })()`)
    await wait(600)
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG())
    log('shot', name)
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
  const overflow = () =>
    js(`(() => { const w = document.documentElement.clientWidth; return [...document.querySelectorAll('body *')].filter(e => __vis(e) && !e.closest('.hm-main, .graph-legend, .uplot, .library-list, .palette-list, .chart-tooltip')).filter(e => { const r = e.getBoundingClientRect(); return r.right > w + 1 && r.width > 0 }).slice(0, 5).map(e => e.className + ' ' + Math.round(e.getBoundingClientRect().right)) })()`)

  try {
    check('hover: none (touch emulation)', await js(`matchMedia('(hover: none)').matches`))
    if (W <= 760 && H > W) check('bottom tab bar', await js(`getComputedStyle(document.querySelector('.rail')).flexDirection === 'row'`))
    else check('side rail', await js(`getComputedStyle(document.querySelector('.rail')).flexDirection === 'column'`))
    check('no window buttons', (await js(`document.querySelectorAll('.window-controls button').length`)) === 0)
    await shot('01-live-disconnected')
    check('no horizontal overflow (disconnected)', !(await overflow()).length, (await overflow()).join(' | '))
    await click('connect · simulator', '.app-header')
    check('streaming', await waitFor(`!!document.querySelector('.app-header .dot.live')`, 10000))
    await wait(4000)
    await shot('02-live')
    check('no horizontal overflow (live)', !(await overflow()).length, (await overflow()).join(' | '))
    await shot('03-live-graphs', 900)
    await click('channels', '.page-toolbar')
    await wait(500)
    await shot('04-palette')
    await js(`document.querySelector('.palette-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await click('start capture', '.app-header')
    await wait(800)
    await clickSel('.rail-item[title="Dyno"]')
    await click('arm run')
    check('closed-course notice', await waitFor(`[...document.querySelectorAll('.modal-head')].some(e => /Closed courses only/.test(e.textContent))`, 3000))
    await shot('04b-closed-course')
    await click('i understand', '.modal')
    check('dyno pull captured', await waitFor(`[...document.querySelectorAll('.status-line.done')].some(e => e.offsetParent)`, 150000))
    await wait(1500)
    await shot('05-dyno', 0)
    check('no horizontal overflow (dyno)', !(await overflow()).length, (await overflow()).join(' | '))
    await shot('06-dyno-setup', 700)
    await clickSel('.rail-item[title="Drag"]')
    await click('arm run')
    check('drag run finished', await waitFor(`[...document.querySelectorAll('.status-line.done')].some(e => e.offsetParent)`, 150000))
    await wait(1500)
    await shot('07-drag', 0)
    check('no horizontal overflow (drag)', !(await overflow()).length, (await overflow()).join(' | '))
    await shot('08-drag-more', 650)
    await clickSel('.app-header .pill.rec')
    await wait(1500)
    await clickSel('.rail-item[title="Analyze"]')
    check('library lists the capture', await waitFor(`[...document.querySelectorAll('.library-item')].filter(__vis).length >= 1`, 5000))
    await clickSel('.library-item')
    await waitFor(`[...document.querySelectorAll('.log-chip b')].some(e => e.offsetParent)`, 6000)
    await wait(1200)
    await shot('09-analyze', 0)
    check('no horizontal overflow (analyze)', !(await overflow()).length, (await overflow()).join(' | '))
    await shot('10-analyze-graphs', 380)
    await click('heatmap', '.logviewer .segmented')
    await wait(1500)
    await shot('11-heatmap', 380)
    await clickSel('.rail-item[title="Settings"]')
    await wait(600)
    await shot('12-settings', 0)
    check('no horizontal overflow (settings)', !(await overflow()).length, (await overflow()).join(' | '))
    await shot('13-settings-more', 900)
  } catch (err) {
    check('no exception', false, err && err.stack)
  }
  check('no console errors', errors.length === 0, errors.join(' | '))
  log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`)
  app.exit(0)
})
