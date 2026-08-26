const fs = require('node:fs')
const path = require('node:path')

const REGIONS = Object.freeze({
  title: { x0: 3, x1: 29, y0: 1, y1: 9 },
  chapters: { x0: 0, x1: 23, y0: 0, y1: 7 },
  person: { x0: 0, x1: 25, y0: 24, y1: 32 },
  corner: { x0: 22, x1: 32, y0: 1, y1: 8 },
  outro: { x0: 4, x1: 28, y0: 9, y1: 25 }
})

function bounded(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, Number(value) || 0)) }
function rounded(value, digits = 4) { return Number(Number(value).toFixed(digits)) }
function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds) * 100))
  const hours = Math.floor(centiseconds / 360000)
  const minutes = Math.floor((centiseconds % 360000) / 6000)
  const secs = Math.floor((centiseconds % 6000) / 100)
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`
}
function escapeAssText(value) { return String(value || '').replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\r?\n/g, '\\N') }

function compileBrandPackageTimeline(brandPackage, durationSeconds) {
  const duration = Number(durationSeconds)
  if (!(duration >= 3)) throw new Error('品牌包装需要至少3秒视频')
  const outroDuration = brandPackage?.outro ? bounded(brandPackage.outro.durationSeconds || 2.2, 1.5, Math.min(3, duration - 1)) : 0
  const outro = brandPackage?.outro ? { startSeconds: rounded(duration - outroDuration, 3), endSeconds: rounded(duration, 3), text: String(brandPackage.outro.text || '') } : null
  const contentEnd = outro ? outro.startSeconds : duration
  const title = brandPackage?.title ? { startSeconds: 0.2, endSeconds: rounded(Math.min(2.8, contentEnd - 0.2), 3), text: String(brandPackage.title.text || '') } : null
  const person = brandPackage?.person ? { startSeconds: 0.7, endSeconds: rounded(Math.min(5, contentEnd - 0.2), 3), ...brandPackage.person } : null
  const corner = brandPackage?.corner ? { startSeconds: 0.1, endSeconds: rounded(contentEnd - 0.1, 3), text: String(brandPackage.corner.text || '') } : null
  if ((title && title.endSeconds <= title.startSeconds) || (person && person.endSeconds <= person.startSeconds) || (corner && corner.endSeconds <= corner.startSeconds)) throw new Error('品牌包装时间线没有足够空间')
  const chapters = (brandPackage?.chapters || []).map((item, index) => {
    const startSeconds = Number(item.atSeconds)
    if (!(startSeconds >= 0.5 && startSeconds <= contentEnd - 0.4)) throw new Error(`第${index + 1}个章节条时间超出正文范围`)
    return { index: index + 1, startSeconds: rounded(startSeconds, 3), endSeconds: rounded(Math.min(startSeconds + 1.8, contentEnd - 0.1), 3), text: String(item.text || '') }
  })
  return { schemaVersion: 1, durationSeconds: rounded(duration, 3), title, chapters, person, corner, outro }
}

function style(name, fontSize, primary, back, alignment, marginL, marginR, marginV, bold = -1) {
  return `Style: ${name},Microsoft YaHei,${fontSize},${primary},&H00FFFFFF,&H00000000,${back},${bold},0,0,0,100,100,0,0,3,2,0,${alignment},${marginL},${marginR},${marginV},1`
}

function buildBrandAssDocument({ brandPackage, timeline, dimensions }) {
  const width = Math.max(320, Number(dimensions?.width) || 1920); const height = Math.max(180, Number(dimensions?.height) || 1080)
  const primary = String(brandPackage.template?.primaryAss || '&H00FFD65A'); const accent = String(brandPackage.template?.accentAss || '&H00FFFFFF'); const back = String(brandPackage.template?.backAss || '&HC0201810')
  const base = Math.max(20, Math.round(height * 0.05)); const margin = Math.max(18, Math.round(Math.min(width, height) * 0.055))
  const styles = [
    style('BrandTitle', Math.round(base * 1.45), primary, back, 8, margin, margin, margin),
    style('BrandChapter', Math.round(base * 0.95), accent, back, 7, margin, margin, Math.round(margin * 1.4)),
    style('BrandPerson', Math.round(base * 0.95), accent, back, 1, margin, margin, Math.round(margin * 1.25)),
    style('BrandCorner', Math.max(16, Math.round(base * 0.72)), primary, back, 9, margin, margin, margin, 0),
    style('BrandOutro', Math.round(base * 1.35), primary, back, 5, margin, margin, margin)
  ].join('\n')
  const events = []
  const event = (start, end, styleName, body) => events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},${styleName},,0,0,0,,{\\fad(160,180)}${body}`)
  if (timeline.title) event(timeline.title.startSeconds, timeline.title.endSeconds, 'BrandTitle', escapeAssText(timeline.title.text))
  timeline.chapters.forEach((item) => event(item.startSeconds, item.endSeconds, 'BrandChapter', `${String(item.index).padStart(2, '0')}  ${escapeAssText(item.text)}`))
  if (timeline.person) event(timeline.person.startSeconds, timeline.person.endSeconds, 'BrandPerson', `${escapeAssText(timeline.person.name)}\\N{\\fs${Math.max(14, Math.round(base * 0.68))}\\b0}${escapeAssText(timeline.person.role)}`)
  if (timeline.corner) event(timeline.corner.startSeconds, timeline.corner.endSeconds, 'BrandCorner', escapeAssText(timeline.corner.text))
  if (timeline.outro) event(timeline.outro.startSeconds, timeline.outro.endSeconds, 'BrandOutro', escapeAssText(timeline.outro.text))
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n${styles}\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${events.join('\n')}\n`
}

function regionDifference(left, right, region) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length < 1024 || right.length < 1024) return 0
  let total = 0; let count = 0
  for (let y = region.y0; y < region.y1; y += 1) for (let x = region.x0; x < region.x1; x += 1) { total += Math.abs(left[y * 32 + x] - right[y * 32 + x]); count += 1 }
  return count ? total / count / 255 : 0
}

function differenceBounds(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length < 1024 || right.length < 1024) return null
  let x0 = 32; let x1 = -1; let y0 = 32; let y1 = -1; let changedPixels = 0
  for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) {
    if (Math.abs(left[y * 32 + x] - right[y * 32 + x]) < 18) continue
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); changedPixels += 1
  }
  return changedPixels ? { x0, x1: x1 + 1, y0, y1: y1 + 1, changedPixels } : null
}

class BrandPackageService {
  constructor({ frames, fsImpl = fs } = {}) {
    if (!frames) throw new Error('品牌包装缺少FFmpeg执行器')
    this.frames = frames; this.fs = fsImpl
  }

  plan(decision, durationSeconds, dimensions) {
    const brandPackage = decision?.brandPackage
    if (decision?.kind !== 'media.visual-effects' || brandPackage?.schemaVersion !== 1 || brandPackage.strategy !== 'ass-brand-package-v1') throw new Error('冻结品牌包装决策无效')
    const required = [brandPackage.title?.text ? 'title' : '', brandPackage.chapters?.length ? 'chapters' : '', brandPackage.person?.name && brandPackage.person?.role ? 'person' : '', brandPackage.corner?.text ? 'corner' : '', brandPackage.outro?.text ? 'outro' : ''].filter(Boolean)
    if (!required.length || JSON.stringify(required) !== JSON.stringify(decision.verification?.expectedBrandElements || [])) throw new Error('品牌包装元素与冻结验证合同不一致')
    return { schemaVersion: 1, strategy: brandPackage.strategy, template: brandPackage.template, requiredElements: required, timeline: compileBrandPackageTimeline(brandPackage, durationSeconds), dimensions: { width: Number(dimensions.width), height: Number(dimensions.height) } }
  }

  async verify({ sourcePath, outputPath, decision, plan, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const output = path.resolve(String(outputPath || ''))
    if (!this.fs.existsSync(output) || this.fs.statSync(output).size <= 1024) throw new Error('品牌包装成果不存在或不完整')
    const duration = await this.frames.probeDuration(output, { signal }); const outputDimensions = await this.frames.probeDimensions(output, { signal })
    const frozen = plan || this.plan(decision, await this.frames.probeDuration(source, { signal }), await this.frames.probeDimensions(source, { signal }))
    if (Math.abs(duration - frozen.timeline.durationSeconds) > 0.2 || Number(outputDimensions?.width) !== frozen.dimensions.width || Number(outputDimensions?.height) !== frozen.dimensions.height) throw new Error('品牌包装成果时长或分辨率与冻结方案不一致')
    const sample = async (kind, seconds) => {
      const [before, after] = await Promise.all([this.frames.readGrayFrame(source, seconds, { signal }), this.frames.readGrayFrame(output, seconds, { signal })])
      const difference = regionDifference(before, after, REGIONS[kind])
      return { seconds: rounded(seconds, 3), region: kind, difference: rounded(difference), changedBounds: differenceBounds(before, after), visible: difference >= 0.004 }
    }
    const requested = new Set(frozen.requiredElements)
    const title = requested.has('title') ? await sample('title', (frozen.timeline.title.startSeconds + frozen.timeline.title.endSeconds) / 2) : { requested: false, visible: false }
    const chapters = []
    for (const item of frozen.timeline.chapters) chapters.push(await sample('chapters', (item.startSeconds + item.endSeconds) / 2))
    const person = requested.has('person') ? await sample('person', (frozen.timeline.person.startSeconds + frozen.timeline.person.endSeconds) / 2) : { requested: false, visible: false }
    const corner = requested.has('corner') ? await sample('corner', Math.min(frozen.timeline.corner.endSeconds - 0.2, Math.max(frozen.timeline.corner.startSeconds + 0.2, frozen.timeline.durationSeconds * 0.55))) : { requested: false, visible: false }
    const outro = requested.has('outro') ? await sample('outro', (frozen.timeline.outro.startSeconds + frozen.timeline.outro.endSeconds) / 2) : { requested: false, visible: false }
    const proof = { schemaVersion: 1, method: 'brand-package-pixel-proof-v1', verdict: 'matched', templateId: frozen.template.id, elements: { title, chapters: { count: chapters.length, visibleCount: chapters.filter((item) => item.visible).length, samples: chapters }, person, corner, outro } }
    if ((requested.has('title') && !title.visible) || (requested.has('chapters') && proof.elements.chapters.visibleCount !== proof.elements.chapters.count) || (requested.has('person') && !person.visible) || (requested.has('corner') && !corner.visible) || (requested.has('outro') && !outro.visible)) throw new Error(`品牌包装像素证明不完整：${JSON.stringify(proof.elements)}`)
    const differences = [title.difference, ...chapters.map((item) => item.difference), person.difference, corner.difference, outro.difference].map(Number).filter(Number.isFinite)
    return { plan: frozen, proof, durationSeconds: duration, outputDimensions, maximumDifference: Math.max(...differences, 0.004) }
  }

  async render({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const output = path.resolve(String(outputPath || ''))
    if (path.resolve(String(decision?.source?.path || '')) !== source || source === output) throw new Error('品牌包装决策与源视频不一致或试图覆盖原片')
    if (!this.fs.existsSync(source) || this.fs.existsSync(output) || !this.frames.availability().available) throw new Error(this.fs.existsSync(output) ? '品牌包装成果已存在，为避免覆盖已停止' : '源视频或FFmpeg不可用')
    const duration = await this.frames.probeDuration(source, { signal }); const dimensions = await this.frames.probeDimensions(source, { signal }); const hasAudio = await this.frames.probeHasAudio(source, { signal })
    if (!(duration > 0) || !(Number(dimensions?.width) > 0) || !(Number(dimensions?.height) > 0)) throw new Error('无法读取品牌包装源视频')
    const plan = this.plan(decision, duration, dimensions); const parsed = path.parse(output)
    const assPath = path.join(parsed.dir, `.${parsed.name}.agentplay-brand-${process.pid}-${Date.now()}.ass`); const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-brand-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    const sourceBefore = this.fs.statSync(source); const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")
    try {
      this.fs.writeFileSync(assPath, buildBrandAssDocument({ brandPackage: decision.brandPackage, timeline: plan.timeline, dimensions: plan.dimensions }), 'utf8')
      await this.frames.run(['-hide_banner', '-nostdin', '-i', source, '-vf', `subtitles='${escapedAss}'`, '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : ['-an']), '-map_metadata', '0', '-map_chapters', '-1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []), '-movflags', '+faststart', '-y', tempPath], { timeoutMs: 60 * 60 * 1000, signal })
      const sourceAfter = this.fs.statSync(source)
      if (sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs) throw new Error('品牌包装期间源视频发生变化')
      const verified = await this.verify({ sourcePath: source, outputPath: tempPath, decision, plan, signal })
      this.fs.renameSync(tempPath, output)
      const representative = [verified.proof.elements.title, ...(verified.proof.elements.chapters.samples || []), verified.proof.elements.person, verified.proof.elements.corner, verified.proof.elements.outro].find((item) => Number.isFinite(Number(item?.seconds)))
      const effectReceipt = { effectKinds: ['brand-package'], inputDurationSeconds: rounded(duration, 3), outputDurationSeconds: rounded(verified.durationSeconds, 3), outputDimensions: { width: Number(verified.outputDimensions.width), height: Number(verified.outputDimensions.height) }, dimensionMatch: true, representativeSample: { sourceSeconds: Number(representative?.seconds || 0), outputSeconds: Number(representative?.seconds || 0), meanAbsDiff: rounded(verified.maximumDifference * 255, 3) }, changed: true }
      const labels = { title: '标题', chapters: `${verified.plan.timeline.chapters.length}个章节条`, person: '人物条', corner: '角标', outro: '片尾' }
      const delivered = verified.plan.requiredElements.map((item) => labels[item]).join('、')
      return { success: true, outputPath: output, outputs: [output], outputBytes: this.fs.statSync(output).size, durationSeconds: verified.durationSeconds, expectedDurationSeconds: duration, effectReceipt, brandPackage: verified.plan, brandPackageProof: verified.proof, timelineReceipt: [{ operation: `品牌包装（${verified.plan.template.label}）`, sourceRange: `0–${rounded(duration, 3)}秒`, outputRange: `0–${rounded(verified.durationSeconds, 3)}秒` }], summary: `已按“${verified.plan.template.label}”完成${delivered}包装；${verified.plan.requiredElements.length}类最终像素证明均通过，原视频未改动` }
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    } finally { if (this.fs.existsSync(assPath)) this.fs.rmSync(assPath, { force: true }) }
  }
}

module.exports = { BrandPackageService, buildBrandAssDocument, compileBrandPackageTimeline, differenceBounds, escapeAssText, regionDifference }
