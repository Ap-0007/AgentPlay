const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const APPROVAL_ACTIONS = Object.freeze(['cloud', 'paid', 'publish', 'delete', 'credential'])
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex')
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function safeId(value, fallback) {
  const text = String(value || fallback || '').trim()
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(text)) throw new Error('任务标识无效')
  return text
}

class PersistentTaskRuntime {
  constructor({ rootDir, now = () => Date.now(), logger = null, onChange = null, qualityEvaluator = null, onQuality = null, failureClassifier = null, prepareRepair = null, maxQualityRepairs = 1 } = {}) {
    if (!rootDir) throw new Error('持久任务目录不能为空')
    this.rootDir = path.resolve(rootDir)
    this.statePath = path.join(this.rootDir, 'task-runtime-v1.json')
    this.secretPath = path.join(this.rootDir, 'task-runtime-secret.bin')
    this.now = now
    this.logger = logger
    this.onChange = typeof onChange === 'function' ? onChange : null
    this.qualityEvaluator = typeof qualityEvaluator === 'function' ? qualityEvaluator : null
    this.onQuality = typeof onQuality === 'function' ? onQuality : null
    this.failureClassifier = typeof failureClassifier === 'function' ? failureClassifier : null
    this.prepareRepair = typeof prepareRepair === 'function' ? prepareRepair : null
    this.maxQualityRepairs = Math.max(0, Math.min(2, Number(maxQualityRepairs) || 0))
    this.executors = new Map()
    this.active = new Map()
    fs.mkdirSync(this.rootDir, { recursive: true })
    this.secret = this.loadSecret()
    this.state = this.loadState()
  }

  loadSecret() {
    try {
      const existing = fs.readFileSync(this.secretPath)
      if (existing.length >= 32) return existing
    } catch { /* 首次创建 */ }
    const secret = crypto.randomBytes(32)
    const temp = `${this.secretPath}.${process.pid}.tmp`
    fs.writeFileSync(temp, secret, { mode: 0o600 })
    fs.renameSync(temp, this.secretPath)
    return secret
  }

