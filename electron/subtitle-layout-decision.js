const path = require('node:path')

const INTENT = /字幕布局|字幕适配|多分辨率字幕|横屏[^。；]{0,40}竖屏|竖屏[^。；]{0,40}横屏/
const CONSULTATION = /能不能|可不可以|可以吗|是否|怎么|如何|\?|？/
const EXCLUDE = /不要|不用|取消|例如|比如|假如|如果/
const SRT_PATH = /["'“”‘’]?((?:[A-Za-z]:)?[\\/][^"'“”‘’，。；;\n]+?\.srt)["'“”‘’]?/i

function portableBasename(value) { return String(value || '').split(/[\\/]/).filter(Boolean).pop() || '' }
function even(value) { return Math.max(2, Math.round(Number(value) / 2) * 2) }
function resolutionsNear(text, label) {
  const match = new RegExp(`${label}([^，；。]*)`).exec(text)
  if (!match) return []
  return [...match[1].matchAll(/(\d{3,4})\s*p/gi)].map((item) => Number(item[1])).filter((value) => [360, 480, 720, 1080, 1440].includes(value))
}

function compileSubtitleLayoutDecision({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim(); const source = String(sourcePath || '').trim()
  if (!text || !INTENT.test(text) || CONSULTATION.test(text) || EXCLUDE.test(text)) return { matched: false }
  const subtitlePath = SRT_PATH.exec(text)?.[1]?.trim() || ''
  if (!subtitlePath) return { matched: true, review: { kind: 'subtitle-layout-clarification', summary: '要适配哪个SRT字幕？请给出完整路径或把字幕文件拖进对话。', candidates: [] } }
  const requests = [
    { label: '横屏', aspect: '16:9', resolutions: resolutionsNear(text, '横屏') },
    { label: '竖屏', aspect: '9:16', resolutions: resolutionsNear(text, '竖屏') },
    { label: '方形', aspect: '1:1', resolutions: resolutionsNear(text, '方形') }
  ].filter((item) => text.includes(item.label))
  if (!requests.length) return { matched: true, review: { kind: 'subtitle-layout-clarification', summary: '请说明需要横屏、竖屏或方形布局，以及分辨率，例如“横屏720p、竖屏720p”。', candidates: [] } }
  for (const request of requests) if (!request.resolutions.length) request.resolutions = [1080]
  const profiles = []
  for (const request of requests) for (const resolution of [...new Set(request.resolutions)].sort((a, b) => a - b)) {
    const [width, height] = request.aspect === '16:9' ? [even(resolution * 16 / 9), resolution] : request.aspect === '9:16' ? [resolution, even(resolution * 16 / 9)] : [resolution, resolution]
    profiles.push({ id: `${request.aspect === '16:9' ? 'horizontal' : request.aspect === '9:16' ? 'vertical' : 'square'}-${resolution}p`, label: `${request.label}${resolution}p`, aspect: request.aspect, width, height, maximumLines: 2 })
  }
  if (!profiles.length || profiles.length > 6) return { matched: true, review: { kind: 'subtitle-layout-limit', summary: '单次最多生成6个字幕布局，请减少画幅或分辨率数量。', candidates: [] } }
  const position = /居中|中间/.test(text) ? 'middle' : /上移|顶部|上方/.test(text) ? 'top' : /下移|底部|下方/.test(text) ? 'bottom' : 'auto'
  const stylePreset = /纪录片/.test(text) ? 'documentary' : /强调|冲击/.test(text) ? 'impact' : 'clean'
  const subtitleLayout = { schemaVersion: 1, strategy: 'responsive-ass-layout-v1', position, stylePreset, profiles }
  return {
    matched: true,
    decision: {
      schemaVersion: 1, kind: 'media.subtitle-layout-variants', instruction: text,
      source: { path: source, name: portableBasename(source) || path.basename(source) }, subtitle: { path: subtitlePath, name: portableBasename(subtitlePath) }, subtitleLayout,
      output: { container: 'ass', overwrite: false, suffix: '响应式字幕布局' },
      verification: { expectedProfileIds: profiles.map((item) => item.id), maximumLines: 2, requirePixelProof: true }
    }
  }
}

module.exports = { compileSubtitleLayoutDecision, even, resolutionsNear }
