const path = require('path')

const CONSULTATION_PATTERN = /能不能|可不可以|可以吗|是否|怎么|如何/
const THREE_ASPECT_PATTERN = /(?:16\s*[:：]\s*9[\s\S]{0,40}9\s*[:：]\s*16[\s\S]{0,40}1\s*[:：]\s*1)|(?:横屏[\s\S]{0,30}竖屏[\s\S]{0,30}(?:方形|正方形))|(?:三个|三种|3个|3种)[^，。；]{0,20}(?:比例|画幅|版本)/
const TRACKING_PATTERN = /跟踪|追踪|画面跟着|主体保持|智能构图|自动构图/
const CORRECTION_PATTERN = /(?:改为|改成|换成|重新)(?:跟踪|追踪|聚焦|让画面跟着)/
const MIN_TRACKING_CONFIDENCE = 0.75

function matchesSmartReframeInstruction(instruction) {
  const text = String(instruction || '').trim()
  if (!text || CONSULTATION_PATTERN.test(text)) return false
  return (THREE_ASPECT_PATTERN.test(text) && (TRACKING_PATTERN.test(text) || /自动生成|自动适配/.test(text))) || CORRECTION_PATTERN.test(text)
}

function requestedTrackingSubject(instruction) {
  const text = String(instruction || '').trim()
  const match = /(?:改为|改成|换成|重新)?(?:跟踪|追踪|聚焦(?:于)?|让画面跟着)\s*([^，。；]{2,60})/.exec(text)
  const subject = String(match?.[1] || '').replace(/(?:并)?(?:自动)?(?:生成|导出|制作)[\s\S]*$/, '').replace(/(?:作为|当作)?(?:主要)?主体$/, '').trim()
  return subject || '主要人物或主体'
}

function trackingMoments(durationSeconds) {
  const duration = Number(durationSeconds)
  if (!(duration > 0.5)) throw new Error('视频太短，无法生成主体跟踪证据')
  const start = Math.min(0.2, duration * 0.1)
  const end = Math.max(start, duration - Math.min(0.2, duration * 0.1))
  return Array.from({ length: 5 }, (_, index) => ({ label: `subject-frame-${index + 1}`, seconds: Number((start + (end - start) * index / 4).toFixed(3)) }))
}

function parseTrackingJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('视觉模型没有返回主体框JSON')
  return JSON.parse(raw.slice(start, end + 1))
}

function bounded(value, min, max) { return Math.max(min, Math.min(max, Number(value))) }

function validateTrackingPayload(payload, moments, requestedSubject) {
  const expected = Array.isArray(moments) ? moments : []
  const rawFrames = Array.isArray(payload?.frames) ? payload.frames : []
  const byLabel = new Map(rawFrames.map((item) => [String(item?.label || ''), item]))
  if (expected.length !== 5 || byLabel.size !== expected.length || expected.some((moment) => !byLabel.has(moment.label))) throw new Error('主体跟踪必须覆盖每个关键帧且标签唯一')
  const frames = expected.map((moment) => {
    const raw = byLabel.get(moment.label); const box = raw?.box || {}
    const x = Number(box.x); const y = Number(box.y); const width = Number(box.width); const height = Number(box.height); const confidence = Number(raw?.confidence)
    if (![x, y, width, height, confidence].every(Number.isFinite) || width < 0.02 || height < 0.02 || x < 0 || y < 0 || x + width > 1.001 || y + height > 1.001) throw new Error(`主体框越界或无效：${moment.label}`)
    if (confidence < MIN_TRACKING_CONFIDENCE) throw new Error(`主体跟踪置信度不足：${moment.label}`)
    return { label: moment.label, seconds: moment.seconds, box: { x: Number(bounded(x, 0, 1).toFixed(4)), y: Number(bounded(y, 0, 1).toFixed(4)), width: Number(bounded(width, 0.02, 1).toFixed(4)), height: Number(bounded(height, 0.02, 1).toFixed(4)) }, confidence: Number(bounded(confidence, 0, 1).toFixed(3)) }
  })
  return {
    strategy: 'sampled-subject-boxes-v1', requestedSubject: String(requestedSubject || '主要人物或主体'), observedSubject: String(payload?.observedSubject || '').trim().slice(0, 120),
    minimumConfidence: Number(Math.min(...frames.map((item) => item.confidence)).toFixed(3)), frames
  }
}

function evenFloor(value) { return Math.max(2, Math.floor(Number(value) / 2) * 2) }

function dimensionsForAspect(width, height, aspect) {
  const sourceWidth = evenFloor(width); const sourceHeight = evenFloor(height)
  const [left, right] = aspect.split(':').map(Number); const ratio = left / right
  if (sourceWidth / sourceHeight > ratio) return { width: evenFloor(sourceHeight * ratio), height: sourceHeight }
  return { width: sourceWidth, height: evenFloor(sourceWidth / ratio) }
}

