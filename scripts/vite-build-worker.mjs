import { parentPort } from 'node:worker_threads'
import { build } from 'vite'

try {
  await build()
  parentPort?.postMessage({ success: true })
} catch (error) {
  parentPort?.postMessage({ success: false, error: error instanceof Error ? error.stack || error.message : String(error) })
}
