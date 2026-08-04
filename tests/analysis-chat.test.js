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
    completeVisionMulti: async ({ systemPrompt, prompt, images, timeoutMs }) => {
      seen.systemPrompt = systemPrompt
      seen.prompt = prompt
      seen.images = images
      seen.timeoutMs = timeoutMs
      return { text: '## 钩子拆解\n首帧大字标题抓人。' }
    },
    complete: async () => { throw new Error('不应退回纯文本') }
  })
  assert.equal(result.success, true)
  assert.equal(result.frameCount, 2)
  assert.equal(seen.timeoutMs, 300000, '视觉调用必须放宽到 300 秒（实测端点需要约 187 秒）')
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

test('vision timeout propagates fast instead of paying a second text round', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  let textCalled = 0
  await assert.rejects(
    runChatAnalysis({
      sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
      instruction: '深度解剖这个视频', outputFormat: 'md', cloudApproved: true,
      workspace: makeWorkspace(root),
      model: { configured: true, local: false, provider: 'p', model: 'm' },
      frames: makeFrames(root),
      completeVisionMulti: async () => { throw new Error('图片理解超时') },
      complete: async () => { textCalled += 1; return { text: 'x' } }
    }),
    /图片理解超时/
  )
  assert.equal(textCalled, 0, '超时不得再触发纯文本兜底')
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

test('main process vision wrappers always forward the resolved model config', () => {
  // 漏传 config 会落到引擎默认端点（无图能力 400），被误判为"模型不收图"——07-29 实踩
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  // creativeConfig：非 cli 时即 resolved('chat')（等价），cli 时回退 stash 云端视觉（护栏）
  assert.match(main, /llmCompleteVisionMulti = async[\s\S]{0,400}?creativeConfig\(\)[\s\S]{0,400}?apiKey: config/)
  assert.match(main, /completeVision\(\{[\s\S]{0,200}?apiKey: config/)
})

test('missing duration is probed via ffprobe so reports never show 00:00:00', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 0,
    instruction: '深度解剖这个视频', outputFormat: 'md',
    workspace: makeWorkspace(root),
    model: { configured: false },
    frames: { probeDuration: async () => 156, extract: async () => [] }
  })
  assert.equal(result.success, true)
  const content = fs.readFileSync(result.outputs[0], 'utf8')
  assert.match(content, /00:02:36/)
  assert.doesNotMatch(content, /00:00:00/)
})

test('agnes vision fallback: multimodal-unsupported model retries with agnes-2.0-flash', async () => {
  const { AgentEngine } = require('../electron/llm-service')
  const engine = new AgentEngine(null)
  const calls = []
  engine.completeVisionMultiOnce = async (options) => {
    calls.push(options.apiKey.model)
    if (calls.length === 1) throw new Error('[API 错误 504] multimodal unsupported')
    return { text: '视觉回答' }
  }
  const result = await engine.completeVisionMulti({
    prompt: '看图', imageDataUrls: ['data:image/png;base64,AAAA'], labels: ['t=00:01'],
    apiKey: { providerId: 'agnes', model: 'agnes-2.5-flash', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'k' }
  })
  assert.equal(result.text, '视觉回答')
  assert.deepEqual(calls, ['agnes-2.5-flash', 'agnes-2.0-flash'], '必须先试原型号，504 后回退 2.0-flash')

  // 非 agnes 厂商不做回退
  engine.completeVisionMultiOnce = async () => { throw new Error('[API 错误 504] multimodal unsupported') }
  await assert.rejects(() => engine.completeVisionMulti({
    prompt: '看图', imageDataUrls: ['data:image/png;base64,AAAA'],
    apiKey: { providerId: 'volcengine', model: 'doubao-x', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'k' }
  }), /504/)
})

test('safeFetch tolerates VPN fake-ip placeholder but still refuses real protected/polluted addresses', async () => {
  const { safeFetch } = require('../electron/safe-fetch')
  const config = { providerId: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'k' }
  let fetched = false
  const fakeFetch = async () => { fetched = true; return { ok: true, status: 200, text: async () => '{}' } }
  // 全部 fake-ip（sing-box 占位）：放行，连接按域名交给 VPN 路由
  await safeFetch(config, 'https://apihub.agnes-ai.com/v1/chat/completions', {}, {
    dnsLookup: async () => [{ address: '198.18.2.235' }],
    fetchImpl: fakeFetch
  })
  assert.ok(fetched, 'fake-ip 全占位必须放行')
  // 真实保护地址：仍拒绝
  await assert.rejects(() => safeFetch(config, 'https://apihub.agnes-ai.com/v1/chat/completions', {}, {
    dnsLookup: async () => [{ address: '10.0.0.8' }],
    fetchImpl: fakeFetch
  }), /受保护地址/)
  // 真假混合（污染迹象）：仍拒绝
  await assert.rejects(() => safeFetch(config, 'https://apihub.agnes-ai.com/v1/chat/completions', {}, {
    dnsLookup: async () => [{ address: '198.18.2.235' }, { address: '104.18.19.62' }],
    fetchImpl: fakeFetch
  }), /受保护地址/)
})
