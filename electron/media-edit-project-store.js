const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

function quickFingerprint(filePath, stat = fs.statSync(filePath), fsImpl = fs) {
  const sampleSize = Math.min(128 * 1024, stat.size)
  const first = Buffer.alloc(sampleSize)
  const last = Buffer.alloc(sampleSize)
  const handle = fsImpl.openSync(filePath, 'r')
  try {
    fsImpl.readSync(handle, first, 0, sampleSize, 0)
    fsImpl.readSync(handle, last, 0, sampleSize, Math.max(0, stat.size - sampleSize))
  } finally {
    fsImpl.closeSync(handle)
  }
  return crypto.createHash('sha256').update(first).update(last).update(String(stat.size)).digest('hex')
}

class MediaEditProjectStore {
  constructor({ rootDir, fsImpl = fs, now = () => Date.now(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!rootDir) throw new Error('编辑项目目录不能为空')
    this.rootDir = path.resolve(rootDir)
    this.statePath = path.join(this.rootDir, 'media-edit-projects-v1.json')
    this.fs = fsImpl
    this.now = now
    this.idFactory = idFactory
    this.loadError = ''
    this.fs.mkdirSync(this.rootDir, { recursive: true })
    this.state = this.load()
  }

  load() {
    if (!this.fs.existsSync(this.statePath)) return { schemaVersion: 1, projects: [] }
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.statePath, 'utf8'))
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.projects)) return parsed
    } catch { /* handled below */ }
    this.loadError = '编辑项目历史损坏，已拒绝覆盖；请先备份历史文件后修复'
    return { schemaVersion: 1, projects: [] }
  }

  assertReady() {
    if (this.loadError) throw new Error(this.loadError)
  }

  persist() {
    const tempPath = `${this.statePath}.${process.pid}.tmp`
    this.fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    this.fs.renameSync(tempPath, this.statePath)
  }

  snapshot(filePath) {
    const resolved = this.fs.realpathSync(path.resolve(String(filePath || '')))
    const stat = this.fs.statSync(resolved)
    if (!stat.isFile()) throw new Error('编辑版本不是文件')
    return {
      path: resolved,
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
      fingerprint: quickFingerprint(resolved, stat, this.fs)
    }
  }

  validate(snapshot) {
    let resolved
    try { resolved = this.fs.realpathSync(path.resolve(String(snapshot?.path || ''))) } catch { throw new Error('编辑版本文件已不存在') }
    const stat = this.fs.statSync(resolved)
    const unchanged = stat.isFile()
      && stat.size === Number(snapshot.size)
      && Math.trunc(stat.mtimeMs) === Number(snapshot.mtimeMs)
      && quickFingerprint(resolved, stat, this.fs) === snapshot.fingerprint
    if (!unchanged) throw new Error(`编辑版本文件已发生变化：${path.basename(resolved)}`)
    return resolved
  }

  capsule(project) {
    const cursor = Math.max(0, Math.min(project.versions.length - 1, Number(project.cursor) || 0))
    const version = project.versions[cursor]
    return {
      schemaVersion: 1,
      projectId: project.id,
      versionId: version.id,
      currentPath: version.artifact.path,
      cursor,
      versionCount: project.versions.length,
      canUndo: cursor > 0,
      canRedo: cursor < project.versions.length - 1
    }
  }

  recordTrim({ taskId, sourcePath, outputPath, decision } = {}) {
    this.assertReady()
    const taskKey = String(taskId || '').trim()
    if (!taskKey) throw new Error('剪辑任务标识不能为空')
    const existingTask = this.state.projects.find((project) => project.versions.some((version) => version.taskId === taskKey))
    if (existingTask) return this.capsule(existingTask)

    const source = this.snapshot(sourcePath)
    const output = this.snapshot(outputPath)
    let project = this.state.projects.find((item) => item.versions.some((version) => path.resolve(version.artifact.path) === path.resolve(source.path)))
    const now = this.now()
    if (!project) {
      project = {
        schemaVersion: 1,
        id: `edit-${this.idFactory()}`,
        cursor: 0,
        createdAt: now,
        updatedAt: now,
        versions: [{ id: `version-${this.idFactory()}`, taskId: '', kind: 'source', artifact: source, decision: null, createdAt: now }]
      }
      this.state.projects.push(project)
    }
    const sourceIndex = project.versions.findIndex((version) => path.resolve(version.artifact.path) === path.resolve(source.path))
    if (sourceIndex < 0) throw new Error('剪辑源不属于当前编辑项目')
    this.validate(project.versions[sourceIndex].artifact)
    project.versions = project.versions.slice(0, sourceIndex + 1)
    project.versions.push({
      id: `version-${this.idFactory()}`,
      taskId: taskKey,
      kind: 'trim',
      artifact: output,
      decision: JSON.parse(JSON.stringify(decision || null)),
      createdAt: now
    })
    project.cursor = project.versions.length - 1
    project.updatedAt = now
    this.state.projects = this.state.projects.slice(-100)
    this.persist()
    return this.capsule(project)
  }

  navigate({ currentPath, direction } = {}) {
    this.assertReady()
    const resolved = path.resolve(String(currentPath || ''))
    const project = this.state.projects.find((item) => item.versions.some((version) => path.resolve(version.artifact.path) === resolved))
    if (!project) return { success: false, error: '当前视频还没有可撤销的编辑历史' }
    const currentIndex = project.versions.findIndex((version) => path.resolve(version.artifact.path) === resolved)
    const delta = direction === 'redo' ? 1 : direction === 'undo' ? -1 : 0
    if (!delta) return { success: false, error: '编辑历史动作无效' }
    const targetIndex = currentIndex + delta
    if (targetIndex < 0) return { success: false, error: '已经是最早版本，不能再撤销' }
    if (targetIndex >= project.versions.length) return { success: false, error: '没有可以重做的版本' }
    this.validate(project.versions[targetIndex].artifact)
    project.cursor = targetIndex
    project.updatedAt = this.now()
    this.persist()
    return { success: true, action: direction, ...this.capsule(project) }
  }
}

module.exports = { MediaEditProjectStore, quickFingerprint }
