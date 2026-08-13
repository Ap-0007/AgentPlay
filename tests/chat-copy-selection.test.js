const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf8')

test('chat messages allow native mouse selection and keyboard copy', () => {
  assert.match(panel, /data-chat-message=/)
  assert.match(panel, /select-text cursor-text/)
  assert.doesNotMatch(panel, /data-chat-message[^>]+onMouseDown=\{[^}]*preventDefault/)
})
