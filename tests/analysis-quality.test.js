const assert = require('node:assert/strict')
const test = require('node:test')

const {
  buildEvidenceAnalysis,
  evaluateAnalysisQuality,
  evaluateProfessionalAnalysisQuality,
  isUnderpoweredLocalAnalysisModel
} = require('../electron/analysis-quality-policy')

const garbage = `## 叙事结构
Building the most comprehensive profile of your company that you have ever seen. Just like a teammate, Lindy joins your meetings and continuously learns from them.
信息密度：0
时长：00:01:34 / 镜头：00:01:34 / 节奏：00:01:34 / 二次创作建议
时长：00:01:34 / 镜头：00:01:34 / 节奏：00:01:34 / 二次创作建议
时长：00:01:34 / 镜头：00:01:34 / 节奏：00:01:34 / 二次创作建议`

const cues = [
  { start: 0, end: 30, text: 'Hi, this is Flo from Lindy. Today we kill the AI agent and introduce the AI employee.' },
  { start: 30, end: 60, text: 'Building the most comprehensive profile of your company. Lindy joins meetings and continuously learns.' },
  { start: 60, end: 90, text: 'Unlike a teammate, Lindy can be in hundreds of meetings at the same time.' },
  { start: 90, end: 94, text: 'Then you can build dashboards in seconds.' }
]

const translatedCues = [
  { start: 0, end: 30, text: '今天我们不再把它称为 AI 智能体，而是介绍 AI 员工。' },
  { start: 30, end: 60, text: '它会建立完整的公司资料，加入会议并持续学习。' },
  { start: 60, end: 90, text: '与普通队友不同，它可以同时参加数百场会议。' },
  { start: 90, end: 94, text: '最后可以在几秒内建立仪表板。' }
]

test('quality gate rejects the actual failure pattern: English-dominant, repeated and zero-density', () => {
  const result = evaluateAnalysisQuality(garbage, { outputLanguage: 'zh-CN' })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => /中文|英文/.test(reason)))
  assert.ok(result.reasons.some((reason) => /重复/.test(reason)))
  assert.ok(result.reasons.some((reason) => /信息密度/.test(reason)))
})

test('deep-analysis quality gate rejects a shallow Chinese paragraph without structure or actions', () => {
  const result = evaluateAnalysisQuality('## 叙事结构\n这个视频讲了一个产品，开场不错。', {
    outputLanguage: 'zh-CN',
    requireDeepStructure: true
  })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => /结构|篇幅|建议/.test(reason)))
})

test('professional contract rejects the old many-section report even when it is long', () => {
  const text = `${'这是为了凑足篇幅的普通中文说明。'.repeat(40)}\n## 一句话定位\n内容\n## 钩子拆解\n内容\n## 镜头与节奏\n00:00 内容\n## 结构时间轴\n00:10 内容\n## 二次创作建议\n建议`
  const result = evaluateProfessionalAnalysisQuality(text, { duration: 12, hasVisualEvidence: true })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => /正好两个部分/.test(reason)))
})

test('professional contract requires full-timeline evidence and complete production analysis', () => {
  const text = [
    '## 第一部分　视频讲了什么',
    '### 内容精华',
    '这是内容摘要。'.repeat(45),
    '### 结构时间轴',
    '- 00:00：开场。',
    '## 第二部分　专业视听拆解与 AI 复刻',
    '### 摄影',
    '使用固定机位。'.repeat(35),
    '### AI 复刻',
    '建议重新制作。'
  ].join('\n')
  const result = evaluateProfessionalAnalysisQuality(text, { duration: 94, hasVisualEvidence: true })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => /时间轴.*全片/.test(reason)))
  assert.ok(result.reasons.some((reason) => /灯光|声音|剪辑/.test(reason)))
})

test('evidence fallback produces a Chinese, non-repeating and actionable report', () => {
  const text = buildEvidenceAnalysis({
    mediaName: 'Today, we kill the AI agent and introduce the AI employee',
    duration: 94,
    cues,
    translatedCues,
    frameCount: 0
  })
  assert.match(text, /## 第一部分　视频讲了什么/)
  assert.match(text, /### 一句话精华/)
  assert.match(text, /### 全片结构时间轴/)
  assert.match(text, /## 第二部分　专业视听拆解与 AI 复刻/)
  assert.match(text, /### AI 复刻执行方案/)
  assert.match(text, /源字幕为英文/)
  assert.match(text, /00:00:00/)
  assert.doesNotMatch(text, /信息密度：0/)
  assert.doesNotMatch(text, /镜头：00:01:34/)
  assert.ok((text.match(/[\u3400-\u9fff]/g) || []).length > (text.match(/[A-Za-z]/g) || []).length)
  assert.equal(evaluateAnalysisQuality(text, { outputLanguage: 'zh-CN' }).ok, true)
})

test('bundled half-billion local model is never promoted to deep-analysis authority', () => {
  assert.equal(isUnderpoweredLocalAnalysisModel({ local: true, model: 'ai-player-qwen2.5-0.5b' }), true)
  assert.equal(isUnderpoweredLocalAnalysisModel({ local: true, model: 'qwen2.5:7b' }), false)
  assert.equal(isUnderpoweredLocalAnalysisModel({ local: false, model: 'agnes-2.5-flash' }), false)
})

test('legacy and persistent deep analysis both plan an eligible route instead of silently taking a stashed cloud config', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const downloadAnalysis = main.slice(main.indexOf('// 拉片解剖（自动读取同名字幕证据）'), main.indexOf("ipcMain.handle('media:download-detect'"))
  const chatAnalysis = main.slice(main.indexOf('const preparePersistentAnalysisTask'), main.indexOf("persistentTaskRuntime.register('download.direct'"))
  assert.match(downloadAnalysis, /selectModelForTaskPlan\(\{ taskKind: 'analysis-vision', requirements: \{ vision: true \} \}\)/)
  assert.match(downloadAnalysis, /const config = visionDecision\.selected \|\| textDecision\?\.selected \|\| null/)
  assert.doesNotMatch(downloadAnalysis, /const config = creativeConfig\(\)/)
  assert.match(chatAnalysis, /selectModelForTaskPlan\(\{ taskKind: 'analysis-vision', requirements: \{ vision: true \} \}\)/)
  assert.match(chatAnalysis, /freezeTaskModelRoute\(config, \{ taskKind:/)
  assert.doesNotMatch(chatAnalysis, /const config = creativeConfig\(\)/)
})
