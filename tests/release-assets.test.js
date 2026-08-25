const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..')
const releaseAssetsModule = import('../scripts/prepare-release-assets.mjs')

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase()
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function createFixture({ absoluteVerificationPath = false } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-release-assets-'))
  const version = '9.8.7'
  const installerPath = path.join(rootDir, 'candidate.exe')
  const portablePath = path.join(rootDir, 'portable.zip')
  const verificationPath = path.join(rootDir, 'verification.json')
  const securityScanPath = path.join(rootDir, 'security.json')
  const sbomPath = path.join(rootDir, 'sbom.json')
  const outputDir = path.join(rootDir, 'publish')

  writeJson(path.join(rootDir, 'package.json'), { name: 'fixture', version })
  fs.writeFileSync(installerPath, Buffer.from('agentplay-release-fixture'))
  fs.writeFileSync(portablePath, Buffer.from('agentplay-portable-fixture'))
  writeJson(path.join(rootDir, 'release-public-policy.json'), {
    schemaVersion: 2,
    channels: {
      preview: { allowed: true, prerelease: true, allowUnsigned: true, unsignedNotice: 'unsigned preview' },
      beta: { allowed: true, prerelease: true, allowUnsigned: true, unsignedNotice: 'unsigned beta' },
      stable: { allowed: true, prerelease: false, allowUnsigned: false, signedNotice: 'signed stable' }
    }
  })
  fs.mkdirSync(path.join(rootDir, 'scripts'))
  fs.writeFileSync(path.join(rootDir, 'scripts', 'install-agentplay.ps1'), 'Write-Output AgentPlay\n')
  writeJson(verificationPath, {
    version,
    standard: {
      path: absoluteVerificationPath ? 'C:\\Users\\Maintainer\\candidate.exe' : 'release/candidate.exe',
      bytes: fs.statSync(installerPath).size,
      sha256: hash(installerPath)
    },
    portable: {
      path: 'release/portable.zip',
      bytes: fs.statSync(portablePath).size,
      sha256: hash(portablePath)
    },
    signing: {
      installer: { status: 'NotSigned' },
      application: { status: 'NotSigned' }
    },
    closure: { legalDocsIncluded: true }
  })
  writeJson(securityScanPath, {
    schemaVersion: 1,
    scope: { current: true, history: true, packaged: true },
    scanned: { currentFiles: 1, historyBlobs: 1, packagedFiles: 1 },
    findings: [],
    endpoints: []
  })
  writeJson(sbomPath, {
    sbom: {
      spdxVersion: 'SPDX-2.3',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: 'AgentPlay fixture',
      packages: []
    }
  })

  return {
    rootDir,
    version,
    installerPath,
    portablePath,
    verificationPath,
    securityScanPath,
    sbomPath,
    outputDir,
    channel: 'preview',
    acknowledgeUnsigned: true
  }
}

test('prepareReleaseAssets emits public-safe assets and matching checksums', async () => {
  const { prepareReleaseAssets } = await releaseAssetsModule
  const fixture = createFixture()
  try {
    const result = prepareReleaseAssets(fixture)
    assert.deepEqual(result.assets, [
      'AgentPlay-9.8.7-Windows-x64-Standard.exe',
      'AgentPlay-9.8.7-Windows-x64-Portable.zip',
      'AgentPlay-9.8.7-release-verification.json',
      'AgentPlay-9.8.7-security-release-scan.json',
      'AgentPlay-9.8.7.spdx.json',
      'AgentPlay-9.8.7-release-manifest.json',
      'Install-AgentPlay.ps1',
      'AgentPlay-9.8.7-SHA256SUMS.txt'
    ])

    const publicVerification = JSON.parse(
      fs.readFileSync(path.join(fixture.outputDir, 'AgentPlay-9.8.7-release-verification.json'), 'utf8')
    )
    assert.equal(publicVerification.standard.path, 'AgentPlay-9.8.7-Windows-x64-Standard.exe')
    assert.equal(publicVerification.portable.path, 'AgentPlay-9.8.7-Windows-x64-Portable.zip')
    assert.equal(publicVerification.releaseChannel.channel, 'preview')
    assert.equal(publicVerification.releaseChannel.signed, false)
    assert.equal(path.win32.isAbsolute(publicVerification.standard.path), false)

    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixture.outputDir, 'AgentPlay-9.8.7-release-manifest.json'), 'utf8')
    )
    assert.equal(manifest.channel, 'preview')
    assert.equal(manifest.prerelease, true)
    assert.equal(manifest.signed, false)
    assert.equal(manifest.terminalInstaller, 'Install-AgentPlay.ps1')

    const checksumLines = fs
      .readFileSync(path.join(fixture.outputDir, 'AgentPlay-9.8.7-SHA256SUMS.txt'), 'utf8')
      .trim()
      .split(/\r?\n/)
    assert.equal(checksumLines.length, 7)
    for (const line of checksumLines) {
      const match = /^([A-F0-9]{64})  (.+)$/.exec(line)
      assert.ok(match)
      assert.equal(match[1], hash(path.join(fixture.outputDir, match[2])))
    }
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true })
  }
})

