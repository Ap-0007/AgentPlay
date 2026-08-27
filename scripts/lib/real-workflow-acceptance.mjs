const REQUIRED = Object.freeze({
  contract: { formats: ['docx', 'xlsx', 'pdf'], minSources: 1, minChars: 1000, minBytes: 10 * 1024 },
  research: { formats: ['docx', 'pptx', 'xlsx'], minSources: 2, minChars: 5000, minBytes: 1000 },
  'video-content-package': { formats: ['docx', 'pptx', 'xlsx'], minSources: 1, minChars: 0, minBytes: 1024 * 1024 }
})

function assertSha(value, label) {
  if (!/^[a-f0-9]{64}$/i.test(String(value || ''))) throw new Error(`${label}缺少 SHA-256`)
}

export function assertRealWorkflowAcceptance(receipt, { exists = () => true, digest = () => '' } = {}) {
  if (receipt?.schemaVersion !== 1 || receipt?.kind !== 'agentplay.real-workflow-acceptance') throw new Error('真实工作流验收回执协议无效')
  const workflows = Array.isArray(receipt.workflows) ? receipt.workflows : []
  if (workflows.length !== 3) throw new Error('必须同时验收合同、研究资料和视频内容包')
  const kinds = new Set(workflows.map((item) => item.kind))
  for (const kind of Object.keys(REQUIRED)) if (!kinds.has(kind)) throw new Error(`缺少${kind}真实工作流`)

  for (const workflow of workflows) {
    const rule = REQUIRED[workflow.kind]
    if (!rule) throw new Error('真实工作流类型无效')
    const sources = Array.isArray(workflow.sources) ? workflow.sources : []
    if (sources.length < rule.minSources) throw new Error(`${workflow.kind}来源数不足`)
    if (sources.reduce((sum, item) => sum + Math.max(0, Number(item.chars) || 0), 0) < rule.minChars) throw new Error(`${workflow.kind}来源正文不足，不算真实资料`)
    if (sources.reduce((sum, item) => sum + Math.max(0, Number(item.bytes) || 0), 0) < rule.minBytes) throw new Error(`${workflow.kind}来源文件过小，不算真实输入`)
    if (workflow.kind === 'contract' && !sources.some((item) => /\.(?:docx|pdf)$/i.test(String(item.path || '')))) throw new Error('合同工作流必须使用真实 DOCX 或 PDF')
    if (workflow.kind === 'video-content-package' && !(Number(workflow.durationSeconds) >= 5 && workflow.decoded === true && Number(workflow.frameEvidenceCount) > 0)) throw new Error('视频工作流缺少真实解码、时长或画面证据')
    for (const source of sources) {
      assertSha(source.beforeSha256, '来源原始回执')
      assertSha(source.afterSha256, '来源完成回执')
      if (source.beforeSha256 !== source.afterSha256 || source.preserved !== true) throw new Error(`${workflow.kind}改写了原始资料`)
    }
    const outputs = Array.isArray(workflow.outputs) ? workflow.outputs : []
    const formats = new Set(outputs.map((item) => String(item.format || '').toLowerCase()))
    if (!rule.formats.every((format) => formats.has(format))) throw new Error(`${workflow.kind}成果格式不完整`)
    for (const output of outputs) {
      assertSha(output.sha256, '成果回执')
      if (!exists(output.path) || digest(output.path) !== output.sha256 || output.reopened !== true || Number(output.bytes) <= 0) throw new Error(`${workflow.kind}成果未真实落盘或无法回开`)
    }
    if (workflow.quality?.passed !== true || Number(workflow.quality?.score) !== 100) throw new Error(`${workflow.kind}质量门未满分通过`)
    if (workflow.deliveryConsistency !== 'matched') throw new Error(`${workflow.kind}没有共用冻结事实底稿`)
    if (workflow.continueModification !== true || !workflow.projectId) throw new Error(`${workflow.kind}缺少继续修改入口或项目胶囊`)
    if (workflow.kind === 'video-content-package' && !(workflow.workflowReceiptComplete === true && workflow.modelCalls === 4)) throw new Error('视频内容包没有完成两步编排或调用次数不稳定')
    if (workflow.kind !== 'video-content-package' && workflow.modelCalls !== rule.formats.length) throw new Error(`${workflow.kind}模型调用数与成果格式不一致`)
  }
  if (receipt.cloudUploads !== 0 || receipt.controlledLocalModel !== true) throw new Error('真实合同和研究资料验收必须保持本机处理')
  return receipt
}

export { REQUIRED as REAL_WORKFLOW_REQUIREMENTS }
