const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const SUPPORTED = new Set(['.srt', '.vtt', '.ass', '.ssa'])
const MAX_CUES = 20000

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function parseClock(value) {
  const match = /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*$/.exec(String(value || ''))
  if (!match) return Number.NaN
  const fraction = String(match[4]).padEnd(3, '0').slice(0, 3)
  return (((Number(match[1] || 0) * 60) + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(fraction)
}

function cueEntry({ index, startMs, endMs, text, style = '', layout = '' }) {
  const normalizedText = String(text || '').replace(/\\N/gi, '\n').replace(/\r\n?/g, '\n').trim()
  if (!normalizedText || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) return null
  const frozen = { index, startMs: Math.round(startMs), endMs: Math.round(endMs), text: normalizedText, style: String(style || ''), layout: String(layout || '') }
  const cueSha256 = sha256(canonical(frozen))
  return { ...frozen, lineCount: normalizedText.split('\n').length, cueSha256 }
}

function parseTextCues(content) {
  const normalized = String(content || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const blocks = normalized.split(/\n{2,}/)
  const cues = []
  for (const block of blocks) {
    const lines = block.split('\n').map((item) => item.trimEnd())
    const timelineIndex = lines.findIndex((line) => line.includes('-->'))
    if (timelineIndex < 0) continue
    const [rawStart, rawEndAndSettings] = lines[timelineIndex].split(/\s*-->\s*/, 2)
    const rawEnd = String(rawEndAndSettings || '').trim().split(/\s+/, 1)[0]
    const text = lines.slice(timelineIndex + 1).join('\n').trim()
    const cue = cueEntry({ index: cues.length + 1, startMs: parseClock(rawStart), endMs: parseClock(rawEnd), text, layout: String(rawEndAndSettings || '').slice(rawEnd.length).trim() })
    if (cue) cues.push(cue)
  }
  return cues
}

function parseAssCues(content) {
  const lines = String(content || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const cues = []
  let inEvents = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\[Events\]$/i.test(trimmed)) { inEvents = true; continue }
    if (/^\[/.test(trimmed)) { inEvents = false; continue }
    if (!inEvents || !/^Dialogue\s*:/i.test(trimmed)) continue
    const payload = trimmed.replace(/^Dialogue\s*:\s*/i, '')
    const fields = payload.split(',')
    if (fields.length < 10) continue
    const cue = cueEntry({
      index: cues.length + 1,
      startMs: parseClock(fields[1]),
      endMs: parseClock(fields[2]),
      style: fields[3],
      layout: [fields[0], fields[4], fields[5], fields[6], fields[7], fields[8]].join(','),
      text: fields.slice(9).join(',')
    })
    if (cue) cues.push(cue)
  }
  return cues
}

function parseSubtitleCueLedger(content, extension) {
  const ext = String(extension || '').toLowerCase()
  if (!SUPPORTED.has(ext)) throw new Error('字幕预览/烧录一致性只支持 srt、vtt、ass、ssa')
  const cues = ext === '.ass' || ext === '.ssa' ? parseAssCues(content) : parseTextCues(content)
  if (!cues.length) throw new Error('字幕文件没有可核对的有效条目')
  if (cues.length > MAX_CUES) throw new Error(`字幕条目超过 ${MAX_CUES} 条安全上限`)
  const cueLedgerSha256 = sha256(canonical(cues.map(({ cueSha256, ...cue }) => cue)))
  return { schemaVersion: 1, cueCount: cues.length, cueLedgerSha256, cues }
}

class SubtitlePreviewBurnParityService {
  constructor({ fsImpl = fs } = {}) { this.fs = fsImpl }

  async freeze({ subtitlePath, renderFilter } = {}) {
    const subtitle = path.resolve(String(subtitlePath || ''))
    const extension = path.extname(subtitle).toLowerCase()
    if (!SUPPORTED.has(extension) || !this.fs.existsSync(subtitle) || !this.fs.statSync(subtitle).isFile()) throw new Error('字幕预览/烧录一致性输入无效')
    const bytes = this.fs.readFileSync(subtitle)
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('字幕预览/烧录一致性输入为空或超过20MB')
    const ledger = parseSubtitleCueLedger(bytes.toString('utf8'), extension)
    const filter = String(renderFilter || '')
    if (!filter.includes('subtitles=')) throw new Error('字幕预览/烧录缺少统一渲染滤镜')
    return {
      schemaVersion: 1,
      method: 'single-render-subtitle-preview-burn-v1',
      subtitleSha256: sha256(bytes),
      renderFilterSha256: sha256(filter),
      cueCount: ledger.cueCount,
      cueLedgerSha256: ledger.cueLedgerSha256,
      cues: ledger.cues
    }
  }

  async finalize({ subtitlePath, outputPath, renderFilter, frozen } = {}) {
    if (frozen?.schemaVersion !== 1 || frozen.method !== 'single-render-subtitle-preview-burn-v1') throw new Error('字幕预览/烧录冻结合同无效')
    const current = await this.freeze({ subtitlePath, renderFilter })
    if (current.subtitleSha256 !== frozen.subtitleSha256) throw new Error('字幕文件在预览与最终烧录之间发生变化，已拒绝交付')
    if (current.renderFilterSha256 !== frozen.renderFilterSha256) throw new Error('字幕渲染参数在预览与最终烧录之间发生变化，已拒绝交付')
    if (current.cueLedgerSha256 !== frozen.cueLedgerSha256 || current.cueCount !== frozen.cueCount) throw new Error('字幕条目在预览与最终烧录之间发生变化，已拒绝交付')
    const output = path.resolve(String(outputPath || ''))
    if (!this.fs.existsSync(output) || !this.fs.statSync(output).isFile() || this.fs.statSync(output).size <= 1024) throw new Error('字幕烧录成果不存在或不完整')
    const artifactSha256 = await hashFile(output)
    const cues = frozen.cues.map((cue) => ({
      index: cue.index,
      startMs: cue.startMs,
      endMs: cue.endMs,
      lineCount: cue.lineCount,
      previewCueSha256: cue.cueSha256,
      finalCueSha256: current.cues[cue.index - 1]?.cueSha256 || '',
      matched: cue.cueSha256 === current.cues[cue.index - 1]?.cueSha256
    }))
    if (cues.some((cue) => !cue.matched)) throw new Error('至少一条字幕的文字、时间、换行、样式或位置与预览不一致')
    const artifact = { path: output, artifactSha256, bytes: this.fs.statSync(output).size }
    return {
      schemaVersion: 1,
      method: 'single-render-subtitle-preview-burn-v1',
      verdict: 'matched',
      renderer: 'ffmpeg-libass-single-render',
      sameArtifact: true,
      subtitleSha256: frozen.subtitleSha256,
      renderFilterSha256: frozen.renderFilterSha256,
      cueCount: frozen.cueCount,
      cueLedgerSha256: frozen.cueLedgerSha256,
      cues,
      preview: { ...artifact, role: 'play-this-frozen-final-artifact' },
      final: { ...artifact, role: 'delivered-artifact' }
    }
  }
}

module.exports = { SubtitlePreviewBurnParityService, parseSubtitleCueLedger, parseClock }
