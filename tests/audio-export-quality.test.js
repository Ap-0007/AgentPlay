const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { AudioExportQualityGate, parseSilenceLog } = require('../electron/audio-export-quality')

function hash(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex') }

function frameStub(overrides = {}) {
  return {
    probeHasAudio: async () => true,
    probeDuration: async () => 10,
    probeAudioLevels: async () => ({ meanVolumeDbfs: -18, samplePeakDbfs: -3 }),
    probeLoudness: async () => ({ integratedLufs: -16, truePeakDbtp: -1.3 }),
    probeStreamTiming: async () => ({
      durationSeconds: 10,
      video: { startSeconds: 0, durationSeconds: 10, endSeconds: 10 },
      audio: { startSeconds: 0.02, durationSeconds: 9.98, endSeconds: 10 }
    }),
    run: async () => ({ stderr: '' }),
    ...overrides
  }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-audio-export-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'source.mp4'); const output = path.join(dir, 'output.mp4'); const music = path.join(dir, 'music.mp3')
  fs.writeFileSync(source, Buffer.from('source')); fs.writeFileSync(output, Buffer.from('output')); fs.writeFileSync(music, Buffer.from('licensed-music'))
  return { dir, source, output, music }
}

function licensedReceipt(music) {
  const receipt = {
    schemaVersion: 1,
    kind: 'agentplay.licensed-music-receipt',
    provider: { name: 'Internet Archive', identifier: 'fixture', sourcePageUrl: 'https://archive.org/details/fixture' },
    track: { title: 'Fixture Track' },
    recording: { performer: 'Fixture Performer', source: 'Fixture master' },
    license: { id: 'CC-BY-4.0', name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    usageScope: { commercialUse: true, adaptationAllowed: true, videoSyncAllowed: true, attributionRequired: true, shareAlike: false },
    file: { localName: path.basename(music), bytes: fs.statSync(music).size, sha256: hash(fs.readFileSync(music)) }
  }
  fs.writeFileSync(`${music}.license.json`, JSON.stringify(receipt))
  return receipt
}

test('C5 parses complete, open-ended and bounded silence intervals', () => {
  const parsed = parseSilenceLog('[silencedetect] silence_start: 1\n[silencedetect] silence_end: 2.25 | silence_duration: 1.25\n[silencedetect] silence_start: 8.5', 10)
  assert.deepEqual(parsed.intervals, [
    { startSeconds: 1, endSeconds: 2.25, durationSeconds: 1.25, position: 'internal' },
    { startSeconds: 8.5, endSeconds: 10, durationSeconds: 1.5, position: 'trailing' }
  ])
  assert.equal(parsed.totalSilenceSeconds, 2.75)
})

test('C5 final gate records clipping, loudness, sync, silence and verified copyright evidence', async (t) => {
  const { source, output, music } = fixture(t); licensedReceipt(music)
  const gate = new AudioExportQualityGate({ frames: frameStub() })
  const result = await gate.audit({
    sourcePath: source, outputPath: output,
    decision: { kind: 'media.add-music', audio: { path: music, loop: true, loudness: { enabled: true, targetLufs: -16, toleranceLufs: 0.7, maxTruePeakDbtp: -1 } } },
    externalAudioPaths: [{ path: music, role: 'music' }]
  })
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.method, 'unified-audio-export-qc-v1')
  assert.equal(result.verdict, 'matched')
  assert.equal(result.clipping.verdict, 'matched')
  assert.equal(result.loudness.verdict, 'matched')
  assert.equal(result.avSync.verdict, 'matched')
  assert.equal(result.silence.verdict, 'matched')
  assert.equal(result.copyright.verdict, 'documented')
  assert.equal(result.copyright.sources[0].status, 'verified-open-license')
  assert.equal(result.copyright.sources[0].licenseId, 'CC-BY-4.0')
  assert.equal('path' in result.copyright.sources[0], false)
})

test('C5 rejects true-peak clipping before delivery', async (t) => {
  const { source, output } = fixture(t)
  const gate = new AudioExportQualityGate({ frames: frameStub({ probeLoudness: async () => ({ integratedLufs: -16, truePeakDbtp: -0.1 }) }) })
  await assert.rejects(() => gate.audit({ sourcePath: source, outputPath: output, decision: { kind: 'media.repair-audio' } }), /削波|true peak/)
})

