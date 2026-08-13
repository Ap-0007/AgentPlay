const test = require('node:test')
const assert = require('node:assert/strict')

const { PROVIDERS, normalizeConfig, normalizeProviderModels } = require('../electron/model-providers')
const { modelKey } = require('../electron/model-performance-router')
const { openAIRequestBody } = require('../electron/llm-service')

test('DeepSeek catalog exposes current v4 models and no retired public model ids', () => {
  const provider = PROVIDERS.find((item) => item.id === 'deepseek')
  assert.ok(provider)
  assert.deepEqual(provider.models, ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.equal(provider.models.includes('deepseek-chat'), false)
  assert.equal(provider.models.includes('deepseek-reasoner'), false)
})

test('legacy DeepSeek model ids migrate to a supported v4 model with verified metadata', () => {
  const flash = normalizeConfig({ providerId: 'deepseek', model: 'deepseek-chat' })
  const reasoningFlash = normalizeConfig({ providerId: 'deepseek', model: 'deepseek-reasoner' })
  const pro = normalizeConfig({ providerId: 'deepseek', model: 'deepseek-v4-pro' })

  assert.equal(flash.model, 'deepseek-v4-flash')
  assert.equal(reasoningFlash.model, 'deepseek-v4-flash')
  assert.equal(flash.thinkingMode, 'disabled')
  assert.equal(reasoningFlash.thinkingMode, 'enabled')
  assert.equal(pro.thinkingMode, 'enabled')
  assert.equal(normalizeConfig({ providerId: 'deepseek', model: 'deepseek-v4-flash' }).thinkingMode, 'enabled')
  assert.notEqual(modelKey(flash), modelKey(reasoningFlash))
  assert.equal(flash.contextWindow, 1_000_000)
  assert.equal(flash.maxOutputTokens, 384_000)
  assert.deepEqual(flash.pricing, {
    cachedInputUsdPerMillion: 0.0028,
    inputUsdPerMillion: 0.14,
    outputUsdPerMillion: 0.28
  })
  assert.deepEqual(pro.pricing, {
    cachedInputUsdPerMillion: 0.003625,
    inputUsdPerMillion: 0.435,
    outputUsdPerMillion: 0.87
  })
  assert.equal(flash.pricingVerifiedAt, '2026-08-13')
  assert.match(flash.pricingUrl, /^https:\/\/api-docs\.deepseek\.com\//)
})

test('DeepSeek thinking mode is explicit in OpenAI requests while other providers are untouched', () => {
  const base = { model: 'deepseek-v4-flash', messages: [] }
  assert.deepEqual(openAIRequestBody(base, normalizeConfig({ providerId: 'deepseek', model: 'deepseek-chat' })), {
    ...base,
    thinking: { type: 'disabled' }
  })
  assert.deepEqual(openAIRequestBody(base, normalizeConfig({ providerId: 'deepseek', model: 'deepseek-reasoner' })), {
    ...base,
    thinking: { type: 'enabled' }
  })
  assert.deepEqual(openAIRequestBody(base, normalizeConfig({ providerId: 'agnes' })), base)
})

test('a stale runtime catalog cannot put retired DeepSeek ids back into the model selector', () => {
  const provider = PROVIDERS.find((item) => item.id === 'deepseek')
  assert.deepEqual(
    normalizeProviderModels(provider, ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-next']),
    ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-next']
  )
})
