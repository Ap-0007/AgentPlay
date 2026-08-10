import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { discoverTestFiles } from '../scripts/run-tests.mjs'

test('test runner discovers JavaScript tests cross-platform without shell globs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentplay-test-runner-'))
  try {
    await Promise.all([
      writeFile(path.join(directory, 'z.test.mjs'), ''),
      writeFile(path.join(directory, 'a.test.js'), ''),
      writeFile(path.join(directory, 'ignored.js'), ''),
      writeFile(path.join(directory, 'also-ignored.test.ts'), '')
    ])

    const discovered = await discoverTestFiles(directory)
    assert.deepEqual(discovered.map((file) => path.basename(file)), ['a.test.js', 'z.test.mjs'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
