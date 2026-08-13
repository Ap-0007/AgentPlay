import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function packageId(name, version) {
  const safeName = String(name || 'package').replace(/[^A-Za-z0-9.-]+/g, '-')
  const digest = crypto.createHash('sha256').update(`${name}@${version}`).digest('hex').slice(0, 12)
  return `SPDXRef-Package-${safeName}-${digest}`
}

function licenseFor(node) {
  if (String(node?.license || '').trim()) return String(node.license).trim()
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(node.path, 'package.json'), 'utf8'))
    const value = manifest.license
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value && typeof value.type === 'string' && value.type.trim()) return value.type.trim()
  } catch {}
  return 'NOASSERTION'
}

function purl(name, version) {
  const encodedName = String(name).split('/').map(encodeURIComponent).join('/')
  return `pkg:npm/${encodedName}@${encodeURIComponent(String(version))}`
}

export function generateSpdxDocument({ root, dependencies = {}, createdAt = new Date().toISOString() }) {
  const packagesByKey = new Map()
  const relationshipsByKey = new Map()
  const rootNode = { ...root, name: String(root.name || 'AgentPlay'), version: String(root.version || '0.0.0') }

  const addPackage = (node) => {
    const name = String(node?.name || '')
    const version = String(node?.version || '')
    if (!name || !version) return null
    const key = `${name}@${version}`
    if (!packagesByKey.has(key)) {
      const SPDXID = packageId(name, version)
      packagesByKey.set(key, {
        SPDXID,
        name,
        versionInfo: version,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: licenseFor(node),
        copyrightText: 'NOASSERTION',
        externalRefs: [{
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: purl(name, version)
        }]
      })
    }
    return packagesByKey.get(key)
  }

  const addRelationship = (from, type, to) => {
    const key = `${from}|${type}|${to}`
    relationshipsByKey.set(key, { spdxElementId: from, relationshipType: type, relatedSpdxElement: to })
  }

  const rootPackage = addPackage(rootNode)
  addRelationship('SPDXRef-DOCUMENT', 'DESCRIBES', rootPackage.SPDXID)
  const visit = (items, parentPackage) => {
    for (const [dependencyName, rawNode] of Object.entries(items || {})) {
      const node = { ...rawNode, name: rawNode?.name || dependencyName }
      const dependencyPackage = addPackage(node)
      if (!dependencyPackage) continue
      addRelationship(parentPackage.SPDXID, 'DEPENDS_ON', dependencyPackage.SPDXID)
      visit(node.dependencies, dependencyPackage)
    }
  }
  visit(dependencies, rootPackage)

  const graphFingerprint = [...packagesByKey.keys()].sort().join('\n')
  const namespaceDigest = crypto.createHash('sha256').update(`${rootNode.name}@${rootNode.version}\n${graphFingerprint}`).digest('hex')
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${rootNode.name}-${rootNode.version}`,
    documentNamespace: `https://github.com/wg5759/AgentPlay/sbom/${encodeURIComponent(rootNode.version)}/${namespaceDigest}`,
    creationInfo: {
      created: createdAt,
      creators: ['Tool: AgentPlay-pnpm-spdx-generator-1.0']
    },
    packages: [...packagesByKey.values()].sort((left, right) => left.SPDXID.localeCompare(right.SPDXID)),
    relationships: [...relationshipsByKey.values()].sort((left, right) => (
      `${left.spdxElementId}|${left.relationshipType}|${left.relatedSpdxElement}`
        .localeCompare(`${right.spdxElementId}|${right.relationshipType}|${right.relatedSpdxElement}`)
    ))
  }
}

function productionGraph(rootDir) {
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : 'pnpm'
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'pnpm.cmd list --prod --json --depth Infinity']
    : ['list', '--prod', '--json', '--depth', 'Infinity']
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.status !== 0) throw new Error(`pnpm 生产依赖图读取失败：${result.error?.message || result.stderr || result.stdout || `退出码 ${result.status}`}`)
  const graph = JSON.parse(result.stdout)?.[0]
  if (!graph?.name || !graph?.version) throw new Error('pnpm 生产依赖图缺少根包信息')
  return graph
}

function cliValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const graph = productionGraph(moduleRoot)
  const outputPath = path.resolve(cliValue('--output') || path.join(moduleRoot, 'release', `AgentPlay-${graph.version}.spdx.json`))
  const document = generateSpdxDocument({
    root: { ...graph, license: 'Apache-2.0' },
    dependencies: graph.dependencies
  })
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ outputPath, packages: document.packages.length, relationships: document.relationships.length })}\n`)
}
