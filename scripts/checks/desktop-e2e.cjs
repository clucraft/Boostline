// End-to-end check of the built desktop app against the simulator: drives every screen like a
// user and records pass/fail per check, with screenshots, in .checks/desktop/.
//   npm run build && npx electron scripts/checks/desktop-e2e.cjs
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const WORK = path.join(ROOT, '.checks', 'desktop')
const OUT = path.join(WORK, 'results')
const DATA = path.join(WORK, 'data')
const USER = path.join(WORK, 'user')
const SAVED = path.join(OUT, 'saved')
for (const d of [OUT, DATA, USER]) fs.rmSync(d, { recursive: true, force: true })
for (const d of [OUT, DATA, USER, SAVED]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(USER, 'settings.json'), JSON.stringify({ dataDir: DATA }))
const BOOST_FUEL = ['engine.rpm', 'throttle.pedal', 'boost.actual', 'boost.target', 'fuel.lambda.actual', 'fuel.lambda.target', 'fuel.rail.actual', 'fuel.rail.target', 'boost.wg_actual', 'temp.intake']
const FULL = [...BOOST_FUEL, 'boost.wg_target', 'throttle.position', 'vehicle.speed', 'vehicle.gear', 'load.engine', 'temp.coolant', 'ign.cyl1', 'ign.cyl2', 'ign.cyl3', 'ign.cyl4', 'ign.cyl5', 'ign.cyl6']
fs.writeFileSync(
  path.join(USER, 'presets.json'),
  JSON.stringify({
    channels: [
      { name: 'Boost & Fuel', channelIds: BOOST_FUEL },
      { name: 'Timing & Knock', channelIds: ['engine.rpm', 'ign.avg', 'knock.cyl1', 'knock.cyl2', 'knock.cyl3', 'knock.cyl4', 'knock.cyl5', 'knock.cyl6'] },
      { name: 'E2E full', channelIds: FULL }
    ],
    layouts: [
      { name: 'Boost control', graphs: [{ title: 'Boost control', channelIds: ['boost.actual', 'boost.target', 'boost.wg_actual'] }, { title: 'Rail pressure', channelIds: ['fuel.rail.actual', 'fuel.rail.target'] }] },
      { name: 'WOT overview', graphs: [{ title: 'Engine', channelIds: ['engine.rpm', 'throttle.pedal', 'vehicle.gear'] }, { title: 'Boost', channelIds: ['boost.actual', 'boost.target'] }, { title: 'Fuelling', channelIds: ['fuel.lambda.actual', 'fuel.lambda.target'] }, { title: 'Knock', channelIds: ['ign.cyl1', 'ign.cyl2'] }] }
    ],
    dragProfiles: []
  })
)
app.setVersion(require(path.join(ROOT, 'package.json')).version)
app.setPath('userData', USER)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

const T0 = Date.now()
const log = (...a) => {
  const line = `${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s ` + a.join(' ')
  console.log(line)
  fs.appendFileSync(path.join(OUT, 'run.log'), line + '\n')
}
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') })
  log(ok ? 'PASS' : 'FAIL', name, detail ? `· ${String(detail).slice(0, 200)}` : '')
}

const newestLogs = () => {
  const dir = path.join(DATA, 'Logs')
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).map((f) => path.join(dir, f))
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
}
dialog.showOpenDialog = async (_w, opts) => {
  const o = opts ?? _w
  const files = newestLogs()
  log('open dialog', o?.title, '->', files[0])
  if (o?.properties?.includes('multiSelections')) return { canceled: !files.length, filePaths: files }
  return { canceled: !files.length, filePaths: files.slice(0, 1) }
}
const savedFiles = []
dialog.showSaveDialog = async (_w, opts) => {
  const o = opts ?? _w
  const file = path.join(SAVED, path.basename(o.defaultPath || 'file'))
  savedFiles.push(file)
  log('save dialog ->', file)
  return { canceled: false, filePath: file }
}

