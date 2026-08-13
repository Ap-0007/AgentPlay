const path = require('path')

function subtitleMediaKey(mediaPath) {
  const input = String(mediaPath || '')
  const isWindowsAbsolute = /^[a-z]:[\\/]/i.test(input) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(input)
  if (isWindowsAbsolute) return path.win32.normalize(input).replace(/\\/g, '/').toLowerCase()
  const resolved = path.resolve(input).replace(/\\/g, '/')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function buildTranscriptionStatus(durationSeconds) {
  const seconds = Math.max(0, Number(durationSeconds) || 0)
  if (!seconds) return '正在本机识别语音（CPU）；这是耗时阶段，识别完成后翻译通常只需几十秒'
  const lowMinutes = Math.max(1, Math.ceil(seconds * 0.7 / 60))
  const highMinutes = Math.max(lowMinutes + 1, Math.ceil(seconds * 1.4 / 60))
  return `正在本机识别语音（CPU，预计约 ${lowMinutes}–${highMinutes} 分钟）；识别完成后翻译通常只需几十秒`
}

module.exports = { buildTranscriptionStatus, subtitleMediaKey }
