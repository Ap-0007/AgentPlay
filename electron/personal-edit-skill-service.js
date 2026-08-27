const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const SCHEMA_VERSION = 1
const CONSULTATION = /能不能|可不可以|可以吗|是否|怎么|如何|\?|？/

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex') }
function cleanName(value) { return String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 40) }
function quotedNames(text) { return [...String(text || '').matchAll(/[“"《]([^”"》]{1,40})[”"》]/g)].map((item) => cleanName(item[1])).filter(Boolean) }
function settingsFrom(text) {
  const settings = {}
  if (/快节奏|节奏快|更快|密一点/.test(text)) settings.pace = 'fast'
  else if (/克制节奏|节奏克制|更克制|慢一点|少切/.test(text)) settings.pace = 'restrained'
  else if (/均衡节奏|节奏均衡|正常节奏/.test(text)) settings.pace = 'balanced'
  if (/纪录片字幕|纪录片(?:风格|样式)/.test(text)) settings.subtitlePreset = 'documentary'
  else if (/强调字幕|冲击字幕|强调(?:风格|样式)|冲击(?:风格|样式)/.test(text)) settings.subtitlePreset = 'impact'
  else if (/简洁字幕|简洁(?:风格|样式)|清爽字幕/.test(text)) settings.subtitlePreset = 'clean'
  const loudness = /(-?\d+(?:\.\d+)?)\s*LUFS/i.exec(text)
  if (loudness) { const value = Number(loudness[1]); if (value >= -24 && value <= -10) settings.targetLufs = value }
  return settings
}
function compilePersonalEditSkillCommand(instruction) {
  const text = String(instruction || '').trim()
  if (!text || CONSULTATION.test(text)) return { matched: false }
  const names = quotedNames(text)
  if (/查看|看看|列出|有哪些/.test(text) && /(?:个人编辑|我的).{0,8}Skill/i.test(text)) return { matched: true, command: { schemaVersion: 1, action: 'list', instruction: text } }
  if (/停用|禁用|关闭/.test(text) && (names.length || /Skill|风格|编辑习惯/i.test(text))) return { matched: true, command: { schemaVersion: 1, action: 'disable', name: names[0] || cleanName(text.replace(/.*(?:停用|禁用|关闭)/, '').replace(/(?:个人编辑)?Skill/ig, '')), instruction: text } }
  if (/启用|重新启用|设为默认/.test(text) && (names.length || /Skill|风格|编辑习惯/i.test(text))) return { matched: true, command: { schemaVersion: 1, action: 'enable', name: names[0] || cleanName(text.replace(/.*(?:启用|设为默认)/, '').replace(/(?:个人编辑)?Skill/ig, '')), instruction: text } }
  const settings = settingsFrom(text)
  if (/改成|改为|修改/.test(text) && names.length) return { matched: true, command: { schemaVersion: 1, action: 'update', name: names[0], settings, instruction: text } }
  if (/以后|今后|保存为|记住/.test(text) && Object.keys(settings).length) {
    const saveName = names.at(-1) || cleanName(/保存为\s*([^，。；]+)/.exec(text)?.[1]) || '我的默认风格'
    return { matched: true, command: { schemaVersion: 1, action: 'save', name: saveName, settings, instruction: text } }
  }
  return { matched: false }
}

function publicSkill(skill) {
  const snapshot = { id: skill.id, name: skill.name, enabled: skill.enabled === true, autoApply: skill.autoApply === true, revision: Number(skill.revision), settings: { ...skill.settings }, createdAt: Number(skill.createdAt), updatedAt: Number(skill.updatedAt) }
  return { ...snapshot, digest: digest(snapshot) }
}
function validDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('个人编辑Skill状态无效')
  if (Number(value.schemaVersion) > SCHEMA_VERSION) throw new Error('个人编辑Skill由更高版本创建，当前版本拒绝降级覆盖')
  if (Number(value.schemaVersion) !== SCHEMA_VERSION || !Array.isArray(value.skills)) throw new Error('个人编辑Skill状态结构无效')
  return value
}

class PersonalEditSkillStore {
  constructor({ rootDir, fsImpl = fs, now = () => Date.now(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!rootDir) throw new Error('个人编辑Skill缺少存储目录')
    this.rootDir = path.resolve(rootDir); this.filePath = path.join(this.rootDir, 'personal-edit-skills-v1.json'); this.backupPath = `${this.filePath}.bak`; this.fs = fsImpl; this.now = now; this.idFactory = idFactory; this.document = null
    this.fs.mkdirSync(this.rootDir, { recursive: true })
  }
  parse(filePath) { return validDocument(JSON.parse(this.fs.readFileSync(filePath, 'utf8'))) }
  load() {
    if (this.document) return this.document
    if (!this.fs.existsSync(this.filePath)) return (this.document = { schemaVersion: 1, skills: [], audit: [] })
    try { return (this.document = this.parse(this.filePath)) } catch (error) {
      try {
        const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'))
        if (Number(parsed?.schemaVersion) > SCHEMA_VERSION) throw error
      } catch (parseError) { if (String(parseError?.message || '').includes('更高版本')) throw parseError }
      const forensic = path.join(this.rootDir, `corrupt-${this.now()}.json`); this.fs.copyFileSync(this.filePath, forensic)
      if (!this.fs.existsSync(this.backupPath)) throw error
      const backup = this.parse(this.backupPath); this.fs.copyFileSync(this.backupPath, this.filePath); return (this.document = backup)
    }
  }
  save(document) {
    validDocument(document)
    if (this.fs.existsSync(this.filePath)) { try { this.parse(this.filePath); this.fs.copyFileSync(this.filePath, this.backupPath) } catch {} }
    const temp = `${this.filePath}.${process.pid}.${this.idFactory()}.tmp`; this.fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); this.fs.renameSync(temp, this.filePath); this.document = document
  }
  list() { return this.load().skills.map(publicSkill).sort((a, b) => Number(b.autoApply) - Number(a.autoApply) || b.updatedAt - a.updatedAt) }
  active() { return this.list().find((item) => item.enabled && item.autoApply) || null }
  assertReceipt(receipt) {
    if (!receipt) return true
    const skill = this.list().find((item) => item.id === receipt.id)
    if (!skill || !skill.enabled || skill.revision !== Number(receipt.revision) || skill.digest !== receipt.digest || skill.name !== receipt.name) throw new Error('个人编辑Skill已修改或停用，请重新规划本次编辑')
    return true
  }
  findByName(document, name) { const normalized = cleanName(name).toLowerCase(); return document.skills.find((item) => cleanName(item.name).toLowerCase() === normalized) }
  execute(command) {
    if (command?.schemaVersion !== 1 || !['save', 'list', 'update', 'disable', 'enable'].includes(command.action)) throw new Error('个人编辑Skill命令无效')
    if (command.action === 'list') return { success: true, action: 'list', skills: this.list(), summary: this.describeList() }
    const document = JSON.parse(JSON.stringify(this.load())); const now = this.now(); let skill = this.findByName(document, command.name)
    if (command.action === 'save') {
      if (!Object.keys(command.settings || {}).length) throw new Error('保存个人编辑Skill至少需要节奏、字幕或响度中的一项')
      for (const item of document.skills) item.autoApply = false
      if (skill) { skill.settings = { ...skill.settings, ...command.settings }; skill.enabled = true; skill.autoApply = true; skill.revision = Number(skill.revision) + 1; skill.updatedAt = now }
      else { skill = { id: `personal-edit-${this.idFactory()}`, name: cleanName(command.name) || '我的默认风格', enabled: true, autoApply: true, revision: 1, settings: { ...command.settings }, createdAt: now, updatedAt: now }; document.skills.push(skill) }
    } else {
      if (!skill) throw new Error(`没有找到个人编辑Skill“${cleanName(command.name)}”`)
      if (command.action === 'update') { if (!Object.keys(command.settings || {}).length) throw new Error('没有识别到要修改的节奏、字幕或响度'); skill.settings = { ...skill.settings, ...command.settings } }
      if (command.action === 'disable') { skill.enabled = false; skill.autoApply = false }
      if (command.action === 'enable') { for (const item of document.skills) item.autoApply = false; skill.enabled = true; skill.autoApply = true }
      skill.revision = Number(skill.revision) + 1; skill.updatedAt = now
    }
    document.skills = document.skills.slice(-20); document.audit = [...(document.audit || []), { action: command.action, skillId: skill.id, revision: skill.revision, at: now }].slice(-100); this.save(document)
    const visible = publicSkill(skill); return { success: true, action: command.action, skill: visible, skills: this.list(), summary: this.describe(visible, command.action) }
  }
  describe(skill, action = 'view') {
    const pace = { fast: '快节奏', balanced: '均衡节奏', restrained: '克制节奏' }[skill.settings.pace] || '未设节奏'
    const subtitle = { clean: '简洁字幕', impact: '强调字幕', documentary: '纪录片字幕' }[skill.settings.subtitlePreset] || '未设字幕'
    const loudness = Number.isFinite(skill.settings.targetLufs) ? `${skill.settings.targetLufs} LUFS` : '未设响度'
    const verb = { save: '已保存', update: '已修改', disable: '已停用', enable: '已启用' }[action] || ''
    return `${verb ? `${verb} ` : ''}“${skill.name}” · ${pace} · ${subtitle} · ${loudness}${skill.enabled ? skill.autoApply ? ' · 正在作为默认编辑Skill' : ' · 已启用' : ' · 已停用'}`
  }
  describeList() { const skills = this.list(); return skills.length ? skills.map((item) => this.describe(item)).join('\n') : '还没有个人编辑Skill。你可以说“以后都按快节奏、纪录片字幕和-18 LUFS处理，保存为知识口播”。' }
  receipt(skill, fieldsApplied) { return { schemaVersion: 1, id: skill.id, name: skill.name, revision: skill.revision, digest: skill.digest, fieldsApplied } }
  applyDecision(decision, { instruction = '' } = {}) {
    const skill = this.active(); const next = JSON.parse(JSON.stringify(decision || {})); delete next.edl
    if (!skill || !next.kind) return next
    const fields = []; const text = String(instruction || next.instruction || '')
    const audioExplicit = /LUFS|不要.{0,8}(?:响度|归一)/i.test(text)
    const subtitleExplicit = /(?:字幕)?(?:风格|样式)|纪录片|强调|冲击|简洁|大字|小字|顶部|底部|黄色|白色|红色|蓝色|绿色|黑色/.test(text)
    const paceExplicit = /更快|快一点|节奏快|更克制|克制一点|慢一点|少切|均衡节奏/.test(text)
    const target = Number(skill.settings.targetLufs)
    if (!audioExplicit && Number.isFinite(target)) {
      if (next.kind === 'media.add-music' && next.audio?.loudness) { next.audio.loudness.targetLufs = target; fields.push('audio.targetLufs') }
      if (next.kind === 'media.mix-audio' && next.audioMix?.master?.loudness) { next.audioMix.master.loudness.targetLufs = target; fields.push('audioMix.master.targetLufs') }
      if (next.kind === 'media.repair-audio' && next.audioRepair?.loudness) { next.audioRepair.loudness.targetLufs = target; fields.push('audioRepair.targetLufs') }
      if (next.kind === 'media.rhythm-edit' && next.policy?.outputLoudness) { next.policy.outputLoudness.targetLufs = target; fields.push('rhythm.targetLufs') }
    }
    const preset = skill.settings.subtitlePreset
    if (!subtitleExplicit && preset) {
      if (next.kind === 'media.burn-subtitles') { next.subtitle.style = preset === 'impact' ? { fontSize: 'large', alignment: 'bottom', color: '黄色' } : preset === 'documentary' ? { fontSize: 'small', alignment: 'bottom', color: '白色' } : { alignment: 'bottom', color: '白色' }; fields.push('subtitle.preset') }
      if (next.kind === 'media.subtitle-layout-variants') { next.subtitleLayout.stylePreset = preset; fields.push('subtitleLayout.stylePreset') }
      if (next.kind === 'media.transform-subtitles' && !next.subtitleTransform.style) { next.subtitleTransform.style = { preset }; if (!next.subtitleTransform.operationKinds.includes('style')) next.subtitleTransform.operationKinds.push('style'); next.output.container = 'ass'; fields.push('subtitleTransform.stylePreset') }
    }
    if (!paceExplicit && skill.settings.pace && next.kind === 'media.rhythm-edit' && next.policy) { Object.assign(next.policy, this.paceValues(skill.settings.pace)); if (next.rhythm) next.rhythm.pace = skill.settings.pace; fields.push('rhythm.pace') }
    if (!fields.length) return next
    const receipt = this.receipt(skill, fields); next.personalEditSkill = receipt; next.verification = { ...(next.verification || {}), personalEditSkill: receipt }; return next
  }
  paceValues(pace) { return { fast: { pace: 'fast', baseBeatsPerCut: 2, highlightBeatsPerCut: 1, jumpGapSeconds: 0.14, tailFadeSeconds: 1.2 }, balanced: { pace: 'balanced', baseBeatsPerCut: 4, highlightBeatsPerCut: 2, jumpGapSeconds: 0.09, tailFadeSeconds: 1.5 }, restrained: { pace: 'restrained', baseBeatsPerCut: 8, highlightBeatsPerCut: 4, jumpGapSeconds: 0.04, tailFadeSeconds: 1.8 } }[pace] }
  applyRhythmRequest(request, { instruction = '' } = {}) {
    const skill = this.active(); const next = JSON.parse(JSON.stringify(request || {})); if (!skill || !next.policy || /更快|快一点|节奏快|更克制|克制一点|慢一点|少切|均衡节奏/.test(String(instruction || next.instruction || '')) || !skill.settings.pace) return next
    Object.assign(next.policy, this.paceValues(skill.settings.pace)); next.personalEditSkill = this.receipt(skill, ['rhythm.pace']); return next
  }
}

module.exports = { PersonalEditSkillStore, compilePersonalEditSkillCommand, settingsFrom, publicSkill }
