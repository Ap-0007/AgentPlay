const { AgentRunLedger } = require('./agent-run-ledger')
const { canonical, sha256 } = require('./persistent-task-runtime')

const TASK_ROWS = [
  ['media.edit-trim', 'media.trim'], ['media.edit-remove', 'media.remove-segment'], ['media.edit-music', 'media.add-music'],
  ['media.edit-audio-mix', 'media.mix-audio'], ['media.audio-repair', 'media.repair-audio'], ['media.rhythm-edit', 'media.rhythm-edit'],
  ['media.edit-concat', 'media.concat-segments'], ['media.edit-visual-effects', 'media.visual-effects'], ['media.smart-reframe', 'media.smart-reframe'],
  ['media.visual-repair', 'media.visual-repair'], ['media.version-bundle', 'media.version-bundle-plan'], ['media.edit-concat-sources', 'media.concat-sources'],
  ['media.edit-burn-subtitles', 'media.burn-subtitles'], ['media.edit-mux-subtitles', 'media.mux-subtitles'], ['media.shift-subtitles', 'media.shift-subtitles'],
  ['media.translate-subtitles', 'media.translate-subtitles'], ['media.edit-subtitle-cues', 'media.edit-subtitle-cues'], ['media.transform-subtitles', 'media.transform-subtitles'],
  ['media.subtitle-layout-variants', 'media.subtitle-layout-variants'], ['media.batch-edit', 'media.batch-edit-plan']
]
const MEDIA_EDIT_TASKS = Object.freeze(Object.fromEntries(TASK_ROWS.map(([taskType, decisionKind]) => [taskType, Object.freeze({ taskType, decisionKind, tool: decisionKind })])))

function decisionKindFor({ taskType, decision } = {}) {
  if (taskType === 'media.version-bundle') return 'media.version-bundle-plan'
  if (taskType === 'media.batch-edit') return 'media.batch-edit-plan'
  return String(decision?.kind || '')
}

function planningModels(decision = {}, plan = {}) {
  const values = [decision?.semanticCut?.modelEvidence?.model, decision?.semanticCut?.visualEvidence?.model, decision?.semanticSelect?.model, decision?.reframe?.model, plan?.model].filter(Boolean)
  const seen = new Set()
  return values.map((item) => ({ providerId: String(item.providerId || ''), model: String(item.model || ''), local: Boolean(item.local) }))
    .filter((item) => item.providerId && item.model && !seen.has(`${item.providerId}:${item.model}`) && seen.add(`${item.providerId}:${item.model}`))
}

function freezeMediaEditGovernance({ taskType, decision = null, plan = null, modelRoute = null, approvalContract = null, itemCount = 1 } = {}) {
  const definition = MEDIA_EDIT_TASKS[taskType]
  if (!definition) throw new Error(`编辑任务没有进入统一治理注册表：${taskType}`)
  const decisionKind = decisionKindFor({ taskType, decision })
  if (decisionKind !== definition.decisionKind) throw new Error(`编辑任务与冻结决策不一致：${taskType}/${decisionKind}`)
  const route = modelRoute ? { providerId: String(modelRoute.providerId || ''), model: String(modelRoute.model || ''), baseUrl: String(modelRoute.baseUrl || ''), local: Boolean(modelRoute.local), taskKind: String(modelRoute.taskKind || '') } : null
  if (route && (!route.providerId || !route.model || !route.baseUrl)) throw new Error('编辑任务的冻结模型路由不完整')
  const requiresApproval = Boolean(route && !route.local)
  if (requiresApproval && !['cloud', 'paid'].includes(String(approvalContract?.action || ''))) throw new Error('云端编辑任务缺少统一审批对象')
  const count = Math.max(1, Math.min(20, Number(itemCount) || 1))
  const body = {
    schemaVersion: 1, strategy: 'shared-media-edit-governance-v1', taskType, decisionKind,
    registry: { name: 'media-edit-governance-v1', executor: definition.tool, hiddenExecutor: false },
    runtime: { name: 'PersistentTaskRuntime', autoResume: true, specHashRequired: true },
    model: { execution: route, planningEvidence: planningModels(decision, plan) },
    approval: { required: requiresApproval, action: requiresApproval ? approvalContract.action : 'none', scope: requiresApproval ? 'task-bound-token' : 'local-or-preplanned' },
    budget: { maxTurns: 1, maxToolCalls: 1, maxElapsedMs: Math.min(21600000, Math.max(1800000, count * 1800000)) }, itemCount: count
  }
  return { ...body, digest: sha256(canonical(body)) }
}

