const test = require('node:test')
const assert = require('node:assert/strict')

test('SPDX generator contains only the supplied production graph and no local paths', async () => {
  const { generateSpdxDocument } = await import('../scripts/generate-spdx-sbom.mjs')
  const document = generateSpdxDocument({
    root: { name: 'agentplay-test', version: '1.2.3', license: 'Apache-2.0' },
    dependencies: {
      react: {
        name: 'react', version: '18.3.1', license: 'MIT', path: 'C:\\private\\node_modules\\react',
        dependencies: { loose: { name: 'loose', version: '1.0.0', license: 'MIT' } }
      }
    },
    createdAt: '2026-08-13T00:00:00.000Z'
  })

  assert.equal(document.spdxVersion, 'SPDX-2.3')
  assert.deepEqual(document.packages.map((item) => item.name).sort(), ['agentplay-test', 'loose', 'react'])
  assert.equal(document.relationships.some((item) => item.relationshipType === 'DESCRIBES'), true)
  assert.equal(document.relationships.filter((item) => item.relationshipType === 'DEPENDS_ON').length, 2)
  assert.doesNotMatch(JSON.stringify(document), /C:\\\\private|node_modules/)
})
