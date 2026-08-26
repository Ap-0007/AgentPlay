const path = require('path')
const { canonical, sha256 } = require('./persistent-task-runtime')
const { compileEditDecisionList, compileMusicDecisionList } = require('./media-edit-decision')
const { compileVisualEffectDecision, matchesVisualEffectInstruction } = require('./visual-effect-decision')

const TASK_BY_KIND = Object.freeze({
  'media.trim': 'media.edit-trim',
  'media.remove-segment': 'media.edit-remove',
  'media.add-music': 'media.edit-music',
  'media.visual-effects': 'media.edit-visual-effects'
})

function compileOne({ instruction, sourcePath }) {
  if (matchesVisualEffectInstruction(instruction)) return compileVisualEffectDecision({ instruction, sourcePath }).decision || null
  return compileMusicDecisionList({ instruction, sourcePath }) || compileEditDecisionList({ instruction, sourcePath })
}

function compileBatchEditPlan({ instruction, sourcePaths, applyDecision = (decision) => decision } = {}) {
  const text = String(instruction || '').trim()
  const paths = Array.isArray(sourcePaths) ? sourcePaths.map((item) => path.resolve(String(item || ''))).filter(Boolean) : []
  if (paths.length < 2 || paths.length > 20) return { matched: false, error: '批量编辑需要选择 2–20 个视频' }
  const items = paths.map((sourcePath, index) => {
    const raw = compileOne({ instruction: text, sourcePath })
    const decision = raw ? applyDecision(raw, { instruction: text, sourcePath }) : null
    const taskType = TASK_BY_KIND[decision?.kind]
    if (!decision || !taskType) throw new Error(`第 ${index + 1} 个视频无法形成受支持的唯一编辑方案`)
    const dependencies = decision.kind === 'media.add-music'
      ? [path.resolve(String(decision.audio?.path || ''))]
      : decision.kind === 'media.visual-effects'
        ? (decision.effectSources || []).map((item) => path.resolve(String(item?.path || '')))
        : []
    return { id: `item-${index + 1}`, sourcePath, taskType, decision, dependencies }
  })
  const kinds = new Set(items.map((item) => item.decision.kind))
  if (kinds.size !== 1) throw new Error('批量任务中的每个视频必须使用同一种编辑操作')
  const frozen = {
    schemaVersion: 1,
    kind: 'media.batch-edit-plan',
    strategy: 'independent-media-edit-batch-v1',
    instruction: text,
    operation: items[0].decision.kind,
    items
  }
  return { matched: true, plan: { ...frozen, digest: sha256(canonical(frozen)) } }
}

function assertBatchEditPlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || plan.kind !== 'media.batch-edit-plan' || plan.strategy !== 'independent-media-edit-batch-v1') throw new Error('批量编辑冻结方案无效')
  if (!Array.isArray(plan.items) || plan.items.length < 2 || plan.items.length > 20) throw new Error('批量编辑冻结方案的素材数量无效')
  const unsigned = { ...plan }; delete unsigned.digest
  if (sha256(canonical(unsigned)) !== plan.digest) throw new Error('批量编辑冻结方案已被修改')
  if (new Set(plan.items.map((item) => item?.decision?.kind)).size !== 1) throw new Error('批量编辑冻结方案混入了不同操作')
  for (const [index, item] of plan.items.entries()) {
    if (!item?.id || !item.sourcePath || !TASK_BY_KIND[item?.decision?.kind] || item.taskType !== TASK_BY_KIND[item.decision.kind]) throw new Error(`批量编辑第 ${index + 1} 项无效`)
    if (path.resolve(String(item.decision?.source?.path || '')) !== path.resolve(String(item.sourcePath))) throw new Error(`批量编辑第 ${index + 1} 项的来源不一致`)
  }
  return plan
}

module.exports = { compileBatchEditPlan, assertBatchEditPlan, TASK_BY_KIND }
