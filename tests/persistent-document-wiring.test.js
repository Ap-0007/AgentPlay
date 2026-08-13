const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

test('documents run through the persistent runtime with source snapshots and unified cloud approval', () => {
  const main = read('electron/main.js')
  const types = read('src/types/global.d.ts')
  const hook = read('src/components/agent-panel/useDocumentAnalysisTasks.ts')
  const recovery = read('src/components/agent-panel/usePersistentTaskRuntime.ts')

  assert.match(main, /register\('document\.run'/)
  assert.match(main, /snapshotDocumentSources\(paths\)/)
  assert.match(main, /type:\s*'document\.run'/)
  assert.match(main, /action:\s*'cloud'/)
  assert.match(main, /persistentTaskRuntime\.cancel\(String\(requestId/)
  assert.match(types, /workspaceTaskId\?: string/)
  assert.match(hook, /workspaceTaskId:\s*executionTaskIdRef\.current/)
  assert.match(recovery, /document\.run/)
})
