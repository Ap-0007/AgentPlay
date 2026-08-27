const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const library = require('../electron/online-media-service')

function jsonResponse(value) {
  return { ok: true, json: async () => value }
}

test('C4 only accepts licenses that allow commercial video adaptation', () => {
  for (const url of [
    'https://creativecommons.org/publicdomain/mark/1.0/',
    'http://creativecommons.org/publicdomain/zero/1.0/',
    'https://creativecommons.org/licenses/by/3.0/',
    'http://creativecommons.org/licenses/by/4.0/'
  ]) {
    const license = library.normalizeMusicLicense(url)
    assert.equal(license.commercialUse, true)
    assert.equal(license.adaptationAllowed, true)
    assert.equal(license.shareAlike, false)
  }
  for (const url of [
    '',
    'https://creativecommons.org/licenses/by-nc/4.0/',
    'https://creativecommons.org/licenses/by-nd/4.0/',
    'https://creativecommons.org/licenses/by-sa/4.0/'
  ]) assert.throws(() => library.normalizeMusicLicense(url), /不进入一键商用曲库/)
})

test('C4 search freezes track, performer, recording source, license and usage scope', async () => {
  let requestedUrl = ''
  const fetchImpl = async (url) => {
    requestedUrl = String(url)
    return jsonResponse({ response: { numFound: 2, docs: [
      {
        identifier: 'allowed-track', title: 'Quiet Flight', creator: 'Alice Pianist', year: 2025,
        downloads: 8, source: 'Studio One master recording',
        licenseurl: 'https://creativecommons.org/licenses/by/4.0/'
      },
      {
        identifier: 'blocked-track', title: 'No Commercial', creator: 'Bad Candidate',
        licenseurl: 'https://creativecommons.org/licenses/by-nc/4.0/'
      }
    ] } })
  }
  const result = await library.searchLicensedMusic('quiet piano', { fetchImpl, attempts: 1 })
  assert.match(decodeURIComponent(requestedUrl), /licenseurl:\(/)
  assert.match(decodeURIComponent(requestedUrl), /creativecommons\.org\/licenses\/by\/4\.0/)
  assert.doesNotMatch(decodeURIComponent(requestedUrl), /by-nc/)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].track, 'Quiet Flight')
  assert.equal(result.items[0].performer, 'Alice Pianist')
  assert.equal(result.items[0].recordingSource, 'Studio One master recording')
  assert.equal(result.items[0].license.id, 'CC-BY-4.0')
  assert.equal(result.items[0].usageScope.attributionRequired, true)
  assert.equal(result.items[0].usageScope.videoSyncAllowed, true)
})

test('C4 detail revalidates item license and carries provenance on every playable recording', async () => {
  const fetchImpl = async () => jsonResponse({
    metadata: {
      title: 'Piano Set', creator: 'Alice Pianist', source: 'Original studio master',
      licenseurl: 'http://creativecommons.org/publicdomain/zero/1.0/'
    },
    files: [
      { name: 'track-01.mp3', size: '1024', format: 'VBR MP3', title: 'First Light', artist: 'Alice Pianist', track: '1' },
      { name: 'cover.jpg', size: '128', format: 'JPEG' }
    ]
  })
  const result = await library.listLicensedMusicFiles('piano-set', { fetchImpl, attempts: 1 })
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].track, 'First Light')
  assert.equal(result.files[0].performer, 'Alice Pianist')
  assert.equal(result.files[0].recordingSource, 'Original studio master')
  assert.equal(result.files[0].license.id, 'CC0-1.0')
  assert.match(result.files[0].sourcePageUrl, /^https:\/\/archive\.org\/details\/piano-set$/)
  assert.match(result.files[0].attributionText, /First Light/)
})

test('C4 detail fails closed when Archive metadata loses the approved license', async () => {
  const fetchImpl = async () => jsonResponse({
    metadata: { title: 'Changed', licenseurl: 'https://creativecommons.org/licenses/by-nc/4.0/' },
    files: [{ name: 'changed.mp3', size: '1024', format: 'VBR MP3' }]
  })
  await assert.rejects(
    library.listLicensedMusicFiles('changed-license', { fetchImpl, attempts: 1 }),
    /不进入一键商用曲库/
  )
})