require(path.join(ROOT, 'out/main/index.js'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  await wait(2500)
  const win = BrowserWindow.getAllWindows()[0]
  win.setSize(1480, 900)
  const consoleErrors = []
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e
    const message = e.message ?? arguments[2]
    if (level === 'error' || level === 3) {
      consoleErrors.push(message)
      log('[console error]', message)
    }
  })
  const js = (code) => win.webContents.executeJavaScript(code)
  await js(`window.__vis = (el) => !!el && el.getClientRects().length > 0;
    window.__btn = (text, scope) => {
      const t = text.toLowerCase()
      const roots = scope ? [...document.querySelectorAll(scope)].filter(__vis) : [document]
      return roots.flatMap(r => [...r.querySelectorAll('button')]).find(b => __vis(b) && !b.disabled && b.textContent.trim().toLowerCase().startsWith(t))
    };
    window.__setVal = (el, v) => {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    };
    window.__text = (sel) => [...document.querySelectorAll(sel)].filter(__vis).map(e => e.textContent.trim());
    true`)
  const click = async (text, scope) => {
    const ok = await js(`(() => { const b = __btn(${JSON.stringify(text)}, ${JSON.stringify(scope ?? null)}); if (!b) return false; b.click(); return true })()`)
    if (!ok) log('  (button not found)', JSON.stringify(text))
    await wait(250)
    return ok
  }
  const clickSel = async (sel, idx = 0) => {
    const ok = await js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(__vis)[${idx}]; if (!e) return false; e.click(); return true })()`)
    if (!ok) log('  (element not found)', sel)
    await wait(250)
    return ok
  }
  const count = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(__vis).length`)
  const texts = (sel) => js(`__text(${JSON.stringify(sel)})`)
  const bodyText = () => js('document.body.innerText')
  const waitFor = async (expr, ms, label) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        if (await js(expr)) return true
      } catch {}
      await wait(300)
    }
    log('  timeout waiting for', label ?? expr)
    return false
  }
  const shot = async (name) => {
    await wait(500)
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG())
  }
  const key = (k, mods = {}, target = 'window') =>
    js(`(${target === 'window' ? 'window' : `document.querySelector(${JSON.stringify(target)})`}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, ctrlKey: ${!!mods.ctrl}, metaKey: ${!!mods.meta} }))`)
  const setInput = (sel, v, idx = 0) => js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(__vis)[${idx}]; if (!e) return false; __setVal(e, ${JSON.stringify(v)}); return true })()`)
  const toasts = () => texts('.toast')

  try {
    // ------------------------------------------------------------ shell
    await waitFor(`!!document.querySelector('.app-header')`, 15000)
    check('header renders', await count('.app-header'))
    check('rail has 5 sections', (await count('.rail .rail-item')) === 5, await count('.rail .rail-item'))
    check('version shown in rail', /v\d+\.\d+\.\d+/.test((await texts('.rail-version'))[0] ?? ''), (await texts('.rail-version'))[0])
    check('window controls (Windows)', (await count('.window-controls button')) === 3)
    check('Live page shows connect prompt', /Not connected/.test(await bodyText()))
    const tilesBefore = await count('.tile:not(.tile-add)')
    check('default dashboard: 7 tiles incl. 3 actual/target pairs', tilesBefore === 7 && (await count('.tile.pair')) === 3, `${tilesBefore} tiles, ${await count('.tile.pair')} pairs`)
    await shot('01-start')

    // ------------------------------------------------------------ connect
    check('connect button', await click('connect · simulator', '.app-header'))
    check('streaming after connect', await waitFor(`!!document.querySelector('.app-header .dot.live')`, 15000))
    check('connected toast', (await toasts()).some((t) => /Connected/.test(t)), (await toasts()).join(' | '))
    await wait(3000)
    const vals = await texts('.tile .tile-value .v')
    check('all tile values update', vals.length > 0 && vals.every((v) => v !== '—'), vals.join(','))
    const devs = await texts('.dev-label .d')
    check('deviation readouts update', devs.length === 3 && devs.every((d) => /^Δ [+-]?\d/.test(d)), devs.join(' | '))
    check('header shows sample rate', /Hz/.test((await texts('.app-header .pill')).join(' ')), (await texts('.app-header .pill')).join(' | '))
    check('live graph rendered', (await count('.logviewer .uplot')) >= 1)
    const legendVals = await texts('.logviewer .legend-item .val')
    check('live graph legend values', legendVals.some((v) => /\d/.test(v)), legendVals.join(','))
    check('CTA hidden when connected', !/Not connected/.test(await bodyText()))
    await shot('02-live')

    // ------------------------------------------------------------ vehicle pill
    if (await count('.app-header .pill .mono')) {
      const pills = await js(`[...document.querySelectorAll('.app-header button.pill')].filter(__vis).map(b => b.title)`)
      const vi = pills.indexOf('Vehicle details')
      if (vi >= 0) {
        await clickSel('.app-header button.pill', vi)
        check('vehicle menu shows VIN', /VIN/.test((await texts('.menu')).join(' ')), (await texts('.menu')).join(' '))
        await key('Escape')
        await wait(200)
      }
    }

    // ------------------------------------------------------------ palette
    await key('k', { ctrl: true })
    check('Ctrl+K opens channel picker', await waitFor(`!!document.querySelector('.palette')`, 3000))
    await setInput('.palette-search input', 'oil temp')
    await wait(300)
    const first = (await texts('.palette-item .name'))[0]
    check('search filters channels', first === 'Oil temp', first)
    await key('Enter', {}, '.palette-search input')
    await wait(500)
    check('Enter adds channel', (await texts('.tile .name')).includes('Oil temp'), (await texts('.tile .name')).join(','))
    await shot('03-palette')
    await key('Escape', {}, '.palette-search input')
    await wait(300)
    check('Esc closes picker', (await count('.palette')) === 0)
    const removed = await js(`(() => { const t = [...document.querySelectorAll('.tile')].find(t => t.querySelector('.name')?.textContent === 'Oil temp'); t?.querySelector('.tile-actions button')?.click(); return !!t })()`)
    await wait(400)
    check('tile remove button', removed && !(await texts('.tile .name')).includes('Oil temp'))
    check('Channels button opens picker', await click('channels', '.page-toolbar'))
    check('picker visible', (await count('.palette')) === 1)
    await clickSel('.palette-backdrop')
    await js(`document.querySelector('.palette-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await wait(300)
    check('picker closes on backdrop', (await count('.palette')) === 0)

    // ------------------------------------------------------------ presets
    check('presets menu', await click('boost & fuel', '.page-toolbar'))
    check('apply Timing & Knock preset', await click('timing & knock', '.menu'))
    await wait(500)
    check('preset loaded tiles', (await texts('.tile .name')).includes('Knock retard cyl 1'), (await texts('.tile .name')).join(','))
    await click('timing & knock', '.page-toolbar')
    check('save preset item', await click('save current channels', '.menu'))
    await setInput('.modal input', 'E2E preset')
    await click('save', '.modal')
    await wait(400)
    await click('timing & knock', '.page-toolbar')
    check('saved preset listed', (await texts('.menu button')).some((t) => t.includes('E2E preset')), (await texts('.menu button')).join(','))
    await click('boost & fuel', '.menu')
    await wait(500)
    check('back to Boost & Fuel', (await count('.tile.pair')) === 3)

    // ------------------------------------------------------------ stream controls
    check('pause stream', await click('pause stream'))
    check('stream paused', await waitFor(`document.querySelector('.page-toolbar .sub')?.textContent.includes('Stream paused')`, 5000))
    check('resume stream', await click('resume stream'))
    check('streaming again', await waitFor(`[...document.querySelectorAll('.page-toolbar .sub')].some(e => e.textContent.includes('Streaming'))`, 5000))
    check('freeze graphs', await click('freeze graphs'))
    check('resume graphs', await click('resume graphs'))
    const g0 = await count('.graph')
    await click('add graph')
    check('add graph', (await count('.graph')) === g0 + 1)
    await js(`(() => { const g = [...document.querySelectorAll('.graph')].filter(__vis).pop(); g.querySelector('button[title="Remove graph"]').click() })()`)
    await wait(300)
    check('remove graph', (await count('.graph')) === g0)

    // ------------------------------------------------------------ capture
    await click('boost & fuel', '.page-toolbar')
    await click('e2e full', '.menu')
    await wait(800)
    check('large dashboard', (await count('.tile:not(.tile-add)')) >= 18, await count('.tile:not(.tile-add)'))
    await shot('02b-live-full')
    check('start capture', await click('start capture', '.app-header'))
    check('capture pill', await waitFor(`!!document.querySelector('.app-header .pill.rec')`, 5000))
    await wait(2500)
    const recText = (await texts('.app-header .pill.rec'))[0] ?? ''
    check('capture counts samples', /[1-9][\d,]* samples/.test(recText), recText)

    // ------------------------------------------------------------ dyno (live)
    await clickSel('.rail-item[title="Dyno"]')
    check('dyno page', (await texts('.page-toolbar h1')).includes('Dyno'))
    check('rail shows capture badge', (await count('.rail-badge')) === 1)
    check('arm dyno run', await click('arm run'))
    check('closed-course notice on first arm', await waitFor(`[...document.querySelectorAll('.modal-head')].some(e => /Closed courses only/.test(e.textContent))`, 3000))
    await shot('04a-closed-course')
    check('accept closed-course notice', await click('i understand', '.modal'))
    check('dyno armed', await waitFor(`[...document.querySelectorAll('.status-line')].some(e => e.offsetParent && /Armed|Recording/.test(e.textContent))`, 5000))
    await shot('04-dyno-armed')
    check('dyno pull captured', await waitFor(`[...document.querySelectorAll('.status-line.done')].some(e => e.offsetParent)`, 150000))
    await wait(1200)
    const heroDyno = (await texts('.metric.hero .value'))[0] ?? ''
    check('dyno peak power', /^\d{2,4}/.test(heroDyno), heroDyno)
    check('dyno chart', (await count('.result-chart .uplot')) === 1)
    check('dyno run saved', (await count('.run-item')) >= 1)
    check('dyno saved toast', (await toasts()).some((t) => /Pull captured/.test(t)), (await toasts()).join(' | '))
    await shot('05-dyno')
    const massBefore = await js(`[...document.querySelectorAll('.inspector input')].filter(__vis)[0].value`)
    await setInput('.inspector input', String(Number(massBefore) + 300))
    await wait(600)
    const heroDyno2 = (await texts('.metric.hero .value'))[0] ?? ''
    check('setup change re-analyses', heroDyno2 !== heroDyno, `${heroDyno} -> ${heroDyno2}`)
    await setInput('.inspector input', massBefore)
    await wait(400)
    check('dyno Save PNG', await click('save png'))
    await wait(800)
    check('dyno PNG written', savedFiles.some((f) => f.endsWith('.png') && fs.existsSync(f)))
    await click('expand', '.result-chart')
    check('dyno expand hides inspector', (await count('.inspector')) === 0)
    await click('restore', '.result-chart')
    check('dyno restore', (await count('.inspector')) === 1)

    // ------------------------------------------------------------ drag (live)
    await clickSel('.rail-item[title="Drag"]')
    check('drag page', (await texts('.page-toolbar h1')).includes('Drag'))
    check('arm drag run', await click('arm run'))
    await wait(300)
    check('closed-course notice only once', (await count('.modal')) === 0)
    await shot('06-drag-armed')
    check('drag run finished', await waitFor(`[...document.querySelectorAll('.status-line.done')].some(e => e.offsetParent)`, 150000))
    await wait(1200)
    const heroDrag = (await texts('.metric.hero .value'))[0] ?? ''
    check('drag final time', /^\d+\.\d{3}/.test(heroDrag), heroDrag)
    check('drag splits', (await count('.bar-row')) > 3, await count('.bar-row'))
    check('drag gear changes', (await count('.shift')) >= 1, await count('.shift'))
    check('drag chart', (await count('.result-chart .uplot')) === 1)
    check('drag run saved', (await count('.run-item')) >= 1)
    await shot('07-drag')
    await setInput('.inspector .grid-2 input', '100', 0)
    await setInput('.inspector .grid-2 input', '98', 1)
    await click('add point')
    check('calibration point added', (await count('.cal-table tbody tr')) === 1)
    await clickSel('.cal-table tbody tr')
    await click('remove point')
    check('calibration point removed', (await count('.cal-table tbody tr')) === 0)
    await click('save png')
    await wait(800)
    check('drag PNG written', savedFiles.filter((f) => f.endsWith('.png')).length >= 2)

    // ------------------------------------------------------------ stop capture
    await clickSel('.app-header .pill.rec')
    check('capture stopped + saved toast', await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Log saved/.test(t.textContent))`, 8000))
    check('log file on disk', newestLogs().length >= 1, newestLogs()[0])

    // ------------------------------------------------------------ analyze
    await clickSel('.rail-item[title="Analyze"]')
    check('analyze page', (await texts('.page-toolbar h1')).includes('Analyze'))
    check('library lists log', await waitFor(`[...document.querySelectorAll('.library-item')].filter(__vis).length >= 1`, 5000))
    check('analyze empty state', /Pick a log from the library/.test(await bodyText()))
    await clickSel('.library-item')
    check('log opened', await waitFor(`[...document.querySelectorAll('.log-chip b')].some(e => e.offsetParent)`, 8000))
    check('library item highlighted', (await count('.library-item.active')) === 1)
    check('log graphs rendered', (await count('.logviewer .uplot')) >= 1)
    const wotText = (await texts('.wot-nav'))[0] ?? ''
    check('WOT pulls detected', /found/.test(wotText), wotText)
    await js(`[...document.querySelectorAll('.wot-nav button')].filter(__vis)[1].click()`)
    await wait(600)
    check('WOT next pull', /1 \//.test((await texts('.wot-nav'))[0] ?? ''), (await texts('.wot-nav'))[0])
    await shot('08-analyze')
    await click('export pull')
    await wait(800)
    check('export pull CSV', savedFiles.some((f) => f.endsWith('.csv') && fs.existsSync(f)))
    await click('dyno this pull')
    await wait(1200)
    check('Dyno this pull navigates', (await texts('.page-toolbar h1')).includes('Dyno'))
    check('dyno result from log', /^\d{2,4}/.test((await texts('.metric.hero .value'))[0] ?? ''), (await texts('.metric.hero .value'))[0])
    check('unsaved run offers Save run', await click('save run'))
    await wait(600)
    check('two dyno runs saved', (await count('.run-item')) >= 2, await count('.run-item'))
    await js(`(() => { const items = [...document.querySelectorAll('.run-item')].filter(__vis); const other = items.find(i => !i.classList.contains('selected')); other.querySelector('input').click() })()`)
    await wait(800)
    check('overlay saved run', (await count('.result-chart .legend-item')) >= 4, await count('.result-chart .legend-item'))
    await shot('05b-dyno-overlay')
    await js(`(() => { const items = [...document.querySelectorAll('.run-item')].filter(__vis); const other = items.find(i => !i.classList.contains('selected')); other.querySelector('input').click() })()`)
    await clickSel('.rail-item[title="Analyze"]')
    check('log stays open after switching', (await count('.log-chip b')) >= 1)
    const logName = ((await texts('.log-chip b'))[0] ?? '').replace(/\.[^.]+$/, '')
    await click('drag timing from log')
    await wait(1200)
    check('Drag timing from log navigates', (await texts('.page-toolbar h1')).includes('Drag'))
    check('drag result from log', ((await texts('.result-chart h2'))[0] ?? '').includes(logName), `${(await texts('.result-chart h2'))[0]} / ${logName}`)
    await clickSel('.rail-item[title="Analyze"]')

    // graph tools
    const legendBefore = await count('.logviewer .graph-legend .legend-item')
    await click('channels', '.graph')
    check('edit channels modal', (await count('.modal')) === 1)
    await js(`(() => { const box = [...document.querySelectorAll('.modal .channel-item input')].find(i => i.checked); box.click() })()`)
    await click('apply', '.modal')
    await wait(500)
    check('channel removed from graph', (await count('.logviewer .graph-legend .legend-item')) === legendBefore - 1, `${legendBefore} -> ${await count('.logviewer .graph-legend .legend-item')}`)
    await click('channels', '.graph')
    await js(`(() => { const box = [...document.querySelectorAll('.modal .channel-item input')].find(i => !i.checked); box.click() })()`)
    await click('apply', '.modal')
    await wait(500)
    check('channel added to graph', (await count('.logviewer .graph-legend .legend-item')) === legendBefore, `${await count('.logviewer .graph-legend .legend-item')}`)
    await clickSel('.graph button[title="Rename graph"]')
    await setInput('.graph-title input', 'Renamed graph')
    await js(`document.querySelector('.graph-title input').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))`)
    await wait(300)
    check('rename graph', (await texts('.graph-title span')).includes('Renamed graph'), (await texts('.graph-title span')).join(','))
    await click('layouts', '.viewer-footer')
    await click('wot overview', '.menu')
    await wait(800)
    check('apply layout (4 graphs)', (await count('.graph')) === 4, await count('.graph'))
    const titles0 = await texts('.graph-title span')
    await clickSel('.graph button[title="Move down"]')
    const titles1 = await texts('.graph-title span')
    check('move graph down', titles1[0] === titles0[1] && titles1[1] === titles0[0], titles1.join(','))
    await clickSel('.graph button[title="Pin graph position"]')
    check('pin graph', (await count('.graph button[title="Unpin graph"]')) === 1)
    await clickSel('.graph button[title="Unpin graph"]')
    await clickSel('.graph button[title="Fullscreen"]')
    check('fullscreen graph', (await count('.graph.fullscreen')) === 1)
    await shot('09-fullscreen')
    await clickSel('.graph button[title="Exit fullscreen"]')
    check('exit fullscreen', (await count('.graph.fullscreen')) === 0)
    await click('save', '.viewer-footer')
    await click('save layout as', '.menu')
    await setInput('.modal input', 'E2E layout')
    await click('save', '.modal')
    await wait(300)
    await click('layouts', '.viewer-footer')
    check('layout saved', (await texts('.menu button')).includes('E2E layout'), (await texts('.menu button')).join(','))
    await key('Escape')
    await wait(200)
    const n0 = savedFiles.length
    await click('save', '.viewer-footer')
    await click('export visible range', '.menu')
    await wait(800)
    check('export visible range CSV', savedFiles.length === n0 + 1 && fs.existsSync(savedFiles[n0]))
    await click('save', '.graph')
    await click('graph as png', '.menu')
    await wait(800)
    check('graph PNG', savedFiles.length === n0 + 2 && fs.existsSync(savedFiles[n0 + 1]))
    await js(`(() => { const o = [...document.querySelectorAll('.logviewer .u-over')].filter(__vis)[0]; const r = o.getBoundingClientRect(); o.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + 40 })) })()`)
    await wait(300)
    check('graph context menu', (await texts('.menu button')).some((t) => t.includes('Zoom to fit')), (await texts('.menu button')).join(','))
    await key('Escape')
    await wait(200)
    await click('open', '.logviewer .panel-header')
    await click('compare with another log', '.menu')
    await wait(800)
    check('compare log', /offset/.test((await texts('.log-chip')).join(' ')), (await texts('.log-chip')).join(' | '))
    await clickSel('.log-chip button[title="Stop comparing"]')
    check('stop comparing', !/offset/.test((await texts('.log-chip')).join(' ')))

    // heatmap
    await click('heatmap', '.logviewer .segmented')
    check('heatmap renders', await waitFor(`[...document.querySelectorAll('.hm-cell:not(.hm-empty)')].filter(__vis).length > 5`, 8000))
    await clickSel('.hm-cell:not(.hm-empty)', 3)
    check('heatmap cell detail', (await count('.hm-detail')) >= 1)
    await shot('10-heatmap')
    await click('axes')
    check('axes modal', (await count('.modal')) === 1)
    await key('Escape')
    await wait(200)
    const n1 = savedFiles.length
    await click('export', '.hm-toolbar')
    await click('save as csv', '.menu')
    await wait(800)
    check('heatmap CSV export', savedFiles.length === n1 + 1)
    await click('export', '.hm-toolbar')
    await click('save as png', '.menu')
    await wait(800)
    check('heatmap PNG export', savedFiles.length === n1 + 2)
    const jumped = await js(`(() => { const c = [...document.querySelectorAll('.hm-detail .chip')].filter(__vis)[0]; if (!c) return false; c.click(); return true })()`)
    await wait(800)
    check('jump from heatmap to graphs', jumped && (await count('.graph')) >= 1)

    // close log
    await clickSel('.log-chip button[title="Close log"]')
    check('close log', /Pick a log from the library/.test(await bodyText()))
    await click('expand', '.logviewer')
    check('analyze expand hides library', (await count('.library')) === 0)
    await click('restore', '.logviewer')

    // ------------------------------------------------------------ settings
    await clickSel('.rail-item[title="Settings"]')
    check('settings page', (await texts('.page-toolbar h1')).includes('Settings'))
    await shot('11-settings')
    const psi = await js(`(() => { const b = [...document.querySelectorAll('.segmented button')].filter(__vis).find(b => b.textContent === 'psi'); b?.click(); return !!b })()`)
    await wait(500)
    await clickSel('.rail-item[title="Live"]')
    await wait(800)
    check('unit change applies to tiles', psi && (await texts('.tile .u')).includes('psi'), (await texts('.tile .u')).join(','))
    await clickSel('.rail-item[title="Settings"]')
    await js(`[...document.querySelectorAll('.segmented button')].filter(__vis).find(b => b.textContent === 'bar').click()`)
    const toggles = await count('.toggle')
    check('settings toggles', toggles >= 4, toggles)
    const adapterOpts = await js(`[...document.querySelectorAll('select.select')].filter(__vis)[0].options.length`)
    check('adapter choices', adapterOpts === 4, adapterOpts)
    check('BMW DME data card', /BMW DME data/.test(await bodyText()))

    // ------------------------------------------------------------ disconnect
    await clickSel('.rail-item[title="Live"]')
    const pills = await js(`[...document.querySelectorAll('.app-header button.pill')].filter(__vis).map(b => b.title)`)
    await clickSel('.app-header button.pill', pills.indexOf(''))
    check('connection menu', (await texts('.menu button')).some((t) => /Disconnect/.test(t)), (await texts('.menu')).join(' '))
    await click('disconnect', '.menu')
    check('disconnected', await waitFor(`document.body.innerText.includes('Not connected')`, 8000))
    await shot('12-disconnected')
  } catch (err) {
    check('no exception', false, err && err.stack)
  }
  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '))
  const failed = results.filter((r) => !r.ok)
  log(`\n${results.length - failed.length}/${results.length} checks passed`)
  for (const f of failed) log('FAILED:', f.name, f.detail)
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  app.exit(failed.length ? 1 : 0)
})
