import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Web bundle for the mobile app (Capacitor copies dist-mobile into the iOS project).
// The shared UI runs as is; src/mobile provides the API the desktop preload provides.

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      // Browser builds of the Node modules the core uses (npm packages instead of Node built-ins).
      events: resolve(__dirname, 'node_modules/events/events.js'),
      buffer: resolve(__dirname, 'node_modules/buffer/index.js')
    }
  },
  build: {
    outDir: resolve(__dirname, 'dist-mobile'),
    emptyOutDir: true,
    target: 'safari15',
    chunkSizeWarningLimit: 2000
  },
  server: { port: 5199 }
})
