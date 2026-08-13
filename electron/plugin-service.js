const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { getBuiltinAgentTool } = require('./agent-tool-registry')

const PLUGIN_DIR = path.join(os.homedir(), '.ai-player', 'plugins')
const MANIFEST_FILE = 'agentplay-plugin.json'
const STATE_FILE = '.agentplay-plugin-state.json'
const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TOOL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ALLOWED_PERMISSIONS = new Set(['app.read', 'player.control', 'file.read', 'file.write', 'network', 'cloud', 'paid'])
const MAX_MANIFEST_BYTES = 128 * 1024
const MAX_SKILL_BYTES = 64 * 1024

function canonicalPath(value) {
  return path.resolve(String(value || ''))
}

function isInside(root, candidate) {
  const base = canonicalPath(root)
  const target = canonicalPath(candidate)
  return target === base || target.startsWith(base + path.sep)
}

function safeJson(filePath, maxBytes = MAX_MANIFEST_BYTES) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error('清单文件为空或超过大小限制')
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('清单必须是 JSON 对象')
  return value
}

function parseSkill(filePath, pluginRoot) {
  if (!isInside(pluginRoot, filePath)) throw new Error('Skill 必须位于插件目录内')
  const realRoot = fs.realpathSync(pluginRoot)
  const realFile = fs.realpathSync(filePath)
  if (!isInside(realRoot, realFile)) throw new Error('Skill 实际路径必须位于插件目录内')
  const stat = fs.statSync(realFile)
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SKILL_BYTES) throw new Error('SKILL.md 为空或超过 64KB')
  const text = fs.readFileSync(realFile, 'utf8')
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/)
  if (!match) throw new Error('SKILL.md 缺少 YAML frontmatter')
  const frontmatter = Object.fromEntries(match[1].split(/\r?\n/).map((line) => {
    const index = line.indexOf(':')
    return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1).trim()] : ['', '']
  }).filter(([key]) => key))
  const name = String(frontmatter.name || '')
  const description = String(frontmatter.description || '')
  const instructions = match[2].trim()
  if (!SKILL_NAME.test(name)) throw new Error('Skill name 必须是小写短横线格式')
  if (!description || description.length > 1000) throw new Error('Skill description 缺失或过长')
  if (!instructions) throw new Error('Skill instructions 不能为空')
  return { name, description, instructions }
}

function permissionForRisk(risk) {
  if (risk === 'read-only') return 'app.read'
  if (risk === 'control') return 'player.control'
  if (risk === 'local-write' || risk === 'interactive') return 'file.write'
  return 'app.read'
}

function permissionDigest(permissions) {
  return crypto.createHash('sha256').update(JSON.stringify([...permissions].sort())).digest('hex')
}

function publicPlugin(plugin) {
  const { rootPath, contributions, ...safe } = plugin
  return safe
}

class PluginSkillService {
  constructor({ rootDir = PLUGIN_DIR, legacyDir = null, onContributions = null, now = () => Date.now() } = {}) {
    this.rootDir = canonicalPath(rootDir)
    this.legacyDir = legacyDir ? canonicalPath(legacyDir) : null
    this.stateFile = path.join(this.rootDir, STATE_FILE)
    this.trashDir = path.join(this.rootDir, '.trash')
    this.onContributions = typeof onContributions === 'function' ? onContributions : () => {}
    this.now = now
    this.plugins = []
    fs.mkdirSync(this.rootDir, { recursive: true })
  }

  loadState() {
    try {
      const raw = safeJson(this.stateFile)
      return {
        enabled: raw.enabled && typeof raw.enabled === 'object' ? raw.enabled : {},
        grants: raw.grants && typeof raw.grants === 'object' ? raw.grants : {}
      }
    } catch {
      return { enabled: {}, grants: {} }
    }
  }

