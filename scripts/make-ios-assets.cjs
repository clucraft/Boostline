// Renders the iOS app icon (opaque, full-bleed: iOS rounds the corners itself) from
// build/icon-ios.svg, and the launch screen image (the Boostline tile on near-black)
// from build/icon.svg. Usage: npx electron scripts/make-ios-assets.cjs
// Canvas PNGs carry an alpha channel, which App Store icons must not have: flatten the
// results afterwards, e.g. python -c "from PIL import Image; im = Image.open(p); im.convert('RGB').save(p)".
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const assets = join(root, 'ios/App/App/Assets.xcassets')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const render = (svg, size, background, inner) =>
    win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = c.height = ${size}
        const ctx = c.getContext('2d')
        ${background ? `ctx.fillStyle = ${JSON.stringify(background)}; ctx.fillRect(0, 0, ${size}, ${size})` : ''}
        const s = ${inner}
        ctx.drawImage(img, (${size} - s) / 2, (${size} - s) / 2, s, s)
        resolve(c.toDataURL('image/png').split(',')[1])
      }
      img.onerror = reject
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))}
    })`)
  const icon = await render(readFileSync(join(root, 'build/icon-ios.svg'), 'utf8'), 1024, null, 1024)
  writeFileSync(join(assets, 'AppIcon.appiconset/AppIcon-512@2x.png'), Buffer.from(icon, 'base64'))
  const splash = await render(readFileSync(join(root, 'build/icon.svg'), 'utf8'), 2732, '#050505', 440)
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    writeFileSync(join(assets, 'Splash.imageset', name), Buffer.from(splash, 'base64'))
  }
  app.quit()
})