function buildSmartReframeDecision({ instruction, sourcePath, width, height, durationSeconds, tracking, model, correctionOf = null } = {}) {
  const source = path.resolve(String(sourcePath || ''))
  if (!source || !(Number(width) > 0) || !(Number(height) > 0) || !(Number(durationSeconds) > 0) || tracking?.frames?.length !== 5) throw new Error('智能构图决策缺少源视频或主体证据')
  const outputs = [['16:9', '横屏16x9'], ['9:16', '竖屏9x16'], ['1:1', '方形1x1']].map(([aspect, suffix]) => ({ aspect, suffix, ...dimensionsForAspect(width, height, aspect) }))
  return {
    schemaVersion: 1, kind: 'media.smart-reframe', instruction: String(instruction || '').trim(), source: { path: source, name: path.basename(source) },
    reframe: {
      strategy: 'vision-keyframes-linear-follow-v1', subject: { description: tracking.requestedSubject, observed: tracking.observedSubject },
      sourceDimensions: { width: evenFloor(width), height: evenFloor(height) }, durationSeconds: Number(Number(durationSeconds).toFixed(3)),
      tracking: { strategy: tracking.strategy, minimumConfidence: tracking.minimumConfidence, frames: tracking.frames }, outputs,
      model: { providerId: String(model?.providerId || ''), providerName: String(model?.providerName || ''), model: String(model?.model || ''), local: Boolean(model?.local) },
      ...(correctionOf ? { correctionOf } : {})
    },
    output: { container: 'mp4', overwrite: false, suffix: '智能构图' },
    verification: { toleranceSeconds: 0.35, expectedAspects: outputs.map((item) => item.aspect), minimumSubjectCoverage: 0.75 }
  }
}

function buildTrackingPrompt(subject, moments) {
  return [
    `目标对象：${subject}。只定位这个对象，不要把另一个人物或背景当主体。`,
    '每张图片坐标归一化为0到1，左上角是0,0。返回目标对象可见范围的最小外接框；看不清也不得猜，降低confidence。',
    `必须原样覆盖这些标签：${moments.map((item) => item.label).join('、')}。`,
    '只返回JSON：{"observedSubject":"实际看到的目标","frames":[{"label":"subject-frame-1","box":{"x":0.1,"y":0.1,"width":0.3,"height":0.7},"confidence":0.95}]}'
  ].join('\n')
}

class SmartReframePlanner {
  constructor({ frames, subjectAnalyzer = null } = {}) { this.frames = frames; this.subjectAnalyzer = subjectAnalyzer }
  setSubjectAnalyzer(analyzer) { this.subjectAnalyzer = analyzer }

  async plan({ instruction, sourcePath, previousDecision = null, signal } = {}) {
    if (!matchesSmartReframeInstruction(instruction)) return { matched: false }
    if (!this.frames?.availability?.().available || typeof this.frames.readJpegFrame !== 'function') return { matched: true, review: { kind: 'smart-reframe-unavailable', summary: '缺少可用的FFmpeg抽帧能力，不能生成主体跟踪版本。', candidates: [] } }
    if (typeof this.subjectAnalyzer !== 'function') return { matched: true, review: { kind: 'smart-reframe-unavailable', summary: '没有可用的视觉工作模型，不能可靠识别并跟踪主体。', candidates: [] } }
    const durationSeconds = await this.frames.probeDuration(sourcePath, { signal }); const dimensions = await this.frames.probeDimensions(sourcePath, { signal })
    const subject = requestedTrackingSubject(instruction); const moments = trackingMoments(durationSeconds); const images = []
    for (const moment of moments) {
      const data = await this.frames.readJpegFrame(sourcePath, moment.seconds, { signal })
      if (!Buffer.isBuffer(data) || data.length < 4) return { matched: true, review: { kind: 'smart-reframe-unavailable', summary: `第${images.length + 1}张主体关键帧提取失败，未创建跟踪任务。`, candidates: [] } }
      images.push({ label: moment.label, dataUrl: `data:image/jpeg;base64,${data.toString('base64')}` })
    }
    const analysis = await this.subjectAnalyzer({ subject, moments, images, prompt: buildTrackingPrompt(subject, moments), signal })
    if (!analysis?.available) return { matched: true, review: { kind: 'smart-reframe-unavailable', summary: analysis?.reason || '视觉工作模型不可用，未创建跟踪任务。', candidates: [] } }
    try {
      const tracking = validateTrackingPayload(parseTrackingJson(analysis.text), moments, subject)
      const correctionOf = previousDecision?.kind === 'media.smart-reframe' ? { subject: previousDecision.reframe?.subject?.description || '', model: previousDecision.reframe?.model || null } : null
      return { matched: true, decision: buildSmartReframeDecision({ instruction, sourcePath, width: dimensions.width, height: dimensions.height, durationSeconds, tracking, model: analysis.model, correctionOf }) }
    } catch (error) {
      return { matched: true, review: { kind: 'smart-reframe-review', summary: `主体跟踪证据不足，未执行：${error instanceof Error ? error.message : String(error)}`, candidates: [] } }
    }
  }
}

module.exports = { MIN_TRACKING_CONFIDENCE, SmartReframePlanner, buildSmartReframeDecision, buildTrackingPrompt, dimensionsForAspect, matchesSmartReframeInstruction, parseTrackingJson, requestedTrackingSubject, trackingMoments, validateTrackingPayload }
