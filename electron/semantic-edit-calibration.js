const REQUIRED_CATEGORIES = Object.freeze(['interview', 'course', 'drama', 'product', 'vertical'])

function candidateKey(candidate = {}) {
  return `${candidate.type || ''}:${(candidate.removeCueIndexes || []).map(Number).sort((a, b) => a - b).join(',')}:${candidate.visualVerdict || 'safe'}`
}

function validateCalibrationManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.categories)) throw new Error('语义剪辑标定清单无效')
  const categories = new Map(manifest.categories.map((item) => [String(item.category || ''), item]))
  for (const category of REQUIRED_CATEGORIES) {
    const item = categories.get(category)
    if (!item) throw new Error(`缺少${category}真实素材标定`)
    if (!item.source?.videoPath || !item.source?.subtitlePath || !item.source?.videoSha256 || !item.source?.subtitleSha256) throw new Error(`${category}缺少源文件或哈希证据`)
    if (!Array.isArray(item.negativeCase?.expectedRemovalCueIndexes) || item.negativeCase.expectedRemovalCueIndexes.length) throw new Error(`${category}原片负样本必须明确标为不删除`)
    if (!item.positiveCase?.videoPath || !item.positiveCase?.subtitlePath || !item.positiveCase?.videoSha256 || !item.positiveCase?.subtitleSha256) throw new Error(`${category}缺少正样本或哈希证据`)
    if (!Array.isArray(item.positiveCase?.expected) || !item.positiveCase.expected.length) throw new Error(`${category}正样本缺少人工真值`)
  }
  return { schemaVersion: 1, categories: REQUIRED_CATEGORIES.map((category) => categories.get(category)), caseCount: REQUIRED_CATEGORIES.length * 2 }
}

function scoreSemanticCalibration(records) {
  const rows = Array.isArray(records) ? records : []
  const categories = new Set(rows.map((row) => row.category))
  let truePositive = 0; let falsePositive = 0; let falseNegative = 0; let unsafeDeletion = 0; let processingFailure = 0
  for (const row of rows) {
    const expected = new Set((row.expected || []).map(candidateKey))
    const actual = new Set((row.actual || []).map(candidateKey))
    for (const key of actual) expected.has(key) ? truePositive += 1 : falsePositive += 1
    for (const key of expected) if (!actual.has(key)) falseNegative += 1
    if ((row.actual || []).some((candidate) => candidate.visualVerdict !== 'safe' || candidate.humanApproved !== true)) unsafeDeletion += 1
    if (row.processingFailed === true) processingFailure += 1
  }
  const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 1
  const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 1
  const passed = REQUIRED_CATEGORIES.every((category) => categories.has(category)) && rows.length >= 10 && precision >= 0.9 && recall >= 0.8 && unsafeDeletion === 0 && processingFailure === 0
  return { passed, caseCount: rows.length, categoryCount: categories.size, truePositive, falsePositive, falseNegative, unsafeDeletion, processingFailure, precision: Number(precision.toFixed(4)), recall: Number(recall.toFixed(4)) }
}

module.exports = { REQUIRED_CATEGORIES, candidateKey, scoreSemanticCalibration, validateCalibrationManifest }
