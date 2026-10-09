/** Series palette, tuned for the dark chart background. */
export const SERIES_COLORS = [
  '#ff4d5e',
  '#3b9cff',
  '#ffa630',
  '#f97316',
  '#22c55e',
  '#a78bfa',
  '#f472b6',
  '#facc15',
  '#22d3ee',
  '#84cc16'
]

export const colorAt = (i: number): string => SERIES_COLORS[i % SERIES_COLORS.length]

/** Colors for compared dyno / drag runs. */
export const RUN_COLORS = ['#3b9cff', '#ffa630', '#22c55e', '#f472b6', '#a78bfa', '#22d3ee']

export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
