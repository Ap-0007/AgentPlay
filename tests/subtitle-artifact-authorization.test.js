const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')

test('subtitle artifacts produced by the app are authorized before the renderer reads them', () => {
  assert.match(main, /function authorizeDerivedSubtitle\(subtitlePath\)/)

  const bilingual = main.slice(
    main.indexOf('const executePersistentSubtitleTask'),
    main.indexOf("ipcMain.handle('subtitle:bilingual-cancel'")
  )
  assert.equal((bilingual.match(/authorizeDerivedSubtitle\(srtPath\)/g) || []).length, 1)
  assert.match(bilingual, /authorizeDerivedSubtitle\(cachedPath\)/)

  const live = main.slice(
    main.indexOf("ipcMain.handle('subtitle:live-start'"),
    main.indexOf("ipcMain.handle('subtitle:live-seek'")
  )
  assert.match(live, /authorizeDerivedSubtitle\(candidate\)/)

  const transcribe = main.slice(
    main.indexOf("ipcMain.handle('subtitle:live-transcribe-start'"),
    main.indexOf("ipcMain.handle('models:stop-bundled'")
  )
  assert.match(transcribe, /authorizeDerivedSubtitle\(candidate\)/)

  const online = main.slice(
    main.indexOf("ipcMain.handle('subtitle:search'"),
    main.indexOf("ipcMain.handle('media:analyze'")
  )
  assert.match(online, /const result = await downloadSubtitle/)
  assert.match(online, /authorizeDerivedSubtitle\(result\.path\)/)
})

test('derived subtitle authorization remains constrained to subtitle files created on disk', () => {
  const start = main.indexOf('function authorizeDerivedSubtitle(subtitlePath)')
  const helper = main.slice(start, start + 900)
  assert.ok(start >= 0)
  assert.match(helper, /SUBTITLE_ARTIFACT_EXTS\.has/)
  assert.match(helper, /const stat = fs\.statSync\(resolved\)/)
  assert.match(helper, /stat\.isFile\(\)/)
  assert.match(helper, /userAuthorizedPaths\.add\(resolved\)/)
})
