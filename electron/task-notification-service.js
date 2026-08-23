const fs = require('fs')
const path = require('path')

const NOTIFIABLE_STATES = new Set(['waiting_approval', 'completed', 'failed'])
const TYPE_LABELS = Object.freeze({
  'document.run': '文档任务',
  'analysis.run': '视频解剖',
  'outcome.workflow': '视频内容成果包',
  'project.evidence-qa': '跨素材证据问答',
  'subtitle.generate': '字幕任务',
  'creative.video-generate': 'AI 视频创作',
  'creative.recut-short': '视频重构',
  'media.batch': '批量媒体任务',
  'media.compress': '视频压缩'
})

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value))
const clean = (value, max = 180) => String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max)

function taskLabel(task) {
  const type = String(task?.type || '')
  if (TYPE_LABELS[type]) return TYPE_LABELS[type]
  if (type.startsWith('download.')) return '下载任务'
  if (type.startsWith('media.edit-')) return '视频剪辑'
  if (type.startsWith('media.')) return '媒体任务'
  if (type.startsWith('creative.')) return '创作任务'
  return 'AgentPlay 任务'
}

function firstOutput(task) {
  const outputs = Array.isArray(task?.result?.outputs) ? task.result.outputs : task?.result?.outputPath ? [task.result.outputPath] : []
  return String(outputs.find(Boolean) || '')
}

function notificationText(task) {
  const label = taskLabel(task)
  if (task.state === 'waiting_approval') {
    return { title: 'AgentPlay 任务等待确认', body: clean(`${label}：${task.approval?.summary || '需要你确认后继续'}`) }
  }
  if (task.state === 'failed') {
    return { title: 'AgentPlay 任务失败', body: clean(`${label}：${task.failure?.message || task.error || '处理未完成'}`) }
  }
  const outputPath = firstOutput(task)
  const detail = outputPath ? `已生成 ${path.basename(outputPath)}` : task.result?.summary || '处理已完成'
  return { title: 'AgentPlay 已完成', body: clean(`${label}：${detail}`) }
}

class TaskNotificationService {
  constructor({ rootDir, now = () => Date.now(), notificationFactory = null, isSupported = () => false, shouldShowNative = () => true, onActivate = null, logger = null } = {}) {
    if (!rootDir) throw new Error('任务通知目录不能为空')
    this.rootDir = path.resolve(rootDir)
    this.statePath = path.join(this.rootDir, 'task-notifications-v1.json')
    this.now = now
    this.notificationFactory = notificationFactory
    this.isSupported = isSupported
    this.shouldShowNative = shouldShowNative
    this.onActivate = typeof onActivate === 'function' ? onActivate : null
    this.logger = logger
    fs.mkdirSync(this.rootDir, { recursive: true })
    this.state = this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      return { schemaVersion: 1, notifications: (Array.isArray(parsed.notifications) ? parsed.notifications : []).slice(-100) }
    } catch {
      return { schemaVersion: 1, notifications: [] }
    }
  }

  persist() {
    const temp = `${this.statePath}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    fs.renameSync(temp, this.statePath)
  }

  history() { return clone(this.state.notifications) }

  notify(task = {}) {
    if (!NOTIFIABLE_STATES.has(task.state) || !task.id) return null
    const key = `${task.id}:${task.state}`
    const existing = this.state.notifications.find((item) => item.key === key)
    if (existing) return clone(existing)
    const outputPath = firstOutput(task)
    const text = notificationText(task)
    const record = {
      schemaVersion: 1,
      id: `notification-${this.now()}-${this.state.notifications.length + 1}`,
      key,
      runtimeTaskId: String(task.id),
      workspaceTaskId: String(task.workspaceTaskId || ''),
      taskType: String(task.type || ''),
      state: String(task.state),
      title: text.title,
      body: text.body,
      outputPath,
      nativeShown: false,
      nativeSupported: Boolean(this.isSupported()),
      createdAt: this.now(),
      activatedAt: null
    }
    this.state.notifications.push(record)
    this.state.notifications = this.state.notifications.slice(-100)
    this.persist()
    if (!record.nativeSupported || !this.notificationFactory || !this.shouldShowNative(task)) return clone(record)
    try {
      const native = this.notificationFactory({ title: record.title, body: record.body, silent: false })
      native.once?.('click', () => this.activate(record.id))
      native.once?.('failed', (_event, error) => this.logger?.warn?.('系统通知显示失败', error))
      native.show()
      record.nativeShown = true
      this.persist()
    } catch (error) {
      this.logger?.warn?.('系统通知创建失败', error)
    }
    return clone(record)
  }

  activate(id) {
    const record = this.state.notifications.find((item) => item.id === String(id || ''))
    if (!record) return false
    record.activatedAt = this.now()
    this.persist()
    try { this.onActivate?.(clone(record)) } catch (error) { this.logger?.warn?.('通知点击路由失败', error) }
    return true
  }
}

module.exports = { TaskNotificationService, NOTIFIABLE_STATES, notificationText, taskLabel, firstOutput }
