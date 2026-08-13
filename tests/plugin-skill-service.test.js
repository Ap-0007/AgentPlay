const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { PluginSkillService } = require('../electron/plugin-service')

function writePlugin(root, overrides = {}) {
  const dir = path.join(root, overrides.folder || 'video-notes')
  fs.mkdirSync(path.join(dir, 'skills', 'video-notes'), { recursive: true })
  const manifest = {
    schemaVersion: 1,
    id: 'video-notes',
    name: '视频笔记助手',
    version: '1.0.0',
    description: '把当前视频整理成结构化笔记',
    publisher: 'AgentPlay 示例',
    permissions: ['app.read'],
    skills: ['skills/video-notes/SKILL.md'],
    tools: [{
      name: 'summarize-current-video',
      description: '读取当前视频字幕并生成摘要',
      target: 'summarize_video',
      parameters: { type: 'object', properties: {} }
    }],
    ...overrides.manifest
  }
  fs.writeFileSync(path.join(dir, 'agentplay-plugin.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(dir, 'skills', 'video-notes', 'SKILL.md'), `---\nname: video-notes\ndescription: Use when the user asks for structured notes from the current video.\n---\n\n# Video notes\n\n1. Read subtitle evidence.\n2. Separate facts from inference.\n3. Return concise Chinese notes.\n`)
  return dir
}

test('declarative plugins stay disabled until enabled, then contribute bounded tools and skills', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-plugin-service-'))
  const contributions = []
  try {
    writePlugin(root)
    const service = new PluginSkillService({ rootDir: root, onContributions: (value) => contributions.push(value) })
    let plugins = service.refresh()
    assert.equal(plugins.length, 1)
    assert.equal(plugins[0].id, 'video-notes')
    assert.equal(plugins[0].enabled, false)
    assert.equal(plugins[0].valid, true)
    assert.deepEqual(contributions.at(-1), { tools: [], skills: [] })

    assert.throws(() => service.setEnabled('video-notes', true), /完整权限清单/)
    plugins = service.setEnabled('video-notes', true, ['app.read'])
    assert.equal(plugins[0].enabled, true)
    const active = contributions.at(-1)
    assert.equal(active.tools.length, 1)
    assert.equal(active.tools[0].name, 'plugin_video_notes_summarize_current_video')
    assert.equal(active.tools[0].target, 'summarize_video')
    assert.equal(active.tools[0].pluginId, 'video-notes')
    assert.equal(active.skills.length, 1)
    assert.equal(active.skills[0].name, 'video-notes')
    assert.match(active.skills[0].instructions, /Separate facts from inference/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('permission mismatch and skill path traversal fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-plugin-policy-'))
  try {
    writePlugin(root, { folder: 'no-control', manifest: {
      id: 'no-control', permissions: ['app.read'], skills: [],
      tools: [{ name: 'pause', description: '暂停', target: 'pause', parameters: { type: 'object', properties: {} } }]
    } })
    writePlugin(root, { folder: 'escape-plugin', manifest: { id: 'escape-plugin', skills: ['../outside/SKILL.md'], tools: [] } })
    const plugins = new PluginSkillService({ rootDir: root }).refresh()
    assert.equal(plugins.find((item) => item.id === 'no-control').valid, false)
    assert.match(plugins.find((item) => item.id === 'no-control').error, /player\.control/)
    assert.equal(plugins.find((item) => item.id === 'escape-plugin').valid, false)
    assert.match(plugins.find((item) => item.id === 'escape-plugin').error, /插件目录内/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('legacy javascript is quarantined without executing it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-plugin-legacy-'))
  try {
    fs.writeFileSync(path.join(root, 'legacy.js'), 'throw new Error("THIS_CODE_MUST_NOT_RUN")')
    const plugins = new PluginSkillService({ rootDir: root }).refresh()
    assert.equal(plugins.length, 1)
    assert.equal(plugins[0].kind, 'legacy-js')
    assert.equal(plugins[0].enabled, false)
    assert.match(plugins[0].error, /隔离停用/)
    assert.doesNotMatch(plugins[0].error, /THIS_CODE_MUST_NOT_RUN/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('installation copies a validated package disabled and uninstall moves it to recoverable trash', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-plugin-source-'))
  const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-plugin-managed-'))
  try {
    const source = writePlugin(sourceRoot)
    fs.writeFileSync(path.join(source, 'untrusted.exe'), 'MZ-this-file-must-not-be-installed')
    const service = new PluginSkillService({ rootDir: managedRoot })
    const installed = service.installFromDirectory(source)
    assert.equal(installed.find((item) => item.id === 'video-notes').enabled, false)
    assert.ok(fs.existsSync(path.join(managedRoot, 'video-notes', 'agentplay-plugin.json')))
    assert.equal(fs.existsSync(path.join(managedRoot, 'video-notes', 'untrusted.exe')), false)
    assert.throws(() => service.remove('video-notes', false), /确认/)
    const removed = service.remove('video-notes', true)
    assert.equal(removed.some((item) => item.id === 'video-notes'), false)
    assert.ok(fs.readdirSync(path.join(managedRoot, '.trash')).some((name) => name.startsWith('video-notes-')))
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true })
    fs.rmSync(managedRoot, { recursive: true, force: true })
  }
})

test('legacy javascript from the compatibility directory is listed but never copied or executed', () => {
  const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-plugin-managed-'))
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-plugin-legacy-root-'))
  try {
    fs.writeFileSync(path.join(legacyRoot, 'old-plugin.js'), 'throw new Error("LEGACY_MUST_NOT_RUN")')
    const plugins = new PluginSkillService({ rootDir: managedRoot, legacyDir: legacyRoot }).refresh()
    assert.equal(plugins.length, 1)
    assert.equal(plugins[0].kind, 'legacy-js')
    assert.match(plugins[0].file, /^legacy/)
    assert.doesNotMatch(plugins[0].error, /LEGACY_MUST_NOT_RUN/)
  } finally {
    fs.rmSync(managedRoot, { recursive: true, force: true })
    fs.rmSync(legacyRoot, { recursive: true, force: true })
  }
})

test('a manifest permission change revokes the previous enable grant', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-plugin-grant-'))
  try {
    const dir = writePlugin(root)
    const service = new PluginSkillService({ rootDir: root })
    service.refresh()
    assert.equal(service.setEnabled('video-notes', true, ['app.read'])[0].enabled, true)
    const manifestPath = path.join(dir, 'agentplay-plugin.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.permissions.push('file.read')
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    const changed = service.refresh()[0]
    assert.equal(changed.enabled, false)
    assert.equal(changed.needsPermissionApproval, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