function assertMediaEditGovernance(value, context = {}) {
  if (!value || value.schemaVersion !== 1 || value.strategy !== 'shared-media-edit-governance-v1') throw new Error('编辑任务缺少统一治理协议')
  const unsigned = { ...value }; delete unsigned.digest
  if (sha256(canonical(unsigned)) !== value.digest) throw new Error('编辑治理协议已被修改')
  if (value.taskType !== context.taskType || value.decisionKind !== decisionKindFor(context)) throw new Error('编辑治理协议与当前任务不一致')
  if (value.registry?.hiddenExecutor !== false || value.runtime?.name !== 'PersistentTaskRuntime' || value.runtime?.autoResume !== true) throw new Error('编辑任务试图绕过统一执行或恢复协议')
  if (value.budget?.maxTurns !== 1 || value.budget?.maxToolCalls !== 1 || !(value.budget?.maxElapsedMs > 0)) throw new Error('编辑治理预算无效')
  if (value.model?.execution) for (const key of ['providerId', 'model', 'baseUrl']) if (String(context.modelRoute?.[key] || '') !== String(value.model.execution[key] || '')) throw new Error('编辑任务模型路由与冻结治理协议不一致')
  return value
}

async function runGovernedMediaEdit({ task, executor }) {
  const governance = task.spec?.editGovernance
    ? assertMediaEditGovernance(task.spec.editGovernance, { taskType: task.type, decision: task.spec?.decision, modelRoute: task.spec?.modelRoute })
    : freezeMediaEditGovernance({ taskType: task.type, decision: task.spec?.decision, plan: task.spec?.plan, modelRoute: task.spec?.modelRoute, approvalContract: task.approval?.action ? { action: task.approval.action } : null, itemCount: task.spec?.items?.length || task.spec?.plannedOutputs?.length || 1 })
  if (governance.approval.required && task.approval?.status !== 'approved') throw new Error('编辑任务的审批对象尚未消费')
  const ledger = new AgentRunLedger({ requestId: `${task.id}:edit`, mode: 'work', maxTurns: 1, maxToolCalls: 1, maxElapsedMs: governance.budget.maxElapsedMs })
  ledger.beginTurn()
  const ticket = ledger.beginTool({ name: governance.registry.executor, description: governance.registry.executor }, { taskType: task.type, itemCount: governance.itemCount })
  if (!ticket.allowed) throw new Error(ticket.error)
  try {
    const result = await executor()
    ledger.finishTool(ticket.step, { success: true, execution: 'main', verified: true, desc: '主进程持久编辑执行完成' })
    return { ...result, editGovernanceReceipt: { schemaVersion: 1, strategy: 'shared-media-edit-governance-receipt-v1', verdict: 'matched', governanceDigest: governance.digest, taskType: task.type, approval: { ...governance.approval, status: governance.approval.required ? task.approval.status : 'not-required' }, run: ledger.finish() } }
  } catch (error) {
    ledger.finishTool(ticket.step, { success: false, execution: 'main', error: error instanceof Error ? error.message : String(error) })
    ledger.finish({ failed: true })
    throw error
  }
}

module.exports = { MEDIA_EDIT_TASKS, assertMediaEditGovernance, freezeMediaEditGovernance, runGovernedMediaEdit }
