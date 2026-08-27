import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateManualReview } from './lib/professional-corpus-e5.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'professional-corpus-e5-packaged')
const technicalPath = path.join(evidenceDir, 'technical-receipt.json')
const reviewPath = path.join(evidenceDir, 'manual-review.json')
const technical = JSON.parse(fs.readFileSync(technicalPath, 'utf8'))
const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'))
const completed = validateManualReview(review, technical)
completed.passed = true
completed.completedAt = new Date().toISOString()
const finalPath = path.join(evidenceDir, 'receipt.json')
fs.writeFileSync(finalPath, `${JSON.stringify(completed, null, 2)}\n`, 'utf8')
const rows = completed.samples.map((item) => `| ${item.id} | ${item.group} | ${item.operation} | ${item.qualityScore} | ${item.elapsedMs} | 通过 |`).join('\n')
const report = `# AgentPlay 0.9.1 E5 专业样本验收\n\n- 样本：${completed.samples.length} 个自有生成授权样本\n- 人工复核：${completed.manualReview.passed}/${completed.manualReview.sampleCount} 通过\n- 安装态：${completed.installedAcceptance ? '通过' : '未通过'}\n- 总耗时：${completed.performance.totalElapsedMs} ms\n- P50/P95：${completed.performance.p50ElapsedMs}/${completed.performance.p95ElapsedMs} ms/样本\n- 云端调用：${completed.cost.cloudCalls}\n- 估算模型费用：$${completed.cost.estimatedUsd.toFixed(6)}\n- 成本边界：本轮只验收本机确定性执行；未测电费，不把订阅套餐冒充零成本。\n\n| 样本 | 组别 | 操作 | 质量 | 毫秒 | 人工复核 |\n|---|---|---|---:|---:|---|\n${rows}\n`
fs.writeFileSync(path.join(evidenceDir, 'performance-cost-report.md'), report, 'utf8')
process.stdout.write(`${JSON.stringify({ passed: true, finalPath, reportPath: path.join(evidenceDir, 'performance-cost-report.md'), samples: completed.samples.length, p50ElapsedMs: completed.performance.p50ElapsedMs, p95ElapsedMs: completed.performance.p95ElapsedMs }, null, 2)}\n`)
