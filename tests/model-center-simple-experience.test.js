const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
const modelCenter = read('src/components/ModelCenter.tsx')
const runtimeSettings = read('src/components/agent-panel/RuntimeSettings.tsx')
const types = read('src/types/global.d.ts')

test('daily model routing shows one mode-specific action instead of the engineering console', () => {
  assert.match(modelCenter, /const routingPreference = requestedPreference \|\| routingStatus\?\.settings\?\.preference/)
  assert.match(modelCenter, /routingPreference === 'local'/)
  assert.match(modelCenter, /本机 AI 已就绪/)
  assert.match(modelCenter, /下载并启用本机 AI/)
  assert.match(modelCenter, /!bundledStatus\.hardware\.eligible[^\n]+bundledStatus\.hardware\.reason/)
  assert.match(modelCenter, /routingPreference === 'cloud'/)
  assert.match(modelCenter, /showCloudConnect/)
  assert.match(modelCenter, /增强 AI 能力/)
  assert.doesNotMatch(modelCenter, /已记录 \{routingStatus\?\.totalCalls/)
  assert.doesNotMatch(modelCenter, /只有至少 3 次真实样本/)
})

test('advanced model setup shows verified provider pricing with its verification date', () => {
  assert.match(modelCenter, /selectedModelProfile\?\.pricing/)
  assert.match(modelCenter, /官方参考价/)
  assert.match(modelCenter, /pricingVerifiedAt/)
})

test('DeepSeek thinking behavior is explicit and survives saving from advanced setup', () => {
  assert.match(modelCenter, /const \[thinkingMode, setThinkingMode\]/)
  assert.match(modelCenter, /深度思考/)
  assert.match(modelCenter, /快速回答/)
  assert.match(modelCenter, /models\?\.save\(\{ role, providerId, model, thinkingMode, baseUrl, apiKey \}\)/)
})

test('one selected provider connects immediately when detection has one match', () => {
  assert.match(modelCenter, /if \(result\.matches\.length === 1\) \{\s*await applyMatch\(result\.matches\[0\]\)/)
})

test('starting the bundled model switches chat to it and persists local routing', () => {
  assert.match(modelCenter, /const startBundled = async \(\) => \{[\s\S]*?models\?\.startBundled\(\)[\s\S]*?models\?\.quickSwitch\?\.\(\{ role: 'chat', target: 'bundled' \}\)[\s\S]*?routingSettings\?\.\(\{ preference: 'local', objective: 'economy' \}\)/)
  assert.match(modelCenter, /startLocalAiDownload[\s\S]*?await startBundled\(\)/)
})

test('connected services are deduplicated by provider and endpoint', () => {
  assert.match(modelCenter, /const connectedServices = useMemo/)
  assert.match(modelCenter, /candidate\.providerId.*candidate\.baseUrl/)
  assert.match(modelCenter, /connectedServices\.map/)
})

test('native approval result distinguishes cancellation from a completed disconnect', () => {
  const block = modelCenter.match(/const disconnectCandidate = async[\s\S]*?\n  \}/)?.[0] || ''
  assert.doesNotMatch(block, /window\.confirm/)
  assert.match(block, /const result = await window\.aiPlayer\?\.models\?\.disconnect/)
  assert.match(block, /typeof result\.disconnected !== 'boolean'/)
  assert.match(block, /Array\.isArray\(result\.candidates\)/)
  assert.match(block, /if \(!result\.disconnected\)[\s\S]*?已取消，未删除任何凭证[\s\S]*?return/)
  assert.match(types, /disconnect:[^\n]+Promise<\{ disconnected: boolean; candidates: Array<\{[^\n]+baseUrl: string/)
})

test('initial routing state is loaded in the same guarded transaction as providers and local status', () => {
  assert.match(modelCenter, /Promise\.all\(\[[^\]]*models\?\.routingStatus\?\.\(\)/)
  assert.match(modelCenter, /\.catch\(\(error\) =>/)
})

test('runtime drawer summarizes the same three-way preference and has one route to change it', () => {
  assert.match(runtimeSettings, /models\?\.routingStatus\?\.\(\)/)
  assert.match(runtimeSettings, /智能选择/)
  assert.match(runtimeSettings, /只在本机/)
  assert.match(runtimeSettings, /优先效果/)
  assert.equal((runtimeSettings.match(/更改 AI 使用方式/g) || []).length, 1)
  assert.doesNotMatch(runtimeSettings, /models\?\.quickSwitch/)
  assert.doesNotMatch(runtimeSettings, /配置云端模型/)
})
