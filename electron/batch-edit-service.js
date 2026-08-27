class BatchEditService {
  constructor({ executeItem, evaluateItem, classifyFailure, cleanupOutput = () => {} } = {}) {
    this.executeItem = executeItem
    this.evaluateItem = evaluateItem
    this.classifyFailure = classifyFailure
    this.cleanupOutput = cleanupOutput
  }

  async run({ task, signal, checkpoint, status }) {
    const items = Array.isArray(task.spec?.items) ? task.spec.items : []
    const saved = Array.isArray(task.checkpoint?.items) ? task.checkpoint.items : []
    const results = saved.filter((item) => item && ['succeeded', 'failed'].includes(item.state)).slice(0, items.length)
    let repeatedCompletedItems = 0
    for (let index = results.length; index < items.length; index += 1) {
      if (signal?.aborted) throw new DOMException('批量编辑已停止', 'AbortError')
      const item = items[index]
      status?.(`（${index + 1}/${items.length}）正在编辑 ${item.sourceName}`)
      try {
        const completed = await this.executeItem({ item, task, signal, index })
        const quality = this.evaluateItem(item.taskType, completed, { decision: item.decision })
        if (!quality?.passed) {
          await this.cleanupOutput(item.outputPath)
          const qualityError = new Error(quality?.reasons?.[0]?.message || '逐条质量验收未通过')
          qualityError.code = quality?.reasons?.[0]?.code || 'ITEM_QUALITY_FAILED'
          throw qualityError
        }
        results.push({
          id: item.id, sourceName: item.sourceName, state: 'succeeded', outputPath: item.outputPath,
          qualityScore: quality.score, sourceFingerprint: item.sources?.[0]?.fingerprint || '', result: completed
        })
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error
        await this.cleanupOutput(item.outputPath)
        const failure = this.classifyFailure(error, item.taskType)
        results.push({ id: item.id, sourceName: item.sourceName, state: 'failed', sourceFingerprint: item.sources?.[0]?.fingerprint || '', failure })
      }
      checkpoint?.({ stage: 'item-complete', nextIndex: index + 1, items: results })
    }
    const successful = results.filter((item) => item.state === 'succeeded')
    const failed = results.filter((item) => item.state === 'failed')
    const receipt = {
      schemaVersion: 1,
      method: 'independent-media-edit-batch-v1',
      verdict: failed.length ? 'complete-with-isolated-failures' : 'matched',
      planDigest: task.spec.planDigest,
      total: items.length,
      successCount: successful.length,
      failureCount: failed.length,
      everyItemTerminal: results.length === items.length,
      items: results.map(({ result, ...item }) => item),
      recovery: { repeatedCompletedItems }
    }
    const result = {
      success: true,
      outputs: successful.map((item) => item.outputPath),
      results,
      batchEditReceipt: receipt,
      summary: `批量编辑完成：成功 ${successful.length}/${items.length}${failed.length ? `，失败 ${failed.length} 条已隔离` : ''}`
    }
    checkpoint?.({ stage: 'artifact-written', nextIndex: items.length, items: results, result })
    return result
  }
}

module.exports = { BatchEditService }
