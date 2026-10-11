import dgram from 'node:dgram'
import { createWriteStream, promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import type { Runtime, TcpSocket, UdpSocket } from '@core/runtime'

/** Desktop (Electron main) and test runtime: Node's own sockets and files. */
export const nodeRuntime: Runtime = {
  describePlatform: () => `${os.platform()} ${os.release()}`,
  createTcpConnection: (host, port) => net.createConnection({ host, port }) as unknown as TcpSocket,
  createUdpSocket: () => dgram.createSocket('udp4') as unknown as UdpSocket,
  networkInterfaces: () => os.networkInterfaces(),
  joinPath: (...parts) => join(...parts),
  readDir: (dir) => fs.readdir(dir),
  readTextFile: (path) => fs.readFile(path, 'utf8'),
  writeTextFile: (path, text) => fs.writeFile(path, text, 'utf8'),
  createFileWriter: (path) => {
    const out = createWriteStream(path, { encoding: 'utf8' })
    return {
      write: (text) => void out.write(text),
      end: () => new Promise((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    }
  }
}