  loadState() {
    let parsed = { version: 1, tasks: [] }
    try { parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) } catch { /* 首次创建或旧文件无效 */ }
    const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : []).slice(-200).map((raw) => {
      const task = {
        ...raw,
        spec: clone(raw.spec || {}), checkpoint: clone(raw.checkpoint || {}), result: clone(raw.result || null),
        quality: clone(raw.quality || null), failure: clone(raw.failure || null),
        repairHistory: Array.isArray(raw.repairHistory) ? clone(raw.repairHistory).slice(-4) : []
      }
      if (!task.specHash || sha256(task.spec) !== task.specHash) {
        task.state = 'failed'
        task.error = '执行规范完整性校验失败，已拒绝恢复'
        task.completedAt = this.now()
      }
      return task
    })
    return { version: 1, tasks }
  }

  persist() {
    const temp = `${this.statePath}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), 'utf8')
    fs.renameSync(temp, this.statePath)
  }

  tokenFor(purpose, id, specHash, expiresAt = 0) {
    return crypto.createHmac('sha256', this.secret).update(`${purpose}:${id}:${specHash}:${expiresAt}`).digest('base64url')
  }

  publicTask(task) {
    if (!task) return null
    const snapshot = clone(task)
    snapshot.resumeToken = this.tokenFor('resume', task.id, task.specHash)
    if (snapshot.approval?.status === 'pending') {
      snapshot.approval.token = this.tokenFor('approval', snapshot.approval.id, task.specHash, snapshot.approval.expiresAt)
    }
    return snapshot
  }

  register(type, executor, { autoResume = false } = {}) {
    if (typeof executor !== 'function') throw new Error('任务执行器必须是函数')
    this.executors.set(String(type), { executor, autoResume: Boolean(autoResume) })
    return this
  }

  enqueue({ id, type, spec, workspaceTaskId = '', approval = null } = {}) {
    const taskId = safeId(id, `task-${crypto.randomUUID()}`)
    const existing = this.state.tasks.find((item) => item.id === taskId)
    if (existing) return this.publicTask(existing)
    const frozenSpec = clone(spec || {})
    const specHash = sha256(frozenSpec)
    const createdAt = this.now()
    let approvalRecord = null
    if (approval) {
      const action = String(approval.action || '')
      if (!APPROVAL_ACTIONS.includes(action)) throw new Error('审批动作不在允许范围')
      const ttlMs = Math.max(1000, Math.min(24 * 60 * 60 * 1000, Number(approval.ttlMs) || 15 * 60 * 1000))
      approvalRecord = {
        id: safeId(approval.id, `approval-${crypto.randomUUID()}`),
        action,
        summary: String(approval.summary || '需要确认后继续'),
        status: 'pending',
        createdAt,
        expiresAt: createdAt + ttlMs,
        consumedAt: null
      }
    }
    const task = {
      id: taskId,
      workspaceTaskId: String(workspaceTaskId || ''),
      type: String(type || ''),
      state: approvalRecord ? 'waiting_approval' : 'queued',
      spec: frozenSpec,
      specHash,
      checkpoint: {},
      result: null,
      quality: null,
      failure: null,
      repairHistory: [],
      error: '',
      status: approvalRecord ? '等待确认' : '等待开始',
      approval: approvalRecord,
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null
    }
    this.state.tasks.push(task)
    this.state.tasks = this.state.tasks.slice(-200)
    this.persist()
    return this.publicTask(task)
  }

  get(id) {
    return this.publicTask(this.state.tasks.find((task) => task.id === String(id || '')))
  }

  list() {
    return this.state.tasks.map((task) => this.publicTask(task))
  }

  update(task, patch) {
    Object.assign(task, clone(patch), { updatedAt: this.now() })
    this.persist()
    const snapshot = this.publicTask(task)
    try { this.onChange?.(snapshot) } catch (error) { this.logger?.warn?.('持久任务状态通知失败', error) }
    return snapshot
  }

  approve(approvalId, token) {
    const task = this.state.tasks.find((item) => item.approval?.id === String(approvalId || ''))
    if (!task) throw new Error('审批对象不存在')
    if (task.approval.status !== 'pending') throw new Error('审批令牌已经使用')
    if (this.now() > task.approval.expiresAt) {
      this.update(task, { state: 'failed', error: '审批令牌已经过期', completedAt: this.now(), approval: { ...task.approval, status: 'expired' } })
      throw new Error('审批令牌已经过期')
    }
    const expected = this.tokenFor('approval', task.approval.id, task.specHash, task.approval.expiresAt)
    const provided = Buffer.from(String(token || ''))
    const expectedBuffer = Buffer.from(expected)
    if (provided.length !== expectedBuffer.length || !crypto.timingSafeEqual(provided, expectedBuffer)) throw new Error('审批令牌无效')
    return this.update(task, {
      state: 'queued',
      status: '已确认，等待继续',
      approval: { ...task.approval, status: 'approved', consumedAt: this.now() }
    })
  }

  verifyResume(id, token) {
    const task = this.state.tasks.find((item) => item.id === String(id || ''))
    if (!task) throw new Error('恢复任务不存在')
    const expected = this.tokenFor('resume', task.id, task.specHash)
    const provided = Buffer.from(String(token || ''))
    const expectedBuffer = Buffer.from(expected)
    if (provided.length !== expectedBuffer.length || !crypto.timingSafeEqual(provided, expectedBuffer)) throw new Error('恢复令牌无效')
    return task
  }

  async resume(id, token) {
    const task = this.verifyResume(id, token)
    if (task.state === 'waiting_approval') throw new Error('任务仍在等待审批')
    if (task.state === 'completed') return this.publicTask(task)
    if (task.state === 'cancelled') throw new Error('任务已经取消')
    if (task.state === 'failed') this.update(task, { state: 'queued', error: '', completedAt: null, status: '等待恢复' })
    return this.run(task.id)
  }

  async run(id) {
    const task = this.state.tasks.find((item) => item.id === String(id || ''))
    if (!task) throw new Error('任务不存在')
    if (this.active.has(task.id)) return this.active.get(task.id).promise
    if (task.state === 'waiting_approval') return this.publicTask(task)
    if (TERMINAL_STATES.has(task.state)) return this.publicTask(task)
    if (sha256(task.spec) !== task.specHash) return this.update(task, { state: 'failed', error: '执行规范完整性校验失败，已拒绝执行', completedAt: this.now() })
    const registration = this.executors.get(task.type)
    if (!registration) return this.update(task, { state: 'failed', error: `没有注册任务执行器：${task.type}`, completedAt: this.now() })
    const controller = new AbortController()
    const promise = (async () => {
      this.update(task, { state: 'running', status: task.attempts > 0 ? '正在从检查点恢复' : '正在执行', attempts: task.attempts + 1, startedAt: task.startedAt || this.now(), completedAt: null, failure: null })
      try {
        const executeOnce = () => registration.executor({
          task: this.publicTask(task), signal: controller.signal,
          checkpoint: (patch) => this.update(task, { checkpoint: { ...task.checkpoint, ...clone(patch) } }),
          status: (status) => this.update(task, { status: String(status || '') })
        })
        let result = await executeOnce()
        let quality = this.qualityEvaluator ? await this.qualityEvaluator(task.type, result || {}, task.spec || {}) : null
        const embeddedRepairs = Array.isArray(result?.domainRepairHistory) ? result.domainRepairHistory : []
        const repairHistory = [...(Array.isArray(task.repairHistory) ? task.repairHistory : []), ...embeddedRepairs]
          .filter((item, index, items) => items.findIndex((candidate) => candidate?.action === item?.action && candidate?.completedAt === item?.completedAt) === index)
          .slice(-4)
        let repairsThisRun = 0
        while (quality && !quality.passed && this.prepareRepair && repairsThisRun < this.maxQualityRepairs) {
          const repairPlan = await this.prepareRepair({ task: this.publicTask(task), result: clone(result || {}), quality: clone(quality), attempt: repairsThisRun + 1 })
          if (!repairPlan) break
          repairsThisRun += 1
          this.update(task, {
            status: `质量评分 ${quality.score}/${quality.threshold}，正在自动修复（${repairsThisRun}/${this.maxQualityRepairs}）`,
            quality: clone(quality),
            checkpoint: clone(repairPlan.checkpoint || task.checkpoint)
          })
          const before = quality
          result = await executeOnce()
          quality = this.qualityEvaluator ? await this.qualityEvaluator(task.type, result || {}, task.spec || {}) : null
          repairHistory.push({
            attempt: repairHistory.length + 1,
            action: String(repairPlan.action || '重新执行未通过的质量步骤'),
            fromScore: Number(before?.score) || 0,
            toScore: Number(quality?.score) || 0,
            passed: quality?.passed === true,
            reasons: Array.isArray(before?.reasons) ? before.reasons.map((item) => String(item?.message || item?.code || '')).filter(Boolean).slice(0, 6) : [],
            completedAt: this.now()
          })
          this.update(task, { quality: clone(quality), repairHistory: repairHistory.slice(-4) })
        }
        if (quality && this.onQuality) {
          try {
            await this.onQuality({ task: this.publicTask(task), quality: clone(quality) })
          } catch (error) {
            this.logger?.warn?.('任务质量回执记录失败', error)
          }
        }
        if (quality && !quality.passed) {
          const failure = {
            code: 'QUALITY_GATE_FAILED',
            message: `成果质量评分 ${quality.score}/${quality.threshold}，未达到交付标准`,
            retryable: Array.isArray(quality.reasons) && quality.reasons.some((item) => item?.repairable)
          }
          return this.update(task, {
            state: 'failed', status: '质量检查未通过', result: clone(result || {}), quality: clone(quality),
            repairHistory: repairHistory.slice(-4), failure, error: failure.message, completedAt: this.now()
          })
        }
        const completedResult = quality ? { ...(result || {}), quality: clone(quality), repairHistory: repairHistory.slice(-4) } : result
        return this.update(task, {
          state: 'completed', status: quality?.level === 'warning' ? '已完成（有质量提示）' : '已完成',
          result: clone(completedResult || {}), quality: clone(quality), repairHistory: repairHistory.slice(-4),
          failure: null, error: '', completedAt: this.now()
        })
      } catch (error) {
        if (controller.signal.aborted) return this.update(task, { state: 'cancelled', status: '已取消', error: '任务已取消', completedAt: this.now() })
        this.logger?.error?.('持久任务执行失败', error)
        const failure = this.failureClassifier
          ? this.failureClassifier(error, task.type)
          : { code: 'EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error), retryable: true }
        return this.update(task, { state: 'failed', status: '执行失败', failure, error: failure.message, completedAt: this.now() })
      } finally {
        this.active.delete(task.id)
      }
    })()
    this.active.set(task.id, { promise, controller })
    return promise
  }

  async startRecoverable() {
    const runs = []
    for (const task of this.state.tasks) {
      const registration = this.executors.get(task.type)
      if (!registration?.autoResume || task.state === 'waiting_approval' || TERMINAL_STATES.has(task.state)) continue
      if (task.state === 'running') this.update(task, { state: 'queued', status: '检测到程序中断，准备从检查点恢复' })
      if (task.state === 'queued') runs.push(this.run(task.id))
    }
    return Promise.all(runs)
  }

  cancel(id) {
    const task = this.state.tasks.find((item) => item.id === String(id || ''))
    if (!task) return false
    const active = this.active.get(task.id)
    if (active) {
      active.controller.abort()
      return true
    }
    if (!TERMINAL_STATES.has(task.state)) this.update(task, { state: 'cancelled', status: '已取消', error: '任务已取消', completedAt: this.now() })
    return true
  }

  markRunningForTest(id, checkpoint = {}) {
    const task = this.state.tasks.find((item) => item.id === String(id || ''))
    if (!task) throw new Error('任务不存在')
    return this.update(task, { state: 'running', attempts: task.attempts + 1, checkpoint: clone(checkpoint), startedAt: this.now() })
  }
}

module.exports = { PersistentTaskRuntime, APPROVAL_ACTIONS, canonical, sha256 }
