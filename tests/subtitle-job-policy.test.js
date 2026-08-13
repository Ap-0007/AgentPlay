const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const { buildTranscriptionStatus, subtitleMediaKey } = require('../electron/subtitle-job-policy')

function loadPolicyForLinux() {
  const filePath = path.join(__dirname, '..', 'electron', 'subtitle-job-policy.js')
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filePath, 'utf8'), {
    module,
    exports: module.exports,
    process: { platform: 'linux' },
    require(specifier) {
      if (specifier === 'path') return { ...path.posix, win32: path.win32 }
      return require(specifier)
    }
  }, { filename: filePath })
  return module.exports
}

test('transcription status names the expensive stage and gives a duration-based estimate', () => {
  const status = buildTranscriptionStatus(338)
  assert.match(status, /本机识别语音/)
  assert.match(status, /分钟/)
  assert.match(status, /翻译/)
  assert.doesNotMatch(status, /约为音频时长数倍/)
})

test('Windows-form media paths normalize independently of the CI host while POSIX case stays meaningful', () => {
  const linuxPolicy = loadPolicyForLinux()
  assert.equal(linuxPolicy.subtitleMediaKey('D:\\Videos\\A.mp4'), linuxPolicy.subtitleMediaKey('d:/videos/A.mp4'))
  assert.equal(linuxPolicy.subtitleMediaKey('D:/Videos/Sub/../A.mp4'), linuxPolicy.subtitleMediaKey('d:\\videos\\a.mp4'))
  assert.equal(linuxPolicy.subtitleMediaKey('\\\\Server\\Share\\Folder\\A.mp4'), linuxPolicy.subtitleMediaKey('//server/share/folder/a.mp4'))
  assert.notEqual(linuxPolicy.subtitleMediaKey('/mnt/Media/A.mp4'), linuxPolicy.subtitleMediaKey('/mnt/media/A.mp4'))
  assert.equal(subtitleMediaKey('D:\\Videos\\A.mp4'), subtitleMediaKey('d:/videos/A.mp4'))
})

test('main process enforces one subtitle generation job per media file', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  assert.match(main, /activeSubtitleMediaJobs/)
  assert.match(main, /这个视频已有字幕任务正在识别或翻译/)
  assert.match(main, /persistentTaskRuntime\.register\('subtitle\.generate'/)
  assert.match(main, /buildTranscriptionStatus\(/)
})
