import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [outputDir, opencodeExe, sessionId] = process.argv.slice(2)
if (!outputDir || !opencodeExe || !sessionId) {
  throw new Error('usage: node export-model-audit.mjs <output-dir> <opencode-exe> <session-id>')
}

mkdirSync(outputDir, { recursive: true })
const result = spawnSync(opencodeExe, ['export', sessionId], {
  encoding: null,
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024
})
writeFileSync(path.join(outputDir, 'glm-5.2-session.raw.json'), result.stdout)
writeFileSync(path.join(outputDir, 'glm-5.2-export.stderr.txt'), result.stderr)
if (result.status !== 0) process.exit(result.status ?? 1)