test('C5 rejects loudness outside the frozen target or professional fallback range', async (t) => {
  const { source, output } = fixture(t)
  const gate = new AudioExportQualityGate({ frames: frameStub({ probeLoudness: async () => ({ integratedLufs: -28, truePeakDbtp: -2 }) }) })
  await assert.rejects(() => gate.audit({ sourcePath: source, outputPath: output, decision: { kind: 'media.rhythm-edit' } }), /响度/)
})

test('C5 rejects audio-video start or end drift', async (t) => {
  const { source, output } = fixture(t)
  const gate = new AudioExportQualityGate({ frames: frameStub({ probeStreamTiming: async () => ({ durationSeconds: 10, video: { startSeconds: 0, durationSeconds: 10, endSeconds: 10 }, audio: { startSeconds: 0.3, durationSeconds: 9.2, endSeconds: 9.5 } }) }) })
  await assert.rejects(() => gate.audit({ sourcePath: source, outputPath: output, decision: { kind: 'media.repair-audio' } }), /声画同步/)
})

test('C5 rejects newly introduced long digital silence but preserves source-contained silence', async (t) => {
  const { source, output } = fixture(t)
  const frames = frameStub({
    run: async (args) => ({ stderr: args[args.indexOf('-i') + 1] === output
      ? '[silencedetect] silence_start: 2\n[silencedetect] silence_end: 5 | silence_duration: 3'
      : '' })
  })
  const gate = new AudioExportQualityGate({ frames })
  await assert.rejects(() => gate.audit({ sourcePath: source, outputPath: output, decision: { kind: 'media.repair-audio' } }), /异常静音/)

  frames.run = async () => ({ stderr: '[silencedetect] silence_start: 2\n[silencedetect] silence_end: 5 | silence_duration: 3' })
  const passed = await gate.audit({ sourcePath: source, outputPath: output, decision: { kind: 'media.repair-audio' } })
  assert.equal(passed.silence.verdict, 'matched-source-baseline')
})

test('C5 fails closed when a licensed-library receipt or bound audio hash is missing', async (t) => {
  const { dir, source, output, music } = fixture(t)
  const licensedDir = path.join(dir, 'AgentPlay 授权音乐'); fs.mkdirSync(licensedDir)
  const licensedMusic = path.join(licensedDir, 'track.mp3'); fs.copyFileSync(music, licensedMusic)
  const gate = new AudioExportQualityGate({ frames: frameStub() })
  const input = { sourcePath: source, outputPath: output, decision: { kind: 'media.add-music' }, externalAudioPaths: [{ path: licensedMusic, role: 'music' }] }
  await assert.rejects(() => gate.audit(input), /许可凭证/)
  licensedReceipt(licensedMusic); fs.appendFileSync(licensedMusic, 'changed')
  await assert.rejects(() => gate.audit(input), /哈希/)
})

test('C5 records ordinary local audio honestly as user supplied instead of pretending the license was verified', async (t) => {
  const { source, output, music } = fixture(t)
  const gate = new AudioExportQualityGate({ frames: frameStub() })
  const result = await gate.audit({ sourcePath: source, outputPath: output, decision: { kind: 'media.mix-audio' }, externalAudioPaths: [{ path: music, role: 'sfx' }] })
  assert.equal(result.verdict, 'matched')
  assert.equal(result.copyright.sources[0].status, 'user-supplied-unverified')
  assert.equal(result.copyright.sources[0].requiresUserResponsibility, true)
})

test('C5 is wired into every audio executor, recovery receipt, quality score and packaged acceptance', () => {
  const media = fs.readFileSync(path.join(__dirname, '..', 'electron', 'media-edit-service.js'), 'utf8')
  const mix = fs.readFileSync(path.join(__dirname, '..', 'electron', 'audio-mix-service.js'), 'utf8')
  const repair = fs.readFileSync(path.join(__dirname, '..', 'electron', 'audio-repair-service.js'), 'utf8')
  const rhythm = fs.readFileSync(path.join(__dirname, '..', 'electron', 'rhythm-edit-service.js'), 'utf8')
  const quality = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-result-quality.js'), 'utf8')
  const types = fs.readFileSync(path.join(__dirname, '..', 'src', 'types', 'global.d.ts'), 'utf8')
  for (const source of [media, mix, repair, rhythm]) {
    assert.match(source, /audioExportQc/)
    assert.match(source, /exportQuality\.audit/)
  }
  assert.match(quality, /UNIFIED_AUDIO_QC_FAILED/)
  assert.match(quality, /统一声音导出质量门/)
  assert.match(types, /unified-audio-export-qc-v1/)
  assert.match(fs.readFileSync(path.join(__dirname, 'packaged-c5-audio-export-acceptance.test.js'), 'utf8'), /quality100/)
})
