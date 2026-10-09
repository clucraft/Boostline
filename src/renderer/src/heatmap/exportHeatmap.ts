import { cellColor, fmtEdge, fmtVal, legendGradient, type HeatmapModel } from './model'

const rangeLabel = (edges: number[], i: number): string => `${fmtEdge(edges[i])}-${fmtEdge(edges[i + 1])}`

/** Table of the displayed values: first row = x ranges, first column = y ranges, highest y on top. */
export function heatmapTable(model: HeatmapModel, sep: '\t' | ','): string {
  const { xEdges, yEdges } = model.grid
  const cols = xEdges.length - 1
  const corner = `${model.yDef.name} [${model.yUnit.label}] \\ ${model.xDef.name} [${model.xUnit.label}]`
  const quote = (s: string): string => (sep === ',' && /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = [[corner, ...Array.from({ length: cols }, (_, c) => rangeLabel(xEdges, c))].map(quote).join(sep)]
  for (let r = yEdges.length - 2; r >= 0; r--) {
    const row = [rangeLabel(yEdges, r)]
    for (let c = 0; c < cols; c++) {
      const v = model.values[r * cols + c]
      row.push(Number.isFinite(v) ? fmtVal(v, model.decimals) : '')
    }
    lines.push(row.map(quote).join(sep))
  }
  return lines.join('\n') + '\n'
}

/** Renders the heatmap (title, grid, axes, legend) to a PNG data URL. */
export function heatmapPng(model: HeatmapModel, title: string, subtitle: string): string {
  const { xEdges, yEdges } = model.grid
  const cols = xEdges.length - 1
  const rows = yEdges.length - 1
  const dpr = 2
  const cellW = 64
  const cellH = 30
  const left = 70
  const top = 64
  const bottom = 78
  const right = 20
  const w = left + cols * cellW + right
  const h = top + rows * cellH + bottom
  const canvas = document.createElement('canvas')
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  const font = (size: number, weight = 400): string => `${weight} ${size}px "Segoe UI", -apple-system, system-ui, sans-serif`
  ctx.fillStyle = '#0b131c'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#5fb4ff'
  ctx.font = font(16, 700)
  ctx.fillText(title, 16, 26)
  ctx.fillStyle = '#8296ab'
  ctx.font = font(11)
  ctx.fillText(subtitle, 16, 44)
  ctx.textAlign = 'right'
  ctx.fillStyle = '#3e5268'
  ctx.fillText('Boostline', w - 16, 26)

  ctx.textBaseline = 'middle'
  for (let r = 0; r < rows; r++) {
    const y = top + (rows - 1 - r) * cellH
    ctx.textAlign = 'right'
    ctx.fillStyle = '#8296ab'
    ctx.font = font(10)
    ctx.fillText(fmtEdge(yEdges[r]), left - 8, y + cellH - 2)
    for (let c = 0; c < cols; c++) {
      const x = left + c * cellW
      const v = model.values[r * cols + c]
      if (Number.isFinite(v)) {
        const { bg, fg } = cellColor(model, v)
        ctx.fillStyle = bg
        ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2)
        ctx.fillStyle = fg
        ctx.textAlign = 'center'
        ctx.font = font(11, 600)
        ctx.fillText(fmtVal(v, model.decimals), x + cellW / 2, y + cellH / 2)
      } else {
        ctx.strokeStyle = '#1d2c3d'
        ctx.setLineDash([3, 3])
        ctx.strokeRect(x + 1.5, y + 1.5, cellW - 3, cellH - 3)
        ctx.setLineDash([])
      }
    }
  }
  ctx.textAlign = 'center'
  ctx.fillStyle = '#8296ab'
  ctx.font = font(10)
  for (let c = 0; c <= cols; c++) ctx.fillText(fmtEdge(xEdges[c]), left + c * cellW, top + rows * cellH + 12)
  ctx.font = font(11)
  ctx.fillText(`${model.xDef.name} · ${model.xUnit.label}`, left + (cols * cellW) / 2, top + rows * cellH + 30)
  ctx.save()
  ctx.translate(16, top + (rows * cellH) / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText(`${model.yDef.name} · ${model.yUnit.label}`, 0, 0)
  ctx.restore()

  // Legend bar.
  const lx = left
  const ly = top + rows * cellH + 50
  const lw = Math.min(260, cols * cellW)
  const grad = ctx.createLinearGradient(lx, 0, lx + lw, 0)
  const stops = legendGradient(model).match(/rgb\([^)]+\)/g) ?? []
  stops.forEach((s, i) => grad.addColorStop(stops.length > 1 ? i / (stops.length - 1) : 0, s))
  ctx.fillStyle = grad
  ctx.fillRect(lx, ly, lw, 10)
  ctx.fillStyle = '#8296ab'
  const [lo, hi] = model.scale.kind === 'diverging' ? [-model.scale.limit, model.scale.limit] : [model.scale.min, model.scale.max]
  ctx.textAlign = 'right'
  ctx.fillText(fmtVal(lo, model.decimals), lx - 6, ly + 5)
  ctx.textAlign = 'left'
  ctx.fillText(`${fmtVal(hi, model.decimals)} ${model.valueUnit.label}`, lx + lw + 10, ly + 5)
  return canvas.toDataURL('image/png')
}
