const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

test('video generation and report recut use the durable runtime', () => {
  const main = read('electron/main.js')
  const mediaTasks = read('src/components/agent-panel/useMediaCreativeTasks.ts')
  const recovery = read('src/components/agent-panel/usePersistentTaskRuntime.ts')

  assert.match(main, /register\('creative\.video-generate'/)
  assert.match(main, /register\('creative\.recut-short'/)
  assert.match(main, /action:\s*'paid'/)
  assert.match(main, /stage:\s*'shots-planned'/)
  assert.match(main, /stage:\s*'clips-generated'/)
  assert.match(main, /stage:\s*'artifact-written'/)
  assert.match(main, /persistentTaskRuntime\.cancel\(String\(requestId/)
  assert.match(mediaTasks, /generateVideo\(\{ prompt, duration: seconds, requestId, workspaceTaskId:/)
  assert.match(mediaTasks, /recutShort\(\{ \.\.\.input,[\s\S]{0,160}requestId, workspaceTaskId:/)
  assert.match(recovery, /creative\.video-generate/)
  assert.match(recovery, /creative\.recut-short/)
})
