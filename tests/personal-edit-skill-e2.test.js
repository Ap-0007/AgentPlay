const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { PersonalEditSkillStore, compilePersonalEditSkillCommand } = require('../electron/personal-edit-skill-service')
const { compileMusicDecisionList, compileBurnSubtitlesDecisionList } = require('../electron/media-edit-decision')
const { compileSubtitleLayoutDecision } = require('../electron/subtitle-layout-decision')
const { compileRhythmEditRequest } = require('../electron/rhythm-edit-decision')
const { attachEditDecisionList, assertEditDecisionList } = require('../electron/edit-decision-list')

const SOURCE = 'D:/video/source.mp4'

test('E2 command compiler separates save, list, update, disable and enable without treating consultation as mutation', () => {
  const save = compilePersonalEditSkillCommand('以后这类视频都按快节奏、纪录片字幕和-18 LUFS处理，保存为“知识口播”')
  assert.equal(save.matched, true); assert.equal(save.command.action, 'save'); assert.equal(save.command.name, '知识口播')
  assert.deepEqual(save.command.settings, { pace: 'fast', subtitlePreset: 'documentary', targetLufs: -18 })
  assert.equal(compilePersonalEditSkillCommand('看看我的个人编辑Skill').command.action, 'list')
  const update = compilePersonalEditSkillCommand('把“知识口播”改成克制节奏、简洁字幕、-16 LUFS')
  assert.equal(update.command.action, 'update'); assert.equal(update.command.name, '知识口播'); assert.deepEqual(update.command.settings, { pace: 'restrained', subtitlePreset: 'clean', targetLufs: -16 })
  assert.equal(compilePersonalEditSkillCommand('停用“知识口播”').command.action, 'disable')
  assert.equal(compilePersonalEditSkillCommand('启用“知识口播”').command.action, 'enable')
  assert.equal(compilePersonalEditSkillCommand('能不能保存个人编辑Skill？').matched, false)
})

test('E2 store is atomic, restart-safe, viewable, revisioned and disableable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-personal-skill-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new PersonalEditSkillStore({ rootDir: root, now: () => 1000 })
  const created = store.execute(compilePersonalEditSkillCommand('以后都按快节奏、纪录片字幕和-18 LUFS处理，保存为“知识口播”').command)
  assert.equal(created.skill.enabled, true); assert.equal(created.skill.autoApply, true); assert.equal(created.skill.revision, 1); assert.match(created.skill.digest, /^[a-f0-9]{64}$/)
  assert.equal(store.list().length, 1); assert.equal(store.list()[0].name, '知识口播')
  const restarted = new PersonalEditSkillStore({ rootDir: root, now: () => 2000 })
  assert.deepEqual(restarted.list()[0].settings, { pace: 'fast', subtitlePreset: 'documentary', targetLufs: -18 })
  const updated = restarted.execute(compilePersonalEditSkillCommand('把“知识口播”改成克制节奏、简洁字幕、-16 LUFS').command)
  assert.equal(updated.skill.revision, 2); assert.equal(updated.skill.settings.targetLufs, -16)
  assert.equal(restarted.execute(compilePersonalEditSkillCommand('停用“知识口播”').command).skill.enabled, false)
  assert.equal(restarted.active(), null)
  assert.equal(restarted.execute(compilePersonalEditSkillCommand('启用“知识口播”').command).skill.autoApply, true)
  assert.equal(restarted.active().name, '知识口播')
  const raw = fs.readFileSync(path.join(root, 'personal-edit-skills-v1.json'), 'utf8')
  assert.doesNotMatch(raw, /apiKey|token|D:\\video/i)
})

