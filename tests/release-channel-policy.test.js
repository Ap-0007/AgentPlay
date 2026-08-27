const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const policyModule = import('../scripts/release-channel-policy.mjs')

const policy = JSON.parse(fs.readFileSync(path.join(root, 'release-public-policy.json'), 'utf8'))

function verification(status = 'NotSigned', signedDetails = false) {
  const evidence = signedDetails
    ? { status, subject: 'CN=AgentPlay', thumbprint: 'A'.repeat(40), timestamped: true }
    : { status, subject: '', thumbprint: '', timestamped: false }
  return {
    signing: {
      installer: { ...evidence },
      application: { ...evidence }
    }
  }
}

test('preview and beta may carry an explicitly acknowledged unsigned candidate', async () => {
  const { resolveReleaseChannel } = await policyModule
  for (const channel of ['preview', 'beta']) {
    const result = resolveReleaseChannel({
      channel,
      verification: verification(),
      policy,
      acknowledgeUnsigned: true
    })
    assert.equal(result.channel, channel)
    assert.equal(result.prerelease, true)
    assert.equal(result.signed, false)
    assert.match(result.notice, /未签名/)
  }
})

test('stable requires valid signatures on both installer and installed application', async () => {
  const { resolveReleaseChannel } = await policyModule
  assert.throws(() => resolveReleaseChannel({
    channel: 'stable',
    verification: verification(),
    policy
  }), /Authenticode.*Valid/)

  const result = resolveReleaseChannel({
    channel: 'stable',
    verification: verification('Valid', true),
    policy
  })
  assert.equal(result.prerelease, false)
  assert.equal(result.signed, true)
})

test('stable rejects a nominally valid signature without identity and timestamp evidence', async () => {
  const { resolveReleaseChannel } = await policyModule
  assert.throws(() => resolveReleaseChannel({
    channel: 'stable',
    verification: verification('Valid'),
    policy
  }), /证书身份与时间戳/)
})

test('terminal installer verifies official release metadata, checksums and signatures without bypassing SmartScreen', () => {
  const scriptPath = path.join(root, 'scripts', 'install-agentplay.ps1')
  const scriptBytes = fs.readFileSync(scriptPath)
  assert.deepEqual([...scriptBytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'Windows PowerShell 5.1 requires a UTF-8 BOM for Chinese text')
  const script = scriptBytes.toString('utf8')
  assert.match(script, /api\.github\.com\/repos\/\$repository\/releases/)
  assert.match(script, /Get-FileHash -Algorithm SHA256/)
  assert.match(script, /Get-AuthenticodeSignature/)
  assert.match(script, /-AllowUnsigned/)
  assert.match(script, /不会关闭或绕过 Windows SmartScreen/)
  assert.doesNotMatch(script, /ExecutionPolicy\W+Bypass|Set-MpPreference|SmartScreenEnabled/)
  assert.match(script, /目标目录已存在，不会覆盖/)
})

test('portable packaging is rooted in win-unpacked and verifies the executable, app archive, runtime and legal files', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'prepare-portable-archive.mjs'), 'utf8')
  for (const required of ['AgentPlay.exe', 'resources/app.asar', 'resources/bin/win/mpv.com', 'resources/legal/LICENSE']) {
    assert.match(script, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(script, /7za\.exe/)
  assert.match(script, /标准便携包误带本地 AI 资源/)
})