test('C4 detail retries one transient fetch failure instead of leaking raw English', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) throw new TypeError('fetch failed')
    return jsonResponse({
      metadata: { title: 'Recovered', creator: 'Alice', source: 'Studio', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' },
      files: [{ name: 'recovered.mp3', size: '1024', format: 'VBR MP3' }]
    })
  }
  const result = await library.listLicensedMusicFiles('recovered', { fetchImpl, attempts: 2 })
  assert.equal(calls, 2)
  assert.equal(result.files[0].name, 'recovered.mp3')
})

test('C4 receipt is portable, explicit and bound to the downloaded bytes', () => {
  const receipt = library.buildLicensedMusicReceipt({
    identifier: 'piano-set', title: 'Piano Set',
    file: {
      name: 'track-01.mp3', track: 'First Light', performer: 'Alice Pianist',
      recordingSource: 'Original studio master', sourcePageUrl: 'https://archive.org/details/piano-set',
      license: library.normalizeMusicLicense('https://creativecommons.org/licenses/by/4.0/'),
      usageScope: library.normalizeMusicLicense('https://creativecommons.org/licenses/by/4.0/').usageScope,
      attributionText: 'First Light — Alice Pianist — CC BY 4.0'
    },
    outputPath: 'D:/Music/First Light.mp3', bytes: 1024,
    sha256: 'a'.repeat(64), downloadedAt: '2026-08-26T00:00:00.000Z'
  })
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.kind, 'agentplay.licensed-music-receipt')
  assert.equal(receipt.track.title, 'First Light')
  assert.equal(receipt.recording.performer, 'Alice Pianist')
  assert.equal(receipt.license.id, 'CC-BY-4.0')
  assert.equal(receipt.file.sha256, 'a'.repeat(64))
  assert.equal(receipt.file.localName, 'First Light.mp3')
  assert.equal('outputPath' in receipt.file, false)
  assert.equal(receipt.usageScope.videoSyncAllowed, true)
})

test('C4 is wired through main-process revalidation, sidecar receipt and a human-readable library card', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'OnlineMediaLibrary.tsx'), 'utf8')
  assert.match(main, /onlineMedia:licensedMusicFiles/)
  assert.match(main, /onlineMedia:downloadLicensedMusic/)
  assert.match(main, /listLicensedMusicFiles\(input\.identifier/)
  assert.match(main, /\.license\.json/)
  assert.match(preload, /licensedMusicFiles:/)
  assert.match(preload, /downloadLicensedMusic:/)
  assert.match(panel, /可商用配乐/)
  assert.match(panel, /许可凭证/)
  assert.match(panel, /使用范围/)
})

test('real Archive C4 catalog returns a revalidated playable recording', { timeout: 30000 }, async (t) => {
  let search
  try {
    search = await library.searchLicensedMusic('calm piano', { rows: 5, attempts: 1, timeoutMs: 12000 })
  } catch (error) {
    t.skip(`Archive 外网不可用：${error.message}`)
    return
  }
  assert.ok(search.items.length > 0)
  assert.ok(search.items.every((item) => item.usageScope.commercialUse && item.usageScope.videoSyncAllowed))
  let detail
  try {
    detail = await library.listLicensedMusicFiles(search.items[0].identifier, { attempts: 1, timeoutMs: 12000 })
  } catch (error) {
    t.skip(`Archive 元数据不可用：${error.message}`)
    return
  }
  assert.ok(detail.files.length > 0)
  assert.match(detail.files[0].url, /^https:\/\/archive\.org\/download\//)
  assert.ok(detail.files[0].track)
  assert.ok(detail.files[0].performer)
  assert.ok(detail.files[0].recordingSource)
  assert.match(detail.files[0].license.url, /^https:\/\/creativecommons\.org\//)
})
