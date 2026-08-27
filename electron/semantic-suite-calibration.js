const REQUIRED_CATEGORIES = Object.freeze(['interview', 'course', 'drama', 'product', 'vertical'])

function validateSemanticSuiteManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !manifest.baseManifestPath || !Array.isArray(manifest.categories)) throw new Error('A5整组标定清单无效')
  const byCategory = new Map(manifest.categories.map((item) => [String(item.category || ''), item]))
  const categories = REQUIRED_CATEGORIES.map((category) => {
    const item = byCategory.get(category)
    if (!item) throw new Error(`A5缺少${category}标定规则`)
    if (!item.quote?.query || !Number.isInteger(Number(item.quote.expectedCueIndex))) throw new Error(`${category}缺少原话定位人工真值`)
    if (!item.topic?.query || !Array.isArray(item.topic.expectedCueIndexes) || !item.topic.expectedCueIndexes.length) throw new Error(`${category}缺少主题字幕人工真值`)
    if (!Array.isArray(item.versions?.anchorCueIndexes) || !item.versions.anchorCueIndexes.length) throw new Error(`${category}缺少多版本高价值锚点`)
    return {
      category,
      quote: { query: String(item.quote.query), expectedCueIndex: Number(item.quote.expectedCueIndex) },
      topic: { query: String(item.topic.query), expectedCueIndexes: [...new Set(item.topic.expectedCueIndexes.map(Number))].sort((a, b) => a - b) },
      inspection: { expectDerivedDuplicate: item.inspection?.expectDerivedDuplicate !== false },
      versions: { anchorCueIndexes: [...new Set(item.versions.anchorCueIndexes.map(Number))].sort((a, b) => a - b), requiredExports: Math.max(2, Number(item.versions.requiredExports) || 2) }
    }
  })
  return { schemaVersion: 1, baseManifestPath: String(manifest.baseManifestPath), categories }
}

function overlapScore(expectedValues, actualValues) {
  const expected = new Set(expectedValues || []); const actual = new Set(actualValues || [])
  let truePositive = 0
  for (const value of actual) if (expected.has(value)) truePositive += 1
  const precision = actual.size ? truePositive / actual.size : 0
  const recall = expected.size ? truePositive / expected.size : 0
  return { truePositive, falsePositive: actual.size - truePositive, falseNegative: expected.size - truePositive, precision, recall }
}

function scoreSemanticSuiteCalibration(records) {
  const rows = Array.isArray(records) ? records : []
  const categories = new Set(rows.map((row) => row.category))
  let quotePassed = 0; let duplicatePassed = 0; let versionsPassed = 0; let unsafeVisualDeletion = 0; let processingFailure = 0
  let topicTruePositive = 0; let topicFalsePositive = 0; let topicFalseNegative = 0; let minimumExportQuality = 100
  for (const row of rows) {
    if (row.quotePassed) quotePassed += 1
    const topic = overlapScore(row.topicExpected, row.topicActual)
    topicTruePositive += topic.truePositive; topicFalsePositive += topic.falsePositive; topicFalseNegative += topic.falseNegative
    if (row.duplicatePassed) duplicatePassed += 1
    if (row.versionsPassed) versionsPassed += 1
    unsafeVisualDeletion += Number(row.unsafeVisualDeletion || 0)
    if (row.processingFailed) processingFailure += 1
    minimumExportQuality = Math.min(minimumExportQuality, Number(row.exportQuality) || 0)
  }
  const topicPrecision = topicTruePositive + topicFalsePositive ? topicTruePositive / (topicTruePositive + topicFalsePositive) : 0
  const topicRecall = topicTruePositive + topicFalseNegative ? topicTruePositive / (topicTruePositive + topicFalseNegative) : 0
  const passed = rows.length === 5 && REQUIRED_CATEGORIES.every((item) => categories.has(item)) && quotePassed === 5 && topicPrecision >= 0.75 && topicRecall >= 0.7 && duplicatePassed >= 4 && versionsPassed === 5 && unsafeVisualDeletion === 0 && processingFailure === 0 && minimumExportQuality >= 95
  return { passed, categoryCount: categories.size, caseCount: rows.length * 4, quotePassed, duplicatePassed, versionsPassed, topicTruePositive, topicFalsePositive, topicFalseNegative, topicPrecision: Number(topicPrecision.toFixed(4)), topicRecall: Number(topicRecall.toFixed(4)), unsafeVisualDeletion, processingFailure, minimumExportQuality }
}

module.exports = { REQUIRED_CATEGORIES, overlapScore, scoreSemanticSuiteCalibration, validateSemanticSuiteManifest }
