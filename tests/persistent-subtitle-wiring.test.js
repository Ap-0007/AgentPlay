const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

test('durable subtitle generation uses the persistent runtime and unified cloud approval', () => {
  const main = read('electron/main.js')
  const recovery = read('src/components/agent-panel/usePersistentTaskRuntime.ts')

  assert.match(main, /register\('subtitle\.generate'/)
  assert.match(main, /type:\s*'subtitle\.generate'/)
  assert.match(main, /snapshotDocumentSources\(\[resolvedMediaPath,/)
  assert.match(main, /action:\s*'cloud'/)
  assert.match(main, /stage:\s*'source-transcribed'/)
  assert.match(main, /stage:\s*'artifact-written'/)
  assert.match(main, /persistentTaskRuntime\.cancel\(String\(requestId/)
  assert.match(recovery, /subtitle\.generate/)
})
