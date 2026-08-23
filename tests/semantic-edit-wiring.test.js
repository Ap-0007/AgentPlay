const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')

test('main process plans semantic pauses once and executes the frozen EDL through persistent concat', () => {
  const main = read('electron/main.js')
  assert.match(main, /new SemanticEditService\(\{[\s\S]{0,100}frames: videoFrames/)
  assert.match(main, /ipcMain\.handle\('media:edit-plan', async/)
  assert.match(main, /semanticEditService\.plan\(\{ instruction: input\.instruction, sourcePath \}\)/)
  assert.match(main, /if \(input\.decision\) \{[\s\S]{0,220}assertEditDecisionList\(input\.decision\)/)
  assert.match(main, /decision\.semanticCut[\s\S]{0,240}真实音轨证据/)
  assert.match(main, /persistentTaskRuntime\.register\('media\.edit-concat'/)
  assert.match(main, /loadTranscript:[\s\S]{0,260}findAdjacentSubtitle/)
  assert.match(main, /createWordTimingLoader\(\{ frames: videoFrames, transcription: transcriptionService \}\)/)
  assert.match(main, /semanticEditService\.setSemanticAnalyzer/)
  assert.match(main, /ensureCloudConsent\('当前视频字幕的序号、时间和文字/)
  assert.match(main, /taskKind: 'semantic-edit-review'/)
})

test('renderer preserves the planned decision and shows semantic evidence instead of a generic concat label', () => {
  const hook = read('src/components/agent-panel/useMediaCreativeTasks.ts')
  const types = read('src/types/global.d.ts')
  assert.match(hook, /decision\?: MediaEditDecisionV1/)
  assert.match(hook, /frozenDecision = decision/)
  assert.match(hook, /删除长停顿 \$\{semanticCut\.removed\.length\} 处/)
  assert.match(hook, /删除口头禅\/重复句/)
  assert.match(hook, /pendingSemanticReviewRef/)
  assert.match(hook, /confirmationRequired/)
  assert.match(hook, /请回复“确认执行”或“取消”/)
  assert.match(hook, /plan\?\.review\?\.summary/)
  assert.match(hook, /mediaTools\.trim\(\{[\s\S]{0,220}decision: input\.decision/)
  assert.match(types, /strategy: 'audio-silencedetect-v1'/)
  assert.match(types, /'subtitle-cue-cleanup-v1'/)
  assert.match(types, /confirmationRequired\?: boolean/)
  assert.match(types, /reviewOnly\?: Array/)
  assert.match(types, /trim: \(input: \{[^\n]+decision\?: MediaEditDecisionV1/)
})

test('real semantic acceptance keeps the original and verifies detected silence, retained timeline and frame proof', () => {
  const smoke = `${read('scripts/smoke-semantic-pause-edit.mjs')}\n${read('scripts/smoke-packaged-semantic-pause-edit.mjs')}`
  for (const marker of ['anullsrc', 'semantic.plan', 'attachEditDecisionList', 'concatSegments', 'probeDuration', 'sourceUnchanged', 'frameProof']) {
    assert.ok(smoke.includes(marker), `missing semantic acceptance marker: ${marker}`)
  }
})
