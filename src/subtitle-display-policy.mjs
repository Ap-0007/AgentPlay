export const SUBTITLE_POSITIONS = ['high', 'middle', 'low']

const LINE_PERCENT = Object.freeze({
  high: 54,
  middle: 70,
  low: 84
})

export function normalizeSubtitlePosition(value) {
  return SUBTITLE_POSITIONS.includes(value) ? value : 'low'
}

export function subtitleLinePercent(value) {
  return LINE_PERCENT[normalizeSubtitlePosition(value)]
}

export function shiftSubtitlePosition(value, direction) {
  const current = SUBTITLE_POSITIONS.indexOf(normalizeSubtitlePosition(value))
  const delta = direction === 'up' ? -1 : 1
  return SUBTITLE_POSITIONS[Math.max(0, Math.min(SUBTITLE_POSITIONS.length - 1, current + delta))]
}

export function subtitleCueSettings(value) {
  return `line:${subtitleLinePercent(value)}% position:50% size:72% align:center`
}
