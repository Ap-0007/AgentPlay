const test = require('node:test')
const assert = require('node:assert/strict')

const { compileEditDecisionList, compileEditHistoryAction } = require('../electron/media-edit-decision')

test('explicit Chinese trim instruction compiles to a frozen 16-second timeline', () => {
  const decision = compileEditDecisionList({
    instruction: '我想要第四秒到第20秒的这段视频',
    sourcePath: 'D:\\Videos\\source.mp4'
  })

  assert.equal(decision.schemaVersion, 1)
  assert.equal(decision.kind, 'media.trim')
  assert.equal(decision.source.path, 'D:\\Videos\\source.mp4')
  assert.deepEqual(decision.timeline, {
    startSeconds: 4,
    endSeconds: 20,
    durationSeconds: 16
  })
  assert.deepEqual(decision.operations, [{
    type: 'trim',
    sourceStartSeconds: 4,
    sourceEndSeconds: 20,
    targetStartSeconds: 0
  }])
  assert.equal(decision.output.overwrite, false)
})

test('consultation, negation and examples never become executable edit decisions', () => {
  for (const instruction of [
    '能不能截取第4秒到第20秒？',
    '不要截取第4秒到第20秒',
    '比如说保留第4秒到第20秒',
    '如果我说“保留第4秒到第20秒”，你能做到吗？',
    '我想了解第4秒到第20秒发生了什么',
    '帮我看看第4秒到第20秒讲了什么'
  ]) {
    assert.equal(compileEditDecisionList({ instruction, sourcePath: 'D:\\Videos\\source.mp4' }), null, instruction)
  }
})

test('ambiguous or invalid ranges stay in conversation instead of guessing', () => {
  for (const instruction of [
    '帮我剪一下这个视频',
    '保留第4秒之后',
    '保留第20秒到第4秒',
    '保留第4秒到第4秒'
  ]) {
    assert.equal(compileEditDecisionList({ instruction, sourcePath: 'D:\\Videos\\source.mp4' }), null, instruction)
  }
})

test('only an explicit undo or redo command becomes an edit-history action', () => {
  assert.deepEqual(compileEditHistoryAction('撤销刚才的剪辑'), { action: 'undo', instruction: '撤销刚才的剪辑' })
  assert.deepEqual(compileEditHistoryAction('重做刚才撤销的剪辑'), { action: 'redo', instruction: '重做刚才撤销的剪辑' })
  for (const instruction of ['能不能撤销刚才的剪辑？', '不要撤销', '比如说撤销上一步', '撤销下载任务', '重新剪辑第4秒到第20秒']) {
    assert.equal(compileEditHistoryAction(instruction), null, instruction)
  }
})