test('E2 applies defaults only to covered fields and explicit user settings always win', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-personal-apply-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new PersonalEditSkillStore({ rootDir: root })
  store.execute(compilePersonalEditSkillCommand('以后都按快节奏、强调字幕和-18 LUFS处理，保存为“我的风格”').command)

  const music = compileMusicDecisionList({ instruction: '给视频加背景音乐 D:/audio/music.wav', sourcePath: SOURCE })
  const appliedMusic = store.applyDecision(music, { instruction: music.instruction })
  assert.equal(appliedMusic.audio.loudness.targetLufs, -18)
  assert.deepEqual(appliedMusic.personalEditSkill.fieldsApplied, ['audio.targetLufs'])
  assert.equal(appliedMusic.verification.personalEditSkill.digest, store.active().digest)
  assert.doesNotThrow(() => assertEditDecisionList(attachEditDecisionList(appliedMusic)))
  assert.doesNotThrow(() => store.assertReceipt(appliedMusic.personalEditSkill))
  assert.throws(() => store.assertReceipt({ ...appliedMusic.personalEditSkill, digest: '0'.repeat(64) }), /修改或停用/)

  const explicitMusic = compileMusicDecisionList({ instruction: '给视频加背景音乐 D:/audio/music.wav，响度归一到-14 LUFS', sourcePath: SOURCE })
  const explicitApplied = store.applyDecision(explicitMusic, { instruction: explicitMusic.instruction })
  assert.equal(explicitApplied.audio.loudness.targetLufs, -14)
  assert.equal(explicitApplied.personalEditSkill, undefined)

  const burn = compileBurnSubtitlesDecisionList({ instruction: '把字幕 D:/video/sub.srt 烧录到视频', sourcePath: SOURCE })
  const appliedBurn = store.applyDecision(burn, { instruction: burn.instruction })
  assert.deepEqual(appliedBurn.subtitle.style, { fontSize: 'large', alignment: 'bottom', color: '黄色' })
  assert.ok(appliedBurn.personalEditSkill.fieldsApplied.includes('subtitle.preset'))

  const layout = compileSubtitleLayoutDecision({ instruction: '字幕布局 D:/video/sub.srt，横屏720p', sourcePath: SOURCE }).decision
  assert.equal(store.applyDecision(layout, { instruction: layout.instruction }).subtitleLayout.stylePreset, 'impact')
  const explicitLayout = compileSubtitleLayoutDecision({ instruction: '字幕布局 D:/video/sub.srt，横屏720p，纪录片风格', sourcePath: SOURCE }).decision
  assert.equal(store.applyDecision(explicitLayout, { instruction: explicitLayout.instruction }).subtitleLayout.stylePreset, 'documentary')

  const rhythm = compileRhythmEditRequest({ instruction: '按音乐节拍剪辑 D:/audio/music.wav', sourcePath: SOURCE })
  const appliedRhythm = store.applyRhythmRequest(rhythm, { instruction: rhythm.instruction })
  assert.equal(appliedRhythm.policy.pace, 'fast'); assert.equal(appliedRhythm.policy.baseBeatsPerCut, 2)
  const explicitRhythm = compileRhythmEditRequest({ instruction: '按音乐节拍更克制地剪辑 D:/audio/music.wav', sourcePath: SOURCE })
  assert.equal(store.applyRhythmRequest(explicitRhythm, { instruction: explicitRhythm.instruction }).policy.pace, 'restrained')
})

test('E2 corrupt primary restores only a valid backup and keeps unknown future schema fail-closed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-personal-recovery-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new PersonalEditSkillStore({ rootDir: root })
  store.execute(compilePersonalEditSkillCommand('以后都按均衡节奏、简洁字幕和-16 LUFS处理，保存为“默认”').command)
  store.execute(compilePersonalEditSkillCommand('把“默认”改成快节奏、纪录片字幕、-18 LUFS').command)
  fs.writeFileSync(path.join(root, 'personal-edit-skills-v1.json'), '{broken', 'utf8')
  const recovered = new PersonalEditSkillStore({ rootDir: root })
  assert.equal(recovered.list().length, 1); assert.ok(fs.readdirSync(root).some((name) => name.startsWith('corrupt-')))
  fs.writeFileSync(path.join(root, 'personal-edit-skills-v1.json'), JSON.stringify({ schemaVersion: 99, skills: [] }), 'utf8')
  assert.throws(() => new PersonalEditSkillStore({ rootDir: root }).list(), /更高版本/)
})

test('E2 main, preload and conversation use one management service and installed lifecycle acceptance', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const router = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'intentRouter.ts'), 'utf8')
  const media = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8')
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-personal-edit-skill-e2.mjs'), 'utf8')
  assert.match(main, /new PersonalEditSkillStore/); assert.match(main, /personalEditSkills\.applyDecision/); assert.match(main, /personalEditSkills\.applyRhythmRequest/)
  assert.match(preload, /personalEditSkills:execute/); assert.match(preload, /personalEditSkills:list/)
  assert.match(router, /runPersonalEditSkillCommand/); assert.match(media, /runPersonalEditSkillCommand/)
  for (const marker of ['saved', 'viewed', 'updated', 'disabled', 'enabled', 'appliedDigest', 'restartPersisted', 'qualityScore']) assert.match(smoke, new RegExp(marker))
})
