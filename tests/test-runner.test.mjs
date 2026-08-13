import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { discoverTestFiles, isInvokedAsMain } from '../scripts/run-tests.mjs'

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

test('test runner starts when the script is invoked through a directory junction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentplay-test-runner-link-'))
  try {
    const realDirectory = path.join(root, 'real')
    const linkedDirectory = path.join(root, 'linked')
    await mkdir(realDirectory)
    const script = path.join(realDirectory, 'run.mjs')
    await writeFile(script, '')
    await symlink(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(await isInvokedAsMain(path.join(linkedDirectory, 'run.mjs'), pathToFileURL(script).href), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
