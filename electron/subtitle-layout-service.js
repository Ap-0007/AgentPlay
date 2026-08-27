const fs = require('node:fs')
const path = require('node:path')
const { parseSrt, parseSrtTimestamp } = require('./subtitle-bilingual-service')
const { bandComplexity } = require('./professional-subtitle-service')

function rounded(value, digits = 4) { return Number(Number(value).toFixed(digits)) }
function textUnits(value) { return [...String(value || '')].reduce((sum, char) => sum + (/[一-鿿぀-ヿ가-힯]/.test(char) ? 1 : /\s/.test(char) ? 0.3 : 0.55), 0) }
function reflowCueText(value, { maximumUnitsPerLine, maximumLines = 2 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim(); const limit = Number(maximumUnitsPerLine)
  if (!text || !(limit >= 6) || maximumLines !== 2) throw new Error('字幕断句参数无效')
  if (textUnits(text) <= limit) return { lines: [text], units: [rounded(textUnits(text), 2)] }
  if (textUnits(text) > limit * maximumLines) throw new Error(`字幕“${text.slice(0, 30)}”超过两行容量，请先拆分字幕并给出真实秒点`)
  const candidates = []
  for (let index = 1; index < text.length; index += 1) {
    const previous = text[index - 1]; const next = text[index]
    if (/\s|[，。！？；：、,.!?;:]/.test(previous) || /\s/.test(next)) candidates.push(index)
  }
  const target = textUnits(text) / 2
  let best = null
  for (const index of candidates) {
    const left = text.slice(0, index).trim(); const right = text.slice(index).trim(); const leftUnits = textUnits(left); const rightUnits = textUnits(right)
    if (!left || !right || leftUnits > limit || rightUnits > limit) continue
    const score = Math.abs(leftUnits - target) + Math.abs(rightUnits - target)
    if (!best || score < best.score) best = { lines: [left, right], units: [rounded(leftUnits, 2), rounded(rightUnits, 2)], score }
  }
  if (!best) {
    let split = 1
    for (let index = 1; index < text.length; index += 1) if (textUnits(text.slice(0, index)) <= limit) split = index
    const left = text.slice(0, split).trim(); const right = text.slice(split).trim()
    if (!left || !right || textUnits(right) > limit) throw new Error(`字幕“${text.slice(0, 30)}”无法在两行内自然断句，请先拆分`)
    best = { lines: [left, right], units: [rounded(textUnits(left), 2), rounded(textUnits(right), 2)] }
  }
  return { lines: best.lines, units: best.units }
}

function assTime(seconds) { const cs = Math.max(0, Math.round(Number(seconds) * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs % 360000 / 6000)).padStart(2, '0')}:${String(Math.floor(cs % 6000 / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}` }
function escapeAss(value) { return String(value || '').replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝') }
function profileGeometry(profile, stylePreset, zone) {
  const minimum = Math.min(Number(profile.width), Number(profile.height)); const fontSize = Math.max(18, Math.round(minimum * 0.052)); const fontRatio = fontSize / minimum
  const maximumUnitsPerLine = Math.max(10, Math.floor(Number(profile.width) / fontSize)); const alignment = zone === 'top' ? 8 : zone === 'middle' ? 5 : 2
  const marginV = zone === 'middle' ? 20 : Math.round(Number(profile.height) * (profile.aspect === '9:16' ? 0.14 : profile.aspect === '1:1' ? 0.11 : 0.09))
  const presets = { clean: { primary: '&H00FFFFFF', back: '&H78000000', border: 1 }, impact: { primary: '&H004DFFFF', back: '&HC0101010', border: 3 }, documentary: { primary: '&H00FFFFFF', back: '&HA0181818', border: 3 } }; const preset = presets[stylePreset] || presets.clean
  return { fontSize, fontRatio, maximumUnitsPerLine, alignment, marginV, preset }
}
function buildResponsiveAss({ entries, profile, stylePreset, zone }) {
  const geometry = profileGeometry(profile, stylePreset, zone); let maximumObservedLines = 0; const reflow = []
  const dialogues = entries.map((entry) => {
    const wrapped = reflowCueText(entry.text, { maximumUnitsPerLine: geometry.maximumUnitsPerLine, maximumLines: 2 }); maximumObservedLines = Math.max(maximumObservedLines, wrapped.lines.length); reflow.push({ index: entry.index, lines: wrapped.lines, units: wrapped.units })
    return `Dialogue: 0,${assTime(entry.startSeconds)},${assTime(entry.endSeconds)},Layout,,0,0,0,,${wrapped.lines.map(escapeAss).join('\\N')}`
  }).join('\n')
  const marginH = Math.max(20, Math.round(profile.width * 0.06)); const style = `Style: Layout,Microsoft YaHei,${geometry.fontSize},${geometry.preset.primary},&H00FFFFFF,&H00000000,${geometry.preset.back},-1,0,0,0,100,100,0,0,${geometry.preset.border},2,0,${geometry.alignment},${marginH},${marginH},${geometry.marginV},1`
  const content = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${profile.width}\nPlayResY: ${profile.height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n${style}\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${dialogues}\n`
  return { content, geometry, maximumObservedLines, reflow }
}
function zoneDifference(left, right, zone) { const ranges = { top: [2, 10], middle: [12, 20], bottom: [22, 30] }; const [start, end] = ranges[zone] || ranges.bottom; let sum = 0; let count = 0; for (let y = start; y < end; y += 1) for (let x = 0; x < 32; x += 1) { sum += Math.abs(left[y * 32 + x] - right[y * 32 + x]); count += 1 } return count ? sum / count / 255 : 0 }

class SubtitleLayoutService {
  constructor({ frames, fsImpl = fs } = {}) { if (!frames) throw new Error('字幕布局服务缺少FFmpeg执行器'); this.frames = frames; this.fs = fsImpl }
  entries(subtitlePath) { const entries = parseSrt(this.fs.readFileSync(subtitlePath, 'utf8')).map((entry) => ({ index: entry.index, startSeconds: parseSrtTimestamp(entry.start), endSeconds: parseSrtTimestamp(entry.end), text: entry.text })).filter((entry) => entry.endSeconds > entry.startSeconds && entry.text); if (!entries.length) throw new Error('字幕布局输入没有有效SRT条目'); return entries }
  async profileProof({ source, output, profile, entries, decision, tempRoot, signal }) {
    const sampleSeconds = (entries[0].startSeconds + entries[0].endSeconds) / 2; const scaleCrop = `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height}`
    const basePath = `${tempRoot}-${profile.id}-base.png`; const overlayPath = `${tempRoot}-${profile.id}-overlay.png`; const escaped = output.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")
    try {
      await this.frames.run(['-hide_banner', '-nostdin', '-ss', sampleSeconds.toFixed(3), '-i', source, '-vf', scaleCrop, '-frames:v', '1', '-y', basePath], { timeoutMs: 120000, signal })
      const baseFrame = await this.frames.readGrayFrame(basePath, 0, { signal }); const top = bandComplexity(baseFrame, 'top'); const bottom = bandComplexity(baseFrame, 'bottom')
      const requested = decision.subtitleLayout.position; const zone = requested === 'top' || requested === 'middle' || requested === 'bottom' ? requested : top + 0.02 < bottom ? 'top' : 'bottom'
      const built = buildResponsiveAss({ entries, profile, stylePreset: decision.subtitleLayout.stylePreset, zone })
      const current = this.fs.readFileSync(output, 'utf8'); if (current !== built.content) throw new Error(`${profile.label}布局文件与冻结断句或位置不一致`)
      await this.frames.run(['-hide_banner', '-nostdin', '-ss', sampleSeconds.toFixed(3), '-i', source, '-vf', `${scaleCrop},setpts=PTS+${sampleSeconds.toFixed(3)}/TB,subtitles='${escaped}'`, '-frames:v', '1', '-y', overlayPath], { timeoutMs: 120000, signal })
      const overlayFrame = await this.frames.readGrayFrame(overlayPath, 0, { signal }); const pixelDifference = zoneDifference(baseFrame, overlayFrame, zone)
      const chosenComplexity = zone === 'top' ? top : zone === 'bottom' ? bottom : Math.min(top, bottom); const oppositeComplexity = zone === 'top' ? bottom : top
      return { id: profile.id, aspect: profile.aspect, width: profile.width, height: profile.height, zone, fontSize: built.geometry.fontSize, fontRatio: rounded(built.geometry.fontRatio), maximumUnitsPerLine: built.geometry.maximumUnitsPerLine, maximumObservedLines: built.maximumObservedLines, wrappingMatched: built.reflow.every((item) => item.lines.length <= 2 && item.units.every((units) => units <= built.geometry.maximumUnitsPerLine + 0.01)), occlusionSafe: requested === 'auto' ? chosenComplexity <= oppositeComplexity + 0.02 : true, positionMatched: pixelDifference >= 0.004, pixelDifference: rounded(pixelDifference), sampledCueIndex: entries[0].index }
    } finally { for (const item of [basePath, overlayPath]) if (this.fs.existsSync(item)) this.fs.rmSync(item, { force: true }) }
  }
  async verifyLayouts({ sourcePath, subtitlePath, outputPaths, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const subtitle = path.resolve(String(subtitlePath || '')); const outputs = outputPaths.map((item) => path.resolve(String(item || ''))); const profiles = decision?.subtitleLayout?.profiles || []
    if (decision?.kind !== 'media.subtitle-layout-variants' || decision.subtitleLayout?.strategy !== 'responsive-ass-layout-v1' || profiles.length !== outputs.length || JSON.stringify(profiles.map((item) => item.id)) !== JSON.stringify(decision.verification?.expectedProfileIds || [])) throw new Error('响应式字幕布局冻结合同无效')
    const entries = this.entries(subtitle); const tempRoot = path.join(path.dirname(outputs[0]), `.agentplay-layout-proof-${process.pid}-${Date.now()}`); const proofs = []
    for (let index = 0; index < profiles.length; index += 1) { if (!this.fs.existsSync(outputs[index]) || this.fs.statSync(outputs[index]).size <= 0) throw new Error(`缺少${profiles[index].label}布局成果`); proofs.push(await this.profileProof({ source, output: outputs[index], profile: profiles[index], entries, decision, tempRoot, signal })) }
    if (proofs.some((item) => !(item.fontRatio >= 0.045 && item.fontRatio <= 0.06) || item.maximumObservedLines > 2 || !item.wrappingMatched || !item.occlusionSafe || !item.positionMatched)) throw new Error(`字幕布局五维证明失败：${JSON.stringify(proofs)}`)
    return { schemaVersion: 1, method: 'subtitle-layout-pixel-proof-v1', verdict: 'matched', profiles: proofs }
  }
  async exportLayouts({ sourcePath, subtitlePath, outputPaths, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const subtitle = path.resolve(String(subtitlePath || '')); const outputs = outputPaths.map((item) => path.resolve(String(item || ''))); const profiles = decision?.subtitleLayout?.profiles || []
    if (path.resolve(String(decision?.source?.path || '')) !== source || path.resolve(String(decision?.subtitle?.path || '')) !== subtitle || profiles.length !== outputs.length || new Set(outputs).size !== outputs.length || outputs.some((item) => item === source || item === subtitle)) throw new Error('字幕布局源文件或成果路径无效')
    if (!this.fs.existsSync(source) || !this.fs.existsSync(subtitle) || !this.frames.availability().available) throw new Error('视频、字幕或FFmpeg不可用')
    const entries = this.entries(subtitle); const sourceBefore = this.fs.statSync(source); const subtitleBefore = this.fs.statSync(subtitle)
    try {
      for (let index = 0; index < profiles.length; index += 1) {
        const profile = profiles[index]; const sampleSeconds = (entries[0].startSeconds + entries[0].endSeconds) / 2; const basePath = `${outputs[index]}.layout-base-${process.pid}.png`; const scaleCrop = `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height}`
        try {
          if (this.fs.existsSync(outputs[index])) continue
          await this.frames.run(['-hide_banner', '-nostdin', '-ss', sampleSeconds.toFixed(3), '-i', source, '-vf', scaleCrop, '-frames:v', '1', '-y', basePath], { timeoutMs: 120000, signal })
          const frame = await this.frames.readGrayFrame(basePath, 0, { signal }); const top = bandComplexity(frame, 'top'); const bottom = bandComplexity(frame, 'bottom'); const requested = decision.subtitleLayout.position; const zone = requested === 'top' || requested === 'middle' || requested === 'bottom' ? requested : top + 0.02 < bottom ? 'top' : 'bottom'; const built = buildResponsiveAss({ entries, profile, stylePreset: decision.subtitleLayout.stylePreset, zone }); const temp = `${outputs[index]}.${process.pid}.tmp`; this.fs.writeFileSync(temp, built.content, 'utf8'); this.fs.renameSync(temp, outputs[index])
        } finally { if (this.fs.existsSync(basePath)) this.fs.rmSync(basePath, { force: true }) }
      }
      const sourceAfter = this.fs.statSync(source); const subtitleAfter = this.fs.statSync(subtitle); if (sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs || subtitleBefore.size !== subtitleAfter.size || subtitleBefore.mtimeMs !== subtitleAfter.mtimeMs) throw new Error('字幕布局导出期间源文件发生变化')
      const layoutProof = await this.verifyLayouts({ sourcePath: source, subtitlePath: subtitle, outputPaths: outputs, decision, signal })
      return { success: true, outputPath: outputs[0], outputs, profileCount: profiles.length, layoutProof, summary: `已生成${profiles.length}个响应式ASS字幕布局；每个画幅均通过字号、两行上限、断句、遮挡和位置像素验证，原视频与字幕未改动` }
    } catch (error) { for (const output of outputs) if (this.fs.existsSync(output)) this.fs.rmSync(output, { force: true }); throw error }
  }
}

module.exports = { SubtitleLayoutService, buildResponsiveAss, profileGeometry, reflowCueText, textUnits, zoneDifference }
