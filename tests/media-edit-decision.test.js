const test = require('node:test')
const assert = require('node:assert/strict')

const { compileEditDecisionList, compileEditHistoryAction, portableBasename } = require('../electron/media-edit-decision')

test('edit decision source names are stable across Windows and POSIX runners', () => {
  assert.equal(portableBasename('D:\\Videos\\source.mp4'), 'source.mp4')
  assert.equal(portableBasename('/mnt/videos/source.mp4'), 'source.mp4')
})

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

test('an explicit remove-range command compiles to one removed timeline segment', () => {
  const decision = compileEditDecisionList({
    instruction: '删除第4秒到第20秒',
    sourcePath: 'D:\\Videos\\source.mp4'
  })

  assert.deepEqual(decision, {
    schemaVersion: 1,
    kind: 'media.remove-segment',
    instruction: '删除第4秒到第20秒',
    source: { path: 'D:\\Videos\\source.mp4', name: 'source.mp4' },
    timeline: { startSeconds: 4, endSeconds: 20, removedDurationSeconds: 16 },
    operations: [{ type: 'remove', sourceStartSeconds: 4, sourceEndSeconds: 20 }],
    output: { container: 'mp4', overwrite: false, suffix: '删除版-00m04s-00m20s' },
    verification: { removedDurationSeconds: 16, toleranceSeconds: 0.2 }
  })

  for (const instruction of ['能不能删除第4秒到第20秒？', '不要删除第4秒到第20秒', '比如删除第4秒到第20秒', '删除视频']) {
    assert.equal(compileEditDecisionList({ instruction, sourcePath: 'D:\\Videos\\source.mp4' }), null, instruction)
  }
})

test('explicit multi-range join preserves the spoken segment order in one frozen timeline', () => {
  const decision = compileEditDecisionList({
    instruction: '把第8秒到第12秒放前面，再接第0秒到第4秒',
    sourcePath: 'D:\\Videos\\source.mp4'
  })

  assert.deepEqual(decision, {
    schemaVersion: 1,
    kind: 'media.concat-segments',
    instruction: '把第8秒到第12秒放前面，再接第0秒到第4秒',
    source: { path: 'D:\\Videos\\source.mp4', name: 'source.mp4' },
    timeline: {
      segments: [
        { sourceStartSeconds: 8, sourceEndSeconds: 12, durationSeconds: 4, targetStartSeconds: 0, targetEndSeconds: 4 },
        { sourceStartSeconds: 0, sourceEndSeconds: 4, durationSeconds: 4, targetStartSeconds: 4, targetEndSeconds: 8 }
      ],
      durationSeconds: 8
    },
    operations: [
      { type: 'append', sourceStartSeconds: 8, sourceEndSeconds: 12, targetStartSeconds: 0 },
      { type: 'append', sourceStartSeconds: 0, sourceEndSeconds: 4, targetStartSeconds: 4 }
    ],
    output: { container: 'mp4', overwrite: false, suffix: '拼接版-2段-00m08s' },
    verification: { expectedDurationSeconds: 8, toleranceSeconds: 0.2 }
  })

  for (const instruction of [
    '能不能把第8秒到第12秒放前面，再接第0秒到第4秒？',
    '不要把第8秒到第12秒和第0秒到第4秒拼起来',
    '比如把第8秒到第12秒放前面，再接第0秒到第4秒',
    '把第8秒到第12秒放前面'
  ]) {
    assert.equal(compileEditDecisionList({ instruction, sourcePath: 'D:\\Videos\\source.mp4' }), null, instruction)
  }
})

test('multi-range joins are bounded to a safe maximum segment count', () => {
  const tooManyRanges = `按顺序拼接${Array.from({ length: 25 }, (_, index) => `第${index}秒到第${index + 1}秒`).join('和')}`
  assert.equal(compileEditDecisionList({ instruction: tooManyRanges, sourcePath: 'D:\\Videos\\source.mp4' }), null)
})
