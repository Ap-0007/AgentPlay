const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  buildAnalysisReport,
  buildDeepAnalysisPrompt,
  buildVisionAnalysisPrompt,
  detectAnalysisIntent,
  resolveAnalysisOutput,
  runChatAnalysis
} = require('../electron/analysis-chat-service')
const { DocumentWorkspaceService } = require('../electron/document-workspace-service')

function makeWorkspace(root) {
  return new DocumentWorkspaceService({
    outputRoot: path.join(root, '输出'),
    historyRoot: path.join(root, 'history')
  })
}

function makeVideoWithSubtitle(root) {
  const videoPath = path.join(root, '样片.mp4')
  fs.writeFileSync(videoPath, Buffer.from('fake-video-bytes'))
  fs.writeFileSync(path.join(root, '样片.srt'), [
    '1', '00:00:01,000 --> 00:00:04,000', '开场钩子：今天讲三个重点', '',
    '2', '00:00:05,000 --> 00:00:09,000', '第一点，数据增长了百分之四十', ''
  ].join('\n'), 'utf8')
  return videoPath
}

test('analysis intent matches video breakdown phrases only', () => {
  for (const text of ['拉片这个视频', '深度解剖一下', '分析这个视频并出报告', '拆解当前视频', '镜头分析', 'analyze this video']) {
    assert.equal(detectAnalysisIntent(text), true, text)
  }
  for (const text of ['暂停播放', '你好', '分析这个文档', '把附件整理成 Word', '生成双语字幕']) {
    assert.equal(detectAnalysisIntent(text), false, text)
  }
})

test('analysis output format resolves from instruction, defaulting to docx', () => {
  assert.equal(resolveAnalysisOutput('深度解剖，输出 PDF'), 'pdf')
  assert.equal(resolveAnalysisOutput('拉片并做成PPT汇报'), 'pptx')
  assert.equal(resolveAnalysisOutput('解剖后存成 markdown'), 'md')
  assert.equal(resolveAnalysisOutput('解剖后存成md'), 'md')
  assert.equal(resolveAnalysisOutput('出一份纯文本'), 'txt')
  assert.equal(resolveAnalysisOutput('深度解剖这个视频'), 'docx')
})

test('deep analysis prompt carries evidence and no-fabrication rule', () => {
  const { systemPrompt, prompt } = buildDeepAnalysisPrompt({
    mediaName: '样片.mp4', duration: 65, instruction: '重点看开场钩子',
    offlineDraft: '# 底稿', transcript: '开场钩子：今天讲三个重点'
  })
  assert.match(systemPrompt, /不得编造/)
  assert.match(prompt, /样片\.mp4/)
  assert.match(prompt, /00:01:05/)
  assert.match(prompt, /重点看开场钩子/)
  assert.match(prompt, /开场钩子：今天讲三个重点/)
  assert.match(prompt, /缺少画面证据/)
})

test('vision prompt carries frame evidence contract and breakdown sections', () => {
  const { systemPrompt, prompt } = buildVisionAnalysisPrompt({
    mediaName: '样片.mp4', duration: 65, instruction: '拆钩子', offlineDraft: '# 底稿', transcript: '开场白', frameCount: 12
  })
  assert.match(systemPrompt, /只能依据画面/)
  assert.match(systemPrompt, /不得编造/)
  assert.match(prompt, /12 张关键帧/)
  assert.match(prompt, /t=MM:SS/)
  assert.match(prompt, /## 钩子拆解/)
  assert.match(prompt, /## 镜头与节奏/)
  assert.match(prompt, /## 营销话术剥离/)
})

function makeFrames(root, labels = ['t=00:01', 't=00:08']) {
  const dir = path.join(root, 'frames-tmp')
  fs.mkdirSync(dir, { recursive: true })
  const shots = labels.map((label, i) => {
    const file = path.join(dir, `f${i}.jpg`)
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, i]))
    return { path: file, tSec: i * 7, label }
  })
  return { extract: async () => shots }
}

test('chat analysis sends frames to vision model and reports multimodal evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  const seen = {}
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖这个视频', outputFormat: 'md', cloudApproved: true,
    workspace: makeWorkspace(root),
    model: { configured: true, local: false, provider: '火山引擎', model: 'doubao-vision' },
    frames: makeFrames(root),
    completeVisionMulti: async ({ systemPrompt, prompt, images }) => {
      seen.systemPrompt = systemPrompt
      seen.prompt = prompt
      seen.images = images
      return { text: '## 钩子拆解\n首帧大字标题抓人。' }
    },
    complete: async () => { throw new Error('不应退回纯文本') }
  })
  assert.equal(result.success, true)
  assert.equal(result.frameCount, 2)
  assert.equal(seen.images.length, 2)
  assert.equal(seen.images[0].label, 't=00:01')
  assert.match(seen.images[0].dataUrl, /^data:image\/jpeg;base64,/)
  assert.match(seen.prompt, /## 钩子拆解/)
  const content = fs.readFileSync(result.outputs[0], 'utf8')
  assert.match(content, /多模态拉片（画面关键帧＋字幕）/)
  assert.match(content, /关键帧 2 张/)
  assert.match(content, /首帧大字标题抓人。/)
  assert.match(result.summary, /多模态拉片/)
})

