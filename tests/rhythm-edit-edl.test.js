const assert = require('node:assert/strict')
const test = require('node:test')
const { assertEditDecisionList, attachEditDecisionList } = require('../electron/edit-decision-list')

function decision() {
  const segments = Array.from({ length: 5 }, (_, index) => ({
    index: index + 1,
    sourceStartSeconds: index * 2 + index * 0.1,
    sourceEndSeconds: index * 2 + index * 0.1 + 2,
    targetStartSeconds: index * 2,
    targetEndSeconds: index * 2 + 2
  }))
  return {
    schemaVersion: 1,
    kind: 'media.rhythm-edit',
    instruction: '按真实节拍切镜，高潮对齐，片尾自然收束',
    source: { path: 'D:/Videos/source.mp4', name: 'source.mp4' },
    music: { path: 'D:/Music/beat.wav', name: 'beat.wav' },
    policy: { schemaVersion: 1, strategy: 'pcm-beat-highlight-edit-v1', analysis: 'decoded-pcm-onset-grid-v1', pace: 'balanced', baseBeatsPerCut: 4, highlightBeatsPerCut: 2, jumpGapSeconds: 0.1, tailFadeSeconds: 1.5, minimumCutSeconds: 0.28, maximumCuts: 40, preserveDialogue: true, musicVolume: 0.22, dialogueDucking: true, outputLoudness: { targetLufs: -16, maxTruePeakDbtp: -1 } },
    rhythm: {
      schemaVersion: 1, strategy: 'beat-synced-jump-cut-v1', pace: 'balanced', bpm: 120, supportRatio: 0.92, analysisMethod: 'decoded-pcm-onset-grid-v1',
      sourceDurationSeconds: 12, musicDurationSeconds: 12, outputDurationSeconds: 10, cutTimes: [2, 4, 6, 8], segments,
      highlight: { startSeconds: 4, endSeconds: 8, score: 3, alignedBeatSeconds: 4, highlightAverageCutSeconds: 1, outsideAverageCutSeconds: 2, densityRatio: 0.5 },
      tail: { endBeatSeconds: 10, fadeSeconds: 1.5, videoFade: true, audioFade: true }, confirmationRequired: true
    },
    output: { container: 'mp4', overwrite: false, suffix: '节拍剪辑-balanced' },
    verification: { toleranceSeconds: 0.2, requireDecodedBeatProof: true, minimumVisibleCutRatio: 0.5, requireHighlightDensity: true, requireNaturalTail: true }
  }
}

test('C3 compiles video jumps, music and tail into one frozen EDL', () => {
  const frozen = attachEditDecisionList(decision())
  assert.deepEqual(frozen.edl.materials.map((item) => item.role), ['video', 'music'])
  assert.deepEqual(frozen.edl.operations.map((item) => item.type), ['append-on-beat', 'append-on-beat', 'append-on-beat', 'append-on-beat', 'append-on-beat', 'mix-rhythm-music', 'fade-to-beat'])
  assert.equal(frozen.edl.quality.beatAnalysis.bpm, 120)
  assert.doesNotThrow(() => assertEditDecisionList(frozen))
})

test('C3 rejects a changed cut or tail after the EDL was frozen', () => {
  const frozen = attachEditDecisionList(decision())
  frozen.rhythm.cutTimes[1] = 4.5
  assert.throws(() => assertEditDecisionList(frozen), /EDL 与冻结决策不一致/)
})
