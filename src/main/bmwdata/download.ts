import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { createGunzip } from 'node:zlib'
import { importBmwUnifiedDb } from './importDb'
import type { BmwDataPack } from '@core/bmwdata/types'

// Downloads the latest bmw-unified-db release (bmw.sqlite.gz, ~130 MB), checks it against
// the release's SHA256SUMS, unpacks it to a temp file, imports the DME tables and deletes
// the temporary files. Only the extracted DME data (a few MB) is kept.

export const BMW_DB_REPO = 'gediz/bmw-unified-db'
const ASSET = 'bmw.sqlite.gz'

export interface DownloadProgress {
  phase: 'release' | 'download' | 'verify' | 'unpack' | 'import' | 'done'
  received?: number
  total?: number
}

interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
}

async function latestRelease(signal?: AbortSignal): Promise<{ tag: string; assets: ReleaseAsset[] }> {
  const res = await fetch(`https://api.github.com/repos/${BMW_DB_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Boostline' },
    signal
  })
  if (!res.ok) throw new Error(`GitHub release lookup failed (${res.status})`)
  const json = (await res.json()) as { tag_name: string; assets: ReleaseAsset[] }
  return { tag: json.tag_name, assets: json.assets }
}

export async function downloadAndImportBmwDb(onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<BmwDataPack> {
  onProgress({ phase: 'release' })
  const release = await latestRelease(signal)
  const asset = release.assets.find((a) => a.name === ASSET)
  if (!asset) throw new Error(`Release ${release.tag} has no ${ASSET}`)
  const sums = release.assets.find((a) => a.name === 'SHA256SUMS')

  const stamp = `${process.pid}-${Date.now()}`
  const gz = join(tmpdir(), `boostline-bmwdb-${stamp}.sqlite.gz`)
  const sqlite = join(tmpdir(), `boostline-bmwdb-${stamp}.sqlite`)
  try {
    const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'Boostline' }, signal })
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
    const total = Number(res.headers.get('content-length')) || asset.size
    let received = 0
    let last = 0
    const hash = createHash('sha256')
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length
        hash.update(chunk)
        if (received - last > 1024 * 1024 || received === total) {
          last = received
          onProgress({ phase: 'download', received, total })
        }
        cb(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), meter, createWriteStream(gz), { signal })

    if (sums) {
      onProgress({ phase: 'verify' })
      const text = await (await fetch(sums.browser_download_url, { headers: { 'User-Agent': 'Boostline' }, signal })).text()
      const expected = text.split('\n').find((l) => l.trim().endsWith(ASSET))?.split(/\s+/)[0]?.toLowerCase()
      if (expected && expected !== hash.digest('hex')) throw new Error('Checksum mismatch: the download is corrupt, try again')
    }

    onProgress({ phase: 'unpack' })
    await pipeline(createReadStream(gz), createGunzip(), createWriteStream(sqlite), { signal })
    onProgress({ phase: 'import' })
    const pack = importBmwUnifiedDb(sqlite, `bmw-unified-db ${release.tag}`)
    onProgress({ phase: 'done' })
    return pack
  } finally {
    await fs.rm(gz, { force: true })
    await fs.rm(sqlite, { force: true })
  }
}
