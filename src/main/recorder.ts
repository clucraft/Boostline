import { createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { ChannelDef } from '@shared/types'
import { csvHeaderLine, csvMetaLines, csvRowLine } from '@shared/analysis/csv'

const pad = (n: number): string => String(n).padStart(2, '0')

export function logFileName(date = new Date()): string {
  return (
    `Boostline_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.csv`
  )
}

/** Streams samples to a Boostline CSV log as they arrive. */
export class Recorder {
  readonly file: string
  readonly startedAt = Date.now()
  samples = 0
  private out: WriteStream
  private t0: number | null = null
  private decimals: number[]
  private buffer: string[] = []

  constructor(dir: string, channels: ChannelDef[], meta: Record<string, string>) {
    this.file = join(dir, logFileName())
    this.decimals = channels.map((c) => Math.min(c.decimals + 1, 4))
    this.out = createWriteStream(this.file, { encoding: 'utf8' })
    this.out.write(
      csvMetaLines({ app: 'Boostline', started: new Date(this.startedAt).toISOString(), ...meta, ids: channels.map((c) => c.id).join(',') }) +
        csvHeaderLine(channels)
    )
  }

  write(t: number, values: number[]): void {
    if (this.t0 === null) this.t0 = t
    this.buffer.push(csvRowLine(t - this.t0, values, this.decimals))
    this.samples++
    if (this.buffer.length >= 25) this.flush()
  }

  private flush(): void {
    if (this.buffer.length) this.out.write(this.buffer.join(''))
    this.buffer = []
  }

  close(): Promise<string> {
    this.flush()
    return new Promise((resolve, reject) => {
      this.out.end((err?: Error | null) => (err ? reject(err) : resolve(this.file)))
    })
  }
}
