const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { MediaEditService } = require('../electron/media-edit-service')
const { compileEditDecisionList } = require('../electron/media-edit-decision')

test('trim re-encodes the exact range, atomically saves a new file and probes its duration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-trim-'))
  try {
    const sourcePath = path.join(dir, 'source.mp4')
    const outputPath = path.join(dir, 'source-AgentPlay剪辑版.mp4')
    fs.writeFileSync(sourcePath, Buffer.from('original-video'))
    const original = fs.readFileSync(sourcePath)
    let runArgs = []
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (filePath) => filePath === sourcePath ? 30 : 16.04,
      run: async (args) => {
        runArgs = args
        fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
      }
    }
    const service = new MediaEditService({ frames })
    const decision = compileEditDecisionList({ instruction: '保留第4秒到第20秒', sourcePath })

    const result = await service.trim({ sourcePath, outputPath, decision })

    assert.equal(result.success, true)
    assert.equal(result.outputPath, outputPath)
    assert.equal(result.expectedDurationSeconds, 16)
    assert.equal(result.durationSeconds, 16.04)
    assert.equal(result.timelineReceipt[0].sourceRange, '00:04.000 → 00:20.000')
    assert.deepEqual(fs.readFileSync(sourcePath), original)
    assert.ok(fs.statSync(outputPath).size > 1024)
    assert.ok(runArgs.indexOf('-i') < runArgs.indexOf('-ss'), 'accurate seek must happen after opening the input')
    assert.equal(runArgs[runArgs.indexOf('-ss') + 1], '4.000')
    assert.equal(runArgs[runArgs.indexOf('-t') + 1], '16.000')
    assert.equal(runArgs[runArgs.indexOf('-c:v') + 1], 'libx264')
    assert.notEqual(runArgs.at(-1), outputPath, 'ffmpeg must write a temporary artifact before atomic rename')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