test('prepareReleaseAssets rejects absolute maintainer paths', async () => {
  const { prepareReleaseAssets } = await releaseAssetsModule
  const fixture = createFixture({ absoluteVerificationPath: true })
  try {
    assert.throws(() => prepareReleaseAssets(fixture), /绝对路径/)
    assert.equal(fs.existsSync(fixture.outputDir), false)
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true })
  }
})

test('stable assets fail closed until installer and application signatures are both valid', async () => {
  const { prepareReleaseAssets } = await releaseAssetsModule
  const fixture = createFixture()
  try {
    assert.throws(
      () => prepareReleaseAssets({ ...fixture, channel: 'stable', acknowledgeUnsigned: false }),
      /Authenticode.*Valid/
    )

    const verification = JSON.parse(fs.readFileSync(fixture.verificationPath, 'utf8'))
    for (const key of ['installer', 'application']) {
      verification.signing[key] = {
        status: 'Valid',
        subject: 'CN=AgentPlay',
        thumbprint: 'A'.repeat(40),
        timestamped: true
      }
    }
    writeJson(fixture.verificationPath, verification)
    const result = prepareReleaseAssets({ ...fixture, channel: 'stable', acknowledgeUnsigned: false })
    assert.equal(result.channel.channel, 'stable')
    assert.equal(result.channel.prerelease, false)
    assert.equal(result.channel.signed, true)
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true })
  }
})

test('unsigned preview assets require an explicit acknowledgement', async () => {
  const { prepareReleaseAssets } = await releaseAssetsModule
  const fixture = createFixture()
  try {
    assert.throws(
      () => prepareReleaseAssets({ ...fixture, acknowledgeUnsigned: false }),
      /--ack-unsigned/
    )
    assert.equal(fs.existsSync(fixture.outputDir), false)
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true })
  }
})

test('verify-release writes a repository-relative installer path', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-release.mjs'), 'utf8')
  assert.match(source, /path\.relative\(root, standard\)/)
  assert.doesNotMatch(source, /standard:\s*\{\s*path:\s*standard/)
})

test('prepareReleaseAssets fails closed on inconsistent release evidence', async (t) => {
  const { prepareReleaseAssets } = await releaseAssetsModule
  const cases = [
    {
      name: 'installer hash mismatch',
      mutate(fixture) {
        const verification = JSON.parse(fs.readFileSync(fixture.verificationPath, 'utf8'))
        verification.standard.sha256 = '0'.repeat(64)
        writeJson(fixture.verificationPath, verification)
      },
      pattern: /SHA-256/
    },
    {
      name: 'portable hash mismatch',
      mutate(fixture) {
        const verification = JSON.parse(fs.readFileSync(fixture.verificationPath, 'utf8'))
        verification.portable.sha256 = '0'.repeat(64)
        writeJson(fixture.verificationPath, verification)
      },
      pattern: /便携包 SHA-256/
    },
    {
      name: 'packaged scan missing',
      mutate(fixture) {
        const scan = JSON.parse(fs.readFileSync(fixture.securityScanPath, 'utf8'))
        scan.scope.packaged = false
        writeJson(fixture.securityScanPath, scan)
      },
      pattern: /未覆盖打包产物/
    },
    {
      name: 'security finding remains',
      mutate(fixture) {
        const scan = JSON.parse(fs.readFileSync(fixture.securityScanPath, 'utf8'))
        scan.findings.push({ rule: 'fixture' })
        writeJson(fixture.securityScanPath, scan)
      },
      pattern: /仍有发现项/
    },
    {
      name: 'invalid SPDX document',
      mutate(fixture) {
        writeJson(fixture.sbomPath, { sbom: { packages: [] } })
      },
      pattern: /SPDX/
    },
    {
      name: 'non-empty output directory',
      mutate(fixture) {
        fs.mkdirSync(fixture.outputDir, { recursive: true })
        fs.writeFileSync(path.join(fixture.outputDir, 'stale.txt'), 'stale')
      },
      pattern: /目录非空/
    }
  ]

  for (const item of cases) {
    await t.test(item.name, () => {
      const fixture = createFixture()
      try {
        item.mutate(fixture)
        assert.throws(() => prepareReleaseAssets(fixture), item.pattern)
      } finally {
        fs.rmSync(fixture.rootDir, { recursive: true, force: true })
      }
    })
  }
})
