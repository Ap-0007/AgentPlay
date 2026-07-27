const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  PROVIDERS,
  VOLCENGINE_CODING_BASE_URL,
  VOLCENGINE_CODING_MODELS,
  detectVolcenginePlan
} = require('../electron/model-providers')

const dnsStub = async () => ({ address: '93.184.216.34' })

function fetchReturning(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  })
}

test('volcengine coding plan preset uses the dedicated coding base URL', () => {
  const preset = PROVIDERS.find((item) => item.id === 'volcengine-coding')
  assert.ok(preset, '缺少 volcengine-coding 预设')
  assert.equal(preset.baseUrl, 'https://ark.cn-beijing.volces.com/api/coding/v3')
  assert.ok(preset.models.includes('ark-code-latest'))
  assert.ok(preset.models.includes('kimi-k2.7-code'))
  assert.equal(VOLCENGINE_CODING_BASE_URL, preset.baseUrl)
})

test('plan detection accepts keys that can list models on the coding endpoint', async () => {
  const plan = await detectVolcenginePlan('plan-key', {
    dnsLookup: dnsStub,
    fetchImpl: fetchReturning(200, { data: [{ id: 'kimi-k2.6' }, { id: 'glm-5.2' }] })
  })
  assert.equal(plan.isPlan, true)
  assert.deepEqual(plan.models, ['kimi-k2.6', 'glm-5.2'])
})

test('plan detection falls back to curated models when the endpoint list is empty', async () => {
  const plan = await detectVolcenginePlan('plan-key', { dnsLookup: dnsStub, fetchImpl: fetchReturning(200, { data: [] }) })
  assert.equal(plan.isPlan, true)
  assert.deepEqual(plan.models, VOLCENGINE_CODING_MODELS)
})

test('plan detection rejects non-plan keys and network failures honestly', async () => {
  const denied = await detectVolcenginePlan('normal-key', { dnsLookup: dnsStub, fetchImpl: fetchReturning(401, { error: 'denied' }) })
  assert.equal(denied.isPlan, false)
  assert.equal(denied.status, 401)
  const offline = await detectVolcenginePlan('any-key', { dnsLookup: dnsStub, fetchImpl: async () => { throw new Error('ECONNRESET') } })
  assert.equal(offline.isPlan, false)
  const noKey = await detectVolcenginePlan('', {})
  assert.equal(noKey.isPlan, false)
})

test('models:test wiring detects plan and model center offers one-click upgrade', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const center = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelCenter.tsx'), 'utf8')
  assert.match(main, /detectVolcenginePlan\(apiKey\)/)
  assert.match(main, /planDetected: true/)
  assert.match(main, /api\/coding\/v3.*套餐|套餐专用地址/)
  assert.match(center, /applyPlanUpgrade/)
  assert.match(center, /按套餐接入/)
})
