import { spawn } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..')

export async function discoverTestFiles(testsDirectory = path.join(projectRoot, 'tests')) {
  const entries = await readdir(testsDirectory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && /\.test\.(?:js|mjs)$/.test(entry.name))
    .map((entry) => path.join(testsDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right, 'en'))
}

export async function main() {
  const testFiles = await discoverTestFiles()
  if (testFiles.length === 0) throw new Error('No test files found in tests/')

  const child = spawn(process.execPath, ['--test', ...testFiles], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true
  })

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Node test runner terminated by ${signal}`))
      else resolve(code ?? 1)
    })
  })
  process.exitCode = exitCode
}

export async function isInvokedAsMain(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  if (!argvPath) return false
  const [invokedPath, modulePath] = await Promise.all([
    realpath(path.resolve(argvPath)),
    realpath(fileURLToPath(moduleUrl))
  ])
  return process.platform === 'win32'
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath
}

if (await isInvokedAsMain()) await main()