test('chat analysis degrades honestly when model rejects images', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  let textCalled = 0
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖这个视频', outputFormat: 'md', cloudApproved: true,
    workspace: makeWorkspace(root),
    model: { configured: true, local: false, provider: 'p', model: 'm' },
    frames: makeFrames(root),
    completeVisionMulti: async () => { throw new Error('视觉模型 API 400: invalid image content: unsupported') },
    complete: async () => { textCalled += 1; return { text: '## 叙事结构\n纯字幕结论。' } }
  })
  assert.equal(result.success, true)
  assert.equal(textCalled, 1)
  assert.equal(result.frameCount, 0)
  assert.match(result.visionNote, /不支持图片输入/)
  assert.match(result.summary, /不支持图片输入/)
  const content = fs.readFileSync(result.outputs[0], 'utf8')
  assert.match(content, /画面降级说明/)
  assert.match(content, /纯字幕结论。/)
})

test('chat analysis propagates non-image vision errors instead of masking them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  await assert.rejects(
    runChatAnalysis({
      sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
      instruction: '深度解剖这个视频', outputFormat: 'md', cloudApproved: true,
      workspace: makeWorkspace(root),
      model: { configured: true, local: false, provider: 'p', model: 'm' },
      frames: makeFrames(root),
      completeVisionMulti: async () => { throw new Error('connect ETIMEDOUT') },
      complete: async () => ({ text: 'x' })
    }),
    /ETIMEDOUT/
  )
})

test('local model skips frames entirely and uses text path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  let extractCalled = 0
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖这个视频', outputFormat: 'md',
    workspace: makeWorkspace(root),
    model: { configured: true, local: true, provider: '内置', model: 'qwen' },
    frames: { extract: async () => { extractCalled += 1; return [] } },
    complete: async () => ({ text: '## 叙事结构\n本地结论。' })
  })
  assert.equal(result.success, true)
  assert.equal(extractCalled, 0)
})

test('analysis report embeds AI text with offline draft appendix', () => {
  const withAi = buildAnalysisReport({
    mediaName: '样片.mp4', duration: 65, cueCount: 2,
    provider: '火山引擎', model: 'doubao-pro', aiText: '## 叙事结构\n结论', offlineDraft: '# 底稿'
  })
  assert.match(withAi, /AI 深度解剖/)
  assert.match(withAi, /火山引擎 \/ doubao-pro/)
  assert.match(withAi, /附录：离线结构底稿/)
  const offlineOnly = buildAnalysisReport({ mediaName: '样片.mp4', duration: 65, cueCount: 2, aiText: '', offlineDraft: '# 底稿' })
  assert.match(offlineOnly, /未配置模型/)
  assert.doesNotMatch(offlineOnly, /附录/)
})

test('chat analysis runs offline end-to-end and writes report next to source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖这个视频，存成md', outputFormat: 'auto',
    workspace: makeWorkspace(root), model: { configured: false }
  })
  assert.equal(result.success, true)
  assert.equal(result.usedAi, false)
  assert.equal(result.cueCount, 2)
  assert.equal(result.outputs.length, 1)
  const output = result.outputs[0]
  assert.equal(path.dirname(output), root)
  assert.match(path.basename(output), /样片-AgentPlay处理版.*\.md$/)
  const content = fs.readFileSync(output, 'utf8')
  assert.match(content, /离线结构底稿/)
  assert.match(content, /数据增长了百分之四十/)
  const history = fs.readFileSync(path.join(root, 'history', 'history.jsonl'), 'utf8')
  assert.match(history, /video-analysis/)
  assert.equal(fs.readFileSync(videoPath).toString(), 'fake-video-bytes')
})

test('chat analysis gates cloud model behind explicit approval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  let completeCalled = 0
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖这个视频', outputFormat: 'md', cloudApproved: false,
    workspace: makeWorkspace(root), model: { configured: true, local: false, provider: 'p', model: 'm' },
    complete: async () => { completeCalled += 1; return { text: '' } }
  })
  assert.equal(result.success, false)
  assert.equal(result.requiresApproval, true)
  assert.equal(completeCalled, 0)
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('处理版')), [])
})

test('chat analysis runs AI pass after approval and embeds provider line', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  const statuses = []
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖这个视频', outputFormat: 'md', cloudApproved: true,
    onStatus: (status) => statuses.push(status),
    workspace: makeWorkspace(root), model: { configured: true, local: false, provider: '火山引擎', model: 'doubao-pro' },
    complete: async ({ systemPrompt, prompt }) => {
      assert.match(systemPrompt, /不得编造/)
      assert.match(prompt, /字幕正文/)
      return { text: '## 叙事结构\n开场钩子有效。' }
    }
  })
  assert.equal(result.success, true)
  assert.equal(result.usedAi, true)
  const content = fs.readFileSync(result.outputs[0], 'utf8')
  assert.match(content, /AI 深度解剖/)
  assert.match(content, /火山引擎 \/ doubao-pro/)
  assert.match(content, /开场钩子有效。/)
  assert.ok(statuses.some((status) => status.includes('深度解剖')))
})

test('chat analysis rejects network sources and non-video files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  await assert.rejects(
    runChatAnalysis({ sourcePath: 'https://example.com/a.mp4', workspace: makeWorkspace(root), model: {} }),
    /本地视频/
  )
  const textPath = path.join(root, 'notes.txt')
  fs.writeFileSync(textPath, 'hello', 'utf8')
  await assert.rejects(
    runChatAnalysis({ sourcePath: textPath, workspace: makeWorkspace(root), model: {} }),
    /不是可解剖的视频/
  )
  await assert.rejects(
    runChatAnalysis({ sourcePath: path.join(root, 'missing.mp4'), workspace: makeWorkspace(root), model: {} }),
    /不存在/
  )
})
