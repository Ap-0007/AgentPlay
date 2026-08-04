const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const providers = fs.readFileSync(path.join(__dirname, '..', 'electron', 'model-providers.js'), 'utf8')
const llm = fs.readFileSync(path.join(__dirname, '..', 'electron', 'llm-service.js'), 'utf8')
const cli = fs.readFileSync(path.join(__dirname, '..', 'electron', 'cli-model-service.js'), 'utf8')
const modelCenter = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelCenter.tsx'), 'utf8')

const { buildPrompt, extractCodexAnswer } = require('../electron/cli-model-service.js')

test('subscription providers declared without key requirement, cli protocol passes url validation', () => {
  assert.match(providers, /id: 'codex-chatgpt'.*requiresKey: false/)
  assert.match(providers, /id: 'claude-code'.*requiresKey: false/)
  assert.match(providers, /protocol === 'cli'\) return \{ origin: 'cli:\/\/local' \}/)
  assert.match(providers, /gpt-5\.5/, 'codex 模型清单')
  assert.match(providers, /claude-opus-5/, 'claude 模型清单')
})

test('agent engine routes cli providers to subprocess backend, never to network stack', () => {
  assert.match(llm, /cliProviderId === 'codex-chatgpt' \|\| cliProviderId === 'claude-code'/)
  assert.match(llm, /completeViaCodex|completeViaClaude/)
})

test('cli backend: read-only sandbox, prompt via stdin, windows shim resolution, json extraction', () => {
  assert.match(cli, /-s', 'read-only'/)
  assert.match(cli, /child\.stdin\.end\(stdinText, 'utf8'\)/)
  assert.match(cli, /resolveCliCommand/)
  assert.match(cli, /item\.type === 'agent_message'/)
  // codex 登录失效与 claude 401 都有可操作引导
  assert.match(cli, /codex login/)
  assert.match(cli, /claude auth login/)
})

test('model center shows subscription cards with login status', () => {
  assert.match(modelCenter, /订阅账号（免 API Key）/)
  assert.match(modelCenter, /cliStatus/)
  assert.match(modelCenter, /applyCli/)
  assert.match(main, /models:cli-status/)
  assert.match(preload, /cliStatus/)
})

test('buildPrompt keeps system prompt and recent turns; extractCodexAnswer ignores non-json log lines', () => {
  const prompt = buildPrompt([{ role: 'user', content: '问题一' }, { role: 'assistant', content: '回答一' }, { role: 'user', content: '问题二' }], '设定')
  assert.ok(prompt.includes('【系统设定】设定'))
  assert.ok(prompt.includes('用户：问题二'))

  const stdout = [
    '2026-08-03T07:46:20Z ERROR codex_models_manager::cache: failed to load models cache',
    '{"type":"thread.started","thread_id":"x"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"这是答案"}}'
  ].join('\n')
  assert.equal(extractCodexAnswer(stdout), '这是答案')
})


test('codex models reflect the real 5.6 lineup + spark, claude reflects opus-5 generation', () => {
  assert.match(providers, /gpt-5\.6-sol.*gpt-5\.6-terra.*gpt-5\.6-luna/)
  assert.match(providers, /claude-opus-5.*claude-sonnet-5.*claude-fable-5/)
  assert.match(providers, /gpt-5\.3-codex-spark/)
})


test('models:test for cli providers probes with a real short chat instead of network probe', () => {
  assert.match(main, /config.providerId === 'codex-chatgpt' \|\| config.providerId === 'claude-code'/)
  assert.match(main, /只回复两个字：OK/)
  assert.match(main, /订阅通道正常/)
  assert.match(main, /timeoutMs: 180000/)
})


test('cloud-protocol consumers all go through creativeConfig guard (cli falls back to stash cloud)', () => {
  // 视觉/指路/问这帧/云语音统一走 creativeConfig（cli 时自动回退 stash 云端），不再裸用 resolved(chat)
  assert.match(main, /llmCompleteVisionMulti = async[\s\S]{0,200}creativeConfig\(\)/)
  assert.match(main, /requestScreenGuide\(creativeConfig\(\)/)
  assert.match(main, /askAboutImage\(creativeConfig\(\)/)
  assert.match(main, /synthesizeCloudVoice\(creativeConfig\(\)/)
  assert.match(main, /describeImage = async[\s\S]{0,120}creativeConfig\(\)/)
  // 对话本身保留 resolved(chat)——cli 分支要走订阅
  assert.match(main, /llmComplete = async[\s\S]{0,200}resolved\('chat'\)/)
})

test('streaming chat() routes cli providers to subprocess, never to network stack', () => {
  const llm = fs.readFileSync(path.join(__dirname, '..', 'electron', 'llm-service.js'), 'utf8')
  // chat() 必须在 resolveProvider 网络栈之前接住 cli 厂商（否则空 baseUrl → [网络错误] Invalid URL，用户真实事故）
  const chatIdx = llm.indexOf('async chat(messages')
  const cliIdx = llm.indexOf("cliProviderId === 'codex-chatgpt'", chatIdx)
  const resolveIdx = llm.indexOf('this.resolveProvider(apiKey)', chatIdx)
  assert.ok(chatIdx > -1 && cliIdx > chatIdx && resolveIdx > cliIdx, 'chat() 缺少 cli 前置分支')
  assert.match(llm.slice(cliIdx, resolveIdx), /completeText\(messages, apiKey/)
})

test('model center save broadcasts models-changed so home label refreshes', () => {
  const mc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelCenter.tsx'), 'utf8')
  const saveIdx = mc.indexOf('Key 使用系统加密存储')
  assert.ok(saveIdx > -1)
  assert.match(mc.slice(saveIdx, saveIdx + 300), /ai-player-models-changed/, 'save() 必须广播 models-changed（否则首页标签陈旧，用户真实事故）')
})
