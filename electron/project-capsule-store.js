const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { fingerprintArtifact } = require('./artifact-fingerprint')

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value))
const kindForPath = (filePath) => {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  if (['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.wmv', '.flv', '.ts'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma'].includes(ext)) return 'audio'
  if (['.srt', '.vtt', '.ass', '.ssa'].includes(ext)) return 'subtitle'
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) return 'image'
  if (ext === '.pdf') return 'pdf'
  if (['.doc', '.docx', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf'].includes(ext)) return 'office'
  return 'document'
}

class ProjectCapsuleStore {
  constructor({ rootDir, now = () => Date.now(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!rootDir) throw new Error('项目胶囊目录不能为空')
    this.rootDir = path.resolve(rootDir)
    this.statePath = path.join(this.rootDir, 'project-capsules-v1.json')
    this.now = now
    this.idFactory = idFactory
    this.loadError = ''
    fs.mkdirSync(this.rootDir, { recursive: true })
    this.state = this.load()
  }

  load() {
    if (!fs.existsSync(this.statePath)) return { schemaVersion: 1, projects: [] }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.projects)) return parsed
    } catch { /* fail closed below */ }
    this.loadError = '项目胶囊历史损坏，已拒绝覆盖；请先备份后修复'
    return { schemaVersion: 1, projects: [] }
  }

  assertReady() { if (this.loadError) throw new Error(this.loadError) }
  persist() {
    const temp = `${this.statePath}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    fs.renameSync(temp, this.statePath)
  }

  fileReceipt(input) {
    const resolved = fs.realpathSync(path.resolve(String(input?.path || input || '')))
    const stat = fs.statSync(resolved)
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('项目素材不是文件或目录')
    const supplied = input && typeof input === 'object' && /^[a-f0-9]{64}$/i.test(String(input.sha256 || ''))
    const fingerprint = supplied ? { sha256: input.sha256, bytes: Number(input.size ?? input.bytes) || stat.size, kind: stat.isDirectory() ? 'directory' : 'file' } : fingerprintArtifact(resolved)
    return { path: resolved, name: path.basename(resolved), kind: kindForPath(resolved), bytes: fingerprint.bytes, sha256: fingerprint.sha256, mtimeMs: Math.trunc(stat.mtimeMs) }
  }

  validate(receipt) {
    const current = this.fileReceipt(receipt.path)
    if (current.bytes !== Number(receipt.bytes) || current.sha256 !== receipt.sha256) throw new Error(`项目文件已发生变化：${receipt.name || path.basename(receipt.path)}`)
    return current.path
  }

  resolveProjectId(paths = []) {
    this.assertReady()
    const wanted = new Set(paths.map((item) => path.resolve(String(item?.path || item || '')).toLowerCase()))
    const project = [...this.state.projects].reverse().find((item) => (
      item.materials.some((material) => (material.locations || [material.path]).some((location) => wanted.has(path.resolve(location).toLowerCase())))
      || item.artifacts.some((artifact) => wanted.has(path.resolve(artifact.path).toLowerCase()))
    ))
    return project?.id || ''
  }

  newProjectId() { return `project-${this.idFactory()}` }

  recordTask({ projectId, taskId, type, instruction, sources = [], references = [], outputs = [], intermediateOutputs = [], historyId = '', operationKey = '', result = null } = {}) {
    this.assertReady()
    const taskKey = String(taskId || '').trim()
    if (!taskKey) throw new Error('项目任务标识不能为空')
    let project = this.state.projects.find((item) => item.id === projectId)
    if (!project) {
      const now = this.now()
      project = { schemaVersion: 1, id: projectId || this.newProjectId(), name: '', createdAt: now, updatedAt: now, materials: [], artifacts: [], references: [], instructions: [], revisions: [], current: null }
      this.state.projects.push(project)
    }
    const existing = project.revisions.find((item) => item.taskId === taskKey)
    if (existing) {
      for (const artifactId of existing.artifactIds) this.validate(project.artifacts.find((item) => item.id === artifactId))
      return this.capsule(project)
    }
    const sourceIds = []
    for (const source of sources) {
      const receipt = this.fileReceipt(source)
      const sourceArtifact = project.artifacts.find((item) => path.resolve(item.path).toLowerCase() === path.resolve(receipt.path).toLowerCase() && item.sha256 === receipt.sha256)
      if (sourceArtifact) {
        if (!sourceIds.includes(sourceArtifact.id)) sourceIds.push(sourceArtifact.id)
        continue
      }
      let material = project.materials.find((item) => item.sha256 === receipt.sha256 && item.bytes === receipt.bytes)
      if (!material) {
        const samePathRevisions = project.materials.filter((item) => (item.locations || []).some((location) => path.resolve(location).toLowerCase() === path.resolve(receipt.path).toLowerCase())).length
        material = { id: `material-${this.idFactory()}`, kind: receipt.kind, name: receipt.name, bytes: receipt.bytes, sha256: receipt.sha256, locations: [receipt.path], version: samePathRevisions + 1, addedAt: this.now() }
        project.materials.push(material)
      } else if (!material.locations.includes(receipt.path)) material.locations.push(receipt.path)
      if (!sourceIds.includes(material.id)) sourceIds.push(material.id)
    }
    for (const reference of references) {
      const uri = String(reference?.uri || reference || '').trim()
      if (uri && !project.references.some((item) => item.uri === uri)) project.references.push({ id: `reference-${this.idFactory()}`, kind: String(reference?.kind || 'web'), uri, addedAt: this.now() })
    }
    const instructionRecord = { id: `instruction-${this.idFactory()}`, text: String(instruction || ''), taskId: taskKey, createdAt: this.now() }
    project.instructions.push(instructionRecord)
    const artifactIds = []
    const allOutputs = [...intermediateOutputs.map((item) => ({ path: item, role: 'intermediate' })), ...outputs.map((item) => ({ path: item, role: 'deliverable' }))]
    for (const output of allOutputs) {
      const receipt = this.fileReceipt(output.path)
      let artifact = project.artifacts.find((item) => item.sha256 === receipt.sha256 && item.bytes === receipt.bytes)
      if (!artifact) {
        artifact = { id: `artifact-${this.idFactory()}`, role: output.role, kind: receipt.kind, path: receipt.path, name: receipt.name, bytes: receipt.bytes, sha256: receipt.sha256, derivedFrom: [...sourceIds], createdAt: this.now() }
        project.artifacts.push(artifact)
      }
      artifactIds.push(artifact.id)
    }
    const revision = { id: `revision-${this.idFactory()}`, number: project.revisions.length + 1, taskId: taskKey, type: String(type || ''), instructionId: instructionRecord.id, sourceIds, artifactIds, historyId: String(historyId || ''), operationKey: String(operationKey || ''), result: result ? clone(result) : null, createdAt: this.now() }
    project.revisions.push(revision)
    project.current = { revisionId: revision.id, revision: revision.number, artifactIds: [...artifactIds], primaryArtifactId: artifactIds.at(-1) || '' }
    project.name ||= project.materials[0]?.name || project.artifacts[0]?.name || 'AgentPlay 项目'
    project.updatedAt = this.now()
    project.materials = project.materials.slice(-500); project.artifacts = project.artifacts.slice(-500); project.instructions = project.instructions.slice(-200); project.revisions = project.revisions.slice(-300)
    this.state.projects = this.state.projects.slice(-200)
    this.persist()
    return this.capsule(project)
  }

  findReusable(projectId, operationKey) {
    this.assertReady()
    const project = this.state.projects.find((item) => item.id === projectId)
    const revision = project?.revisions.findLast((item) => item.operationKey && item.operationKey === operationKey)
    if (!project || !revision) return null
    const artifacts = revision.artifactIds.map((id) => project.artifacts.find((item) => item.id === id)).filter((item) => item?.role === 'deliverable')
    if (!artifacts.length) return null
    for (const sourceId of revision.sourceIds) {
      const material = project.materials.find((item) => item.id === sourceId)
      const sourceArtifact = project.artifacts.find((item) => item.id === sourceId)
      if (sourceArtifact) this.validate(sourceArtifact)
      else {
        if (!material?.locations?.[0]) throw new Error('项目素材清单不完整')
        this.validate({ ...material, path: material.locations[0] })
      }
    }
    for (const artifact of artifacts) this.validate(artifact)
    return { ...(revision.result || {}), projectCapsule: this.capsule(project), outputs: artifacts.map((item) => item.path), historyId: revision.historyId, reused: true }
  }

  get(projectId) { this.assertReady(); const project = this.state.projects.find((item) => item.id === projectId); return project ? clone(project) : null }
  list() { this.assertReady(); return [...this.state.projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map((item) => this.capsule(item)) }
  capsule(project) {
    const current = project.current || { revision: 0, artifactIds: [], primaryArtifactId: '' }
    const artifact = project.artifacts.find((item) => item.id === current.primaryArtifactId)
    return { schemaVersion: 1, projectId: project.id, name: project.name, revision: current.revision || 0, materialCount: project.materials.length, artifactCount: project.artifacts.length, currentPath: artifact?.path || '', currentArtifactId: artifact?.id || '', updatedAt: project.updatedAt }
  }
}

module.exports = { ProjectCapsuleStore, kindForPath }
