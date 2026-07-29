const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { PROVIDERS } = require('../electron/model-providers')

test('agnes provider is registered with correct endpoint and models', () => {
  const agnes = PROVIDERS.find((p) => p.id === 'agnes')
  assert.ok(agnes, 'agnes 必须在厂商清单里')
  assert.equal(agnes.baseUrl, 'https://apihub.agnes-ai.com/v1')
  assert.ok(agnes.models.includes('agnes-2.0-flash'))
})

test('image generation adapts per provider: agnes skips response_format and allows its output host', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'creative-studio-service.js'), 'utf8')
  assert.match(service, /isAgnes = config\.providerId === 'agnes'/)
  assert.match(service, /agnes-image-2\.1-flash/)
  assert.match(service, /if \(!isAgnes\) requestBody\.response_format = 'b64_json'/)
  assert.match(service, /platform-outputs\.agnes-ai\.space/)
  assert.match(service, /ALLOWED_IMAGE_HOSTS\.includes\(host\)/)
})
