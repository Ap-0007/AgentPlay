export const E5_GROUPS = Object.freeze(['trim', 'remove', 'music', 'visual', 'subtitle'])

export function validateTechnicalReceipt(receipt) {
  if (receipt?.schemaVersion !== 1 || receipt?.kind !== 'agentplay.professional-corpus-e5' || receipt?.installedAcceptance !== true) throw new Error('E5技术回执协议无效')
  const samples = Array.isArray(receipt.samples) ? receipt.samples : []
  if (samples.length < 20) throw new Error(`E5至少需要20个样本，当前${samples.length}`)
  const ids = new Set(samples.map((item) => item.id))
  if (ids.size !== samples.length) throw new Error('E5样本ID重复')
  for (const group of E5_GROUPS) if (samples.filter((item) => item.group === group).length < 4) throw new Error(`E5组${group}不足4条`)
  if (samples.some((item) => item.license !== 'self-generated' || item.sourceHashUnchanged !== true || item.qualityScore !== 100 || item.output?.decodePassed !== true || item.governance?.verifiedStep !== true)) throw new Error('E5存在来源、质量、解码或治理未通过样本')
  if (receipt.performance?.sampleCount !== samples.length || !(receipt.performance.totalElapsedMs > 0) || !(receipt.performance.p95ElapsedMs > 0)) throw new Error('E5性能报告不完整')
  if (receipt.cost?.cloudCalls !== 0 || receipt.cost?.estimatedUsd !== 0 || receipt.cost?.basis !== 'local-deterministic-acceptance') throw new Error('E5成本报告不得伪造云端调用或费用')
  if (receipt.restart?.persisted !== true || receipt.restart?.repeatedCompletedTasks !== 0) throw new Error('E5安装态重启恢复不合格')
  return receipt
}

export function validateManualReview(review, technical) {
  validateTechnicalReceipt(technical)
  if (review?.schemaVersion !== 1 || review?.kind !== 'agentplay.professional-corpus-e5-manual-review' || !String(review.reviewer || '').trim()) throw new Error('E5人工复核协议无效')
  const decisions = Array.isArray(review.decisions) ? review.decisions : []
  if (decisions.length !== technical.samples.length) throw new Error('E5人工复核没有逐样本覆盖')
  const byId = new Map(decisions.map((item) => [item.id, item]))
  for (const sample of technical.samples) {
    const item = byId.get(sample.id)
    if (!item || item.verdict !== 'pass' || item.visualContinuity !== true || item.operationMatched !== true || item.artifactFree !== true || !String(item.note || '').trim()) throw new Error(`E5人工复核未通过：${sample.id}`)
  }
  return { ...technical, manualReview: { reviewer: review.reviewer, reviewedAt: review.reviewedAt, sampleCount: decisions.length, passed: decisions.length, failed: 0, verdict: 'passed', contactSheets: review.contactSheets } }
}

export function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
}
