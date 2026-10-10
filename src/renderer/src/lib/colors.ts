/** Series palette, tuned for the dark chart background. */
export const SERIES_COLORS = [
  '#ffad33',
  '#38bdf8',
  '#a78bfa',
  '#4ade80',
  '#f472b6',
  '#e5e7eb',
  '#f87171',
  '#2dd4bf',
  '#facc15',
  '#818cf8'
]

export const colorAt = (i: number): string => SERIES_COLORS[i % SERIES_COLORS.length]

/** Colors for compared dyno / drag runs. */
export const RUN_COLORS = ['#ffad33', '#38bdf8', '#a78bfa', '#4ade80', '#f472b6', '#2dd4bf']

export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
