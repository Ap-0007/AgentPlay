const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')

test('electron-builder child-process timeout patch is pinned and active', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const patchPath = packageJson.pnpm?.patchedDependencies?.['builder-util@26.15.3']

  assert.equal(patchPath, 'patches/builder-util@26.15.3.patch')

  const patch = fs.readFileSync(path.join(root, patchPath), 'utf8')
  assert.match(patch, /15 \* 60 \* 1000/)
  assert.match(patch, /timed out after 15 minutes/)
  assert.doesNotMatch(patch, /^\+.*timed out after 4 minutes/m)

  const electronBuilderEntry = require.resolve('electron-builder')
  const installedUtilPath = require.resolve('builder-util', {
    paths: [path.dirname(electronBuilderEntry)],
  })
  const installedUtil = fs.readFileSync(installedUtilPath, 'utf8')
  assert.match(installedUtil, /15 \* 60 \* 1000/)
  assert.match(installedUtil, /timed out after 15 minutes/)
})
