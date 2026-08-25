import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveReleaseChannel } from './release-channel-policy.mjs'

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex').toUpperCase()
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`缺少${label}：${filePath}`)
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${filePath}（${error.message}）`)
  }
}

function assertRelativePublicPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}缺少路径`)
  if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    throw new Error(`${label}包含绝对路径：${value}`)
  }
}

function ensureEmptyOutputDirectory(outputDir) {
  if (fs.existsSync(outputDir)) {
    const existing = fs.readdirSync(outputDir)
    if (existing.length) throw new Error(`发布资产目录非空，请使用新的目录：${outputDir}`)
  } else {
    fs.mkdirSync(outputDir, { recursive: true })
  }
}

function normalizeSbom(rawSbom) {
  const document = rawSbom?.sbom ?? rawSbom
  if (!document || typeof document !== 'object') throw new Error('SBOM 缺少 SPDX 文档')
  if (typeof document.spdxVersion !== 'string' || !document.spdxVersion.startsWith('SPDX-')) {
    throw new Error('SBOM 不是有效的 SPDX JSON')
  }
  if (!Array.isArray(document.packages)) throw new Error('SBOM 缺少 packages 数组')
  return document
}

export function prepareReleaseAssets({
  rootDir = moduleRoot,
  version,
  installerPath,
  portablePath,
  verificationPath,
  securityScanPath,
  sbomPath,
  outputDir,
  channel = 'preview',
  acknowledgeUnsigned = false,
}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error(`版本号无效：${version ?? ''}`)
  const packageJson = readJson(path.join(rootDir, 'package.json'), 'package.json')
  if (packageJson.version !== version) {
    throw new Error(`package.json 版本 ${packageJson.version} 与发布版本 ${version} 不一致`)
  }

  const verification = readJson(verificationPath, '发布校验报告')
  if (verification.version !== version) throw new Error('发布校验报告版本不一致')
  assertRelativePublicPath(verification.standard?.path, '发布校验报告')
  if (!Number.isSafeInteger(verification.standard?.bytes) || verification.standard.bytes <= 0) {
    throw new Error('发布校验报告缺少有效字节数')
  }
  if (!/^[A-Fa-f0-9]{64}$/.test(verification.standard?.sha256 ?? '')) {
    throw new Error('发布校验报告缺少有效 SHA-256')
  }
  if (!fs.existsSync(installerPath)) throw new Error(`缺少安装包：${installerPath}`)
  if (!fs.existsSync(portablePath)) throw new Error(`缺少便携包：${portablePath}`)

  const installerBytes = fs.statSync(installerPath).size
  const installerHash = sha256(installerPath)
  if (installerBytes !== verification.standard.bytes) throw new Error('安装包字节数与发布校验报告不一致')
  if (installerHash !== verification.standard.sha256.toUpperCase()) throw new Error('安装包 SHA-256 与发布校验报告不一致')

  assertRelativePublicPath(verification.portable?.path, '发布校验报告便携包')
  if (!Number.isSafeInteger(verification.portable?.bytes) || verification.portable.bytes <= 0) {
    throw new Error('发布校验报告缺少便携包有效字节数')
  }
  if (!/^[A-Fa-f0-9]{64}$/.test(verification.portable?.sha256 ?? '')) {
    throw new Error('发布校验报告缺少便携包有效 SHA-256')
  }
  const portableBytes = fs.statSync(portablePath).size
  const portableHash = sha256(portablePath)
  if (portableBytes !== verification.portable.bytes) throw new Error('便携包字节数与发布校验报告不一致')
  if (portableHash !== verification.portable.sha256.toUpperCase()) throw new Error('便携包 SHA-256 与发布校验报告不一致')

  const policy = readJson(path.join(rootDir, 'release-public-policy.json'), '公开发布策略')
  const releaseChannel = resolveReleaseChannel({
    channel,
    verification,
    policy,
    acknowledgeUnsigned,
  })

  const securityScan = readJson(securityScanPath, '安全扫描报告')
  if (securityScan.scope?.packaged !== true) throw new Error('安全扫描报告未覆盖打包产物')
  if (!Array.isArray(securityScan.findings) || securityScan.findings.length !== 0) {
    throw new Error('安全扫描报告仍有发现项')
  }

  const sbom = normalizeSbom(readJson(sbomPath, 'SPDX SBOM'))
  ensureEmptyOutputDirectory(outputDir)

  const names = {
    installer: `AgentPlay-${version}-Windows-x64-Standard.exe`,
    portable: `AgentPlay-${version}-Windows-x64-Portable.zip`,
    verification: `AgentPlay-${version}-release-verification.json`,
    security: `AgentPlay-${version}-security-release-scan.json`,
    sbom: `AgentPlay-${version}.spdx.json`,
    manifest: `AgentPlay-${version}-release-manifest.json`,
    installerScript: 'Install-AgentPlay.ps1',
    checksums: `AgentPlay-${version}-SHA256SUMS.txt`
  }

  const installerOutput = path.join(outputDir, names.installer)
  fs.copyFileSync(installerPath, installerOutput)
  fs.copyFileSync(portablePath, path.join(outputDir, names.portable))
  const installerScriptPath = path.join(rootDir, 'scripts', 'install-agentplay.ps1')
  if (!fs.existsSync(installerScriptPath)) throw new Error(`缺少命令行安装脚本：${installerScriptPath}`)
  fs.copyFileSync(installerScriptPath, path.join(outputDir, names.installerScript))

  const publicVerification = {
    ...verification,
    standard: {
      ...verification.standard,
      path: names.installer,
      bytes: installerBytes,
      sha256: installerHash
    },
    portable: {
      ...verification.portable,
      path: names.portable,
      bytes: portableBytes,
      sha256: portableHash
    },
    releaseChannel,
  }
  fs.writeFileSync(path.join(outputDir, names.verification), `${JSON.stringify(publicVerification, null, 2)}\n`)
  fs.writeFileSync(path.join(outputDir, names.security), `${JSON.stringify(securityScan, null, 2)}\n`)
  fs.writeFileSync(path.join(outputDir, names.sbom), `${JSON.stringify(sbom, null, 2)}\n`)

  const manifest = {
    schemaVersion: 1,
    product: 'AgentPlay',
    version,
    channel: releaseChannel.channel,
    prerelease: releaseChannel.prerelease,
    signed: releaseChannel.signed,
    signing: releaseChannel.signing,
    notice: releaseChannel.notice,
    packages: {
      installer: { name: names.installer, bytes: installerBytes, sha256: installerHash },
      portable: { name: names.portable, bytes: portableBytes, sha256: portableHash },
    },
    sbom: names.sbom,
    checksums: names.checksums,
    terminalInstaller: names.installerScript,
  }
  fs.writeFileSync(path.join(outputDir, names.manifest), `${JSON.stringify(manifest, null, 2)}\n`)

  const hashedNames = [
    names.installer,
    names.portable,
    names.verification,
    names.security,
    names.sbom,
    names.manifest,
    names.installerScript,
  ]
  const checksumLines = hashedNames.map((name) => `${sha256(path.join(outputDir, name))}  ${name}`)
  fs.writeFileSync(path.join(outputDir, names.checksums), `${checksumLines.join('\n')}\n`)

  return {
    version,
    outputDir,
    assets: [...hashedNames, names.checksums],
    channel: releaseChannel,
    installer: { bytes: installerBytes, sha256: installerHash },
    portable: { bytes: portableBytes, sha256: portableHash }
  }
}

function cliValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageJson = readJson(path.join(moduleRoot, 'package.json'), 'package.json')
  const version = cliValue('--version') ?? packageJson.version
  const result = prepareReleaseAssets({
    rootDir: moduleRoot,
    version,
    installerPath: cliValue('--installer') ?? path.join(moduleRoot, 'release', `AgentPlay-标准版安装包-${version}.exe`),
    portablePath: cliValue('--portable') ?? path.join(moduleRoot, 'release', `AgentPlay-${version}-Windows-x64-Portable.zip`),
    verificationPath: cliValue('--verification') ?? path.join(moduleRoot, 'release', `release-verification-${version}.json`),
    securityScanPath: cliValue('--security') ?? path.join(moduleRoot, 'release', 'security-release-scan.json'),
    sbomPath: cliValue('--sbom') ?? path.join(moduleRoot, 'release', `AgentPlay-${version}.spdx.json`),
    outputDir: cliValue('--output') ?? path.join(moduleRoot, 'release', `publish-v${version}-${cliValue('--channel') ?? 'preview'}`),
    channel: cliValue('--channel') ?? 'preview',
    acknowledgeUnsigned: process.argv.includes('--ack-unsigned'),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
