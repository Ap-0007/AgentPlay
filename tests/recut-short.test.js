const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { agentPanelSource } = require('./helpers/agent-panel-source')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const analysis = fs.readFileSync(path.join(__dirname, '..', 'electron', 'analysis-chat-service.js'), 'utf8')
const panel = agentPanelSource()

test('recut-short IPC: report to shots to clips to ffmpeg concat, all existing infra', () => {
  assert.match(main, /ipcMain\.handle\('studio:recut-short'/)
  // 镜头脚本走 llmComplete，JSON 解析有兜底
  assert.match(main, /你是原创短视频导演/)
  assert.match(main, /buildStyleShotPrompt/)
  assert.match(main, /validateStyleShots/)
  assert.match(main, /planJson\.shots/)
  // 逐镜头走已封装的 generateVideoAsset
  assert.match(main, /generateVideoAsset\(config,/)
  assert.match(main, /resumeVideoId:\s*clipJobs\[index\]\?\.videoId/)
  assert.match(main, /function creativeConfig\(\)/)
  assert.match(main, /stash\?\.chat/)
  // 拼接走 ffmpeg concat + 统一重编码
  assert.match(main, /'-f', 'concat', '-safe', '0'/)
  assert.match(main, /libx264/)
  assert.match(main, /AgentPlay重构短片-/)
  // 进度事件
  assert.match(main, /studio:recut-progress/)
  assert.match(preload, /recutShort: \(input\) => ipcRenderer\.invoke\('studio:recut-short', input\)/)
  assert.match(preload, /onRecutProgress/)
})

test('analysis returns excerpt for downstream recut', () => {
  assert.match(analysis, /excerpt: String\(aiText \|\| offlineDraft\)\.slice\(0, 2000\)/)
})

test('agent panel offers recut after successful analysis, auto-plays result', () => {
  assert.match(panel, /recutOffer/)
  assert.match(panel, /生成重构短片（3 个 AI 镜头拼接）/)
  assert.match(panel, /(?:setRecutOffer|offerRecut)\(\{ reportText: result\.excerpt/)
  assert.match(panel, /studio\?\.recutShort/)
  assert.match(panel, /studio\?\.planRecut/)
  assert.match(panel, /不会发送拉片报告正文或参考帧/)
  assert.match(panel, /onRecutProgress/)
  assert.match(panel, /ai-player-play-file'.*detail: result\.outputPath/)
})