  saveState(state) {
    fs.mkdirSync(this.rootDir, { recursive: true })
    const temp = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ version: 1, enabled: state.enabled, grants: state.grants }, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, this.stateFile)
  }

  inspectDirectory(pluginRoot, state, expectedId = null) {
    const manifestPath = path.join(pluginRoot, MANIFEST_FILE)
    let fallbackId = expectedId || path.basename(pluginRoot)
    try {
      if (!isInside(this.rootDir, pluginRoot)) throw new Error('插件目录越界')
      const realManagedRoot = fs.realpathSync(this.rootDir)
      const realPluginRoot = fs.realpathSync(pluginRoot)
      if (!isInside(realManagedRoot, realPluginRoot)) throw new Error('插件实际路径越界或包含链接')
      const manifest = safeJson(manifestPath)
      if (manifest.schemaVersion !== 1) throw new Error('只支持 schemaVersion 1')
      const id = String(manifest.id || '')
      if (PLUGIN_ID.test(id)) fallbackId = id
      const requiredId = expectedId || path.basename(pluginRoot)
      if (!PLUGIN_ID.test(id) || id !== requiredId) throw new Error('插件 id 必须与目录名一致，并使用小写短横线格式')
      const name = String(manifest.name || '').trim()
      const version = String(manifest.version || '').trim()
      const description = String(manifest.description || '').trim()
      const publisher = String(manifest.publisher || '').trim()
      if (!name || name.length > 100 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('插件 name/version 无效')
      if (description.length > 500 || publisher.length > 120) throw new Error('插件描述或发布者过长')
      const permissions = [...new Set((Array.isArray(manifest.permissions) ? manifest.permissions : []).map(String))]
      const unknown = permissions.find((item) => !ALLOWED_PERMISSIONS.has(item))
      if (unknown) throw new Error(`未知权限: ${unknown}`)
      const skills = (Array.isArray(manifest.skills) ? manifest.skills : []).map((relative) => {
        const normalized = String(relative || '').replace(/\\/g, '/')
        if (!normalized || normalized.startsWith('/') || normalized.includes('../')) throw new Error('Skill 必须位于插件目录内')
        const filePath = path.resolve(pluginRoot, normalized)
        return { pluginId: id, path: normalized, ...parseSkill(filePath, pluginRoot) }
      })
      const toolNames = new Set()
      const tools = (Array.isArray(manifest.tools) ? manifest.tools : []).map((raw) => {
        const localName = String(raw?.name || '')
        const target = String(raw?.target || '')
        if (!TOOL_NAME.test(localName) || toolNames.has(localName)) throw new Error(`插件工具名称无效或重复: ${localName}`)
        toolNames.add(localName)
        const builtin = getBuiltinAgentTool(target)
        if (!builtin) throw new Error(`插件工具只能映射现有内置工具: ${target}`)
        const requiredPermission = permissionForRisk(builtin.risk)
        if (!permissions.includes(requiredPermission)) throw new Error(`工具 ${localName} 需要权限 ${requiredPermission}`)
        const schema = raw?.parameters && typeof raw.parameters === 'object' && !Array.isArray(raw.parameters) ? raw.parameters : { type: 'object', properties: {} }
        const parameters = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {}
        const required = Array.isArray(schema.required) ? schema.required.map(String) : []
        return {
          pluginId: id,
          name: `plugin_${id.replace(/-/g, '_')}_${localName.replace(/-/g, '_')}`,
          localName,
          description: String(raw?.description || builtin.description).slice(0, 300),
          target,
          parameters,
          required,
          category: 'plugin',
          risk: builtin.risk,
          cost: builtin.cost
        }
      })
      const grantDigest = permissionDigest(permissions)
      const enabled = state.enabled[id] === true && state.grants[id] === grantDigest
      return {
        id, name, version, description, publisher, permissions, enabled, valid: true, kind: 'declarative',
        file: path.relative(this.rootDir, manifestPath), rootPath: pluginRoot,
        skillCount: skills.length, toolCount: tools.length, error: '', permissionDigest: grantDigest,
        needsPermissionApproval: state.enabled[id] === true && state.grants[id] !== grantDigest,
        contributions: { tools, skills }
      }
    } catch (error) {
      return {
        id: fallbackId, name: fallbackId, version: '', description: '', publisher: '', permissions: [], enabled: false,
        valid: false, kind: 'declarative', file: path.relative(this.rootDir, manifestPath), rootPath: pluginRoot,
        skillCount: 0, toolCount: 0, error: error instanceof Error ? error.message : String(error), contributions: { tools: [], skills: [] }
      }
    }
  }

  publishContributions() {
    const active = this.plugins.filter((plugin) => plugin.valid && plugin.enabled)
    this.onContributions({
      tools: active.flatMap((plugin) => plugin.contributions.tools),
      skills: active.flatMap((plugin) => plugin.contributions.skills)
    })
  }

  refresh() {
    fs.mkdirSync(this.rootDir, { recursive: true })
    const state = this.loadState()
    const plugins = []
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) plugins.push(this.inspectDirectory(path.join(this.rootDir, entry.name), state))
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.js')) {
        plugins.push({
          id: `legacy-${entry.name.replace(/\.js$/i, '').replace(/[^A-Za-z0-9_-]+/g, '-')}`,
          name: entry.name, version: '', description: '', publisher: '', permissions: [], enabled: false, valid: false,
          kind: 'legacy-js', file: entry.name, skillCount: 0, toolCount: 0,
          error: '旧式 JavaScript 插件已隔离停用；请迁移为 agentplay-plugin.json + SKILL.md 声明式插件', contributions: { tools: [], skills: [] }
        })
      }
    }
    if (this.legacyDir && this.legacyDir !== this.rootDir && fs.existsSync(this.legacyDir)) {
      for (const entry of fs.readdirSync(this.legacyDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.js')) continue
        plugins.push({
          id: `legacy-${entry.name.replace(/\.js$/i, '').replace(/[^A-Za-z0-9_-]+/g, '-')}`,
          name: entry.name, version: '', description: '', publisher: '', permissions: [], enabled: false, valid: false,
          kind: 'legacy-js', file: path.join('legacy', entry.name), skillCount: 0, toolCount: 0,
          error: '旧式 JavaScript 插件已隔离停用；请迁移为 agentplay-plugin.json + SKILL.md 声明式插件', contributions: { tools: [], skills: [] }
        })
      }
    }
    this.plugins = plugins.sort((a, b) => a.id.localeCompare(b.id))
    this.publishContributions()
    return this.plugins.map(publicPlugin)
  }

  setEnabled(id, enabled, confirmedPermissions = null) {
    const plugin = this.plugins.find((item) => item.id === id) || (this.refresh(), this.plugins.find((item) => item.id === id))
    if (!plugin) throw new Error('插件不存在')
    if (!plugin.valid && enabled) throw new Error(`插件校验失败: ${plugin.error}`)
    const state = this.loadState()
    state.enabled[id] = enabled === true
    if (enabled) {
      const confirmed = Array.isArray(confirmedPermissions) ? [...new Set(confirmedPermissions.map(String))].sort() : []
      const required = [...plugin.permissions].sort()
      if (JSON.stringify(confirmed) !== JSON.stringify(required)) throw new Error('启用插件前必须确认完整权限清单')
      state.grants[id] = plugin.permissionDigest
    } else {
      delete state.grants[id]
    }
    this.saveState(state)
    return this.refresh()
  }

  installFromDirectory(sourceDir) {
    const source = canonicalPath(sourceDir)
    if (!fs.statSync(source).isDirectory()) throw new Error('插件来源必须是文件夹')
    const realSource = fs.realpathSync(source)
    const manifest = safeJson(path.join(source, MANIFEST_FILE))
    const id = String(manifest.id || '')
    if (!PLUGIN_ID.test(id)) throw new Error('插件 id 无效')
    const destination = path.join(this.rootDir, id)
    if (!isInside(this.rootDir, destination) || fs.existsSync(destination)) throw new Error('插件已存在或目标路径无效')
    const staging = path.join(this.rootDir, `.install-${id}-${crypto.randomUUID()}`)
    try {
      fs.mkdirSync(staging, { recursive: false })
      fs.copyFileSync(path.join(source, MANIFEST_FILE), path.join(staging, MANIFEST_FILE))
      for (const relative of Array.isArray(manifest.skills) ? manifest.skills : []) {
        const normalized = String(relative || '').replace(/\\/g, '/')
        if (!normalized || normalized.startsWith('/') || normalized.includes('../')) throw new Error('Skill 必须位于插件目录内')
        const sourceFile = path.resolve(source, normalized)
        const realSourceFile = fs.realpathSync(sourceFile)
        if (!isInside(realSource, realSourceFile)) throw new Error('Skill 实际路径必须位于插件来源目录内')
        parseSkill(realSourceFile, realSource)
        const stagedFile = path.resolve(staging, normalized)
        if (!isInside(staging, stagedFile)) throw new Error('Skill 安装路径越界')
        fs.mkdirSync(path.dirname(stagedFile), { recursive: true })
        fs.copyFileSync(realSourceFile, stagedFile)
      }
      const state = this.loadState()
      const inspected = this.inspectDirectory(staging, { enabled: { [id]: false }, grants: {} }, id)
      if (!inspected.valid) throw new Error(inspected.error)
      if (inspected.id !== id) throw new Error('插件清单 id 不一致')
      fs.renameSync(staging, destination)
      state.enabled[id] = false
      delete state.grants[id]
      this.saveState(state)
      return this.refresh()
    } catch (error) {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
      throw error
    }
  }

  remove(id, confirmed = false) {
    if (!confirmed) throw new Error('删除插件需要明确确认')
    const plugin = this.plugins.find((item) => item.id === id) || (this.refresh(), this.plugins.find((item) => item.id === id))
    if (!plugin || plugin.kind !== 'declarative') throw new Error('插件不存在或不可由应用移除')
    const source = path.join(this.rootDir, id)
    if (!isInside(this.rootDir, source) || !fs.existsSync(source)) throw new Error('插件目录不存在')
    fs.mkdirSync(this.trashDir, { recursive: true })
    const destination = path.join(this.trashDir, `${id}-${this.now()}`)
    fs.renameSync(source, destination)
    const state = this.loadState()
    delete state.enabled[id]
    delete state.grants[id]
    this.saveState(state)
    return this.refresh()
  }
}

let legacyService = null
function listPlugins() {
  if (!legacyService) legacyService = new PluginSkillService({ rootDir: PLUGIN_DIR })
  return legacyService.refresh()
}

module.exports = { PluginSkillService, listPlugins, PLUGIN_DIR, MANIFEST_FILE, ALLOWED_PERMISSIONS }
