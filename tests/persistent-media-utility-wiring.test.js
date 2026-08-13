const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8')

test('batch transcription, compression and duplicate scan use the persistent main-process runtime', () => {
  const main = read('electron/main.js')
  assert.match(main, /register\('media\.batch'/)
  assert.match(main, /register\('media\.compress'/)
  assert.match(main, /register\('media\.dedup'/)
  assert.match(main, /type:\s*'media\.batch'/)
  assert.match(main, /type:\s*'media\.compress'/)
  assert.match(main, /type:\s*'media\.dedup'/)
  assert.match(main, /stage:\s*'item-complete'/)
  assert.match(main, /stage:\s*'artifact-written'/)
  assert.match(main, /hashCache/)
  assert.match(main, /persistentTaskRuntime\.cancel\(String\(requestId/)
})

test('renderer forwards workspace ids and can restore all local media utilities', () => {
  const tasks = read('src/components/agent-panel/useMediaCreativeTasks.ts')
  const recovery = read('src/components/agent-panel/usePersistentTaskRuntime.ts')
  assert.match(tasks, /mediaBatch\?\.run\(\{[^}]*workspaceTaskId:/s)
  assert.match(tasks, /mediaTools\?\.compress\(\{[^}]*workspaceTaskId:/s)
  assert.match(tasks, /media\?\.dedup\(\{[^}]*workspaceTaskId:/s)
  assert.match(recovery, /media\.batch/)
  assert.match(recovery, /media\.compress/)
  assert.match(recovery, /media\.dedup/)
})

test('dedup hashing exposes resumable cache callbacks guarded by size and mtime', () => {
  const media = read('electron/media-service.js')
  assert.match(media, /mtimeMs/)
  assert.match(media, /hashCache/)
  assert.match(media, /onFileHashed/)
})

test('agent media tool actions are bridged into the unified workspace task entry point', () => {
  const executor = read('src/agentToolExecutor.ts')
  const panel = read('src/components/agent-panel/useMediaCreativeTasks.ts')
  assert.match(executor, /ai-player-agent-media-task/)
  assert.match(panel, /ai-player-agent-media-task/)
})
