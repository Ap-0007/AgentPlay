const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const handle = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(handle)
  }
  return hash.digest('hex')
}

function sourceSnapshot(filePath) {
  const resolved = fs.realpathSync(path.resolve(String(filePath || '')))
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error(`文档源不是文件：${path.basename(resolved)}`)
  return { path: resolved, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), sha256: sha256File(resolved) }
}

function snapshotDocumentSources(filePaths) {
  const paths = Array.isArray(filePaths) ? filePaths.slice(0, 20) : []
  return paths.map(sourceSnapshot)
}

function validateDocumentSources(sources) {
  return (Array.isArray(sources) ? sources : []).map((expected) => {
    let actual
    try { actual = sourceSnapshot(expected.path) } catch { throw new Error(`文档源文件已不存在：${path.basename(String(expected.path || ''))}`) }
    if (actual.size !== Number(expected.size) || actual.sha256 !== expected.sha256) {
      throw new Error(`文档源文件已发生变化，请重新选择：${path.basename(actual.path)}`)
    }
    return actual.path
  })
}

function outputsStillExist(result) {
  const outputs = Array.isArray(result?.outputs) ? result.outputs : []
  if (!outputs.length) return Boolean(result?.chatOnly)
  return outputs.every((outputPath) => {
    try {
      const stat = fs.statSync(path.resolve(String(outputPath || '')))
      return stat.isDirectory() || (stat.isFile() && stat.size > 0)
    } catch { return false }
  })
}

module.exports = { sha256File, snapshotDocumentSources, validateDocumentSources, outputsStillExist }
