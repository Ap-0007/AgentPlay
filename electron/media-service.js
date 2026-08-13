const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { getType } = require('./file-service')

function extractTags(name, type) {
  const base = name.replace(/\.[^.]+$/, '')
  const tags = [type]
  const keywords = base.split(/[\s\-_.\[\]()【】（）]+/).filter((k) => k.length > 1)
  tags.push(...keywords.slice(0, 3))
  const dateMatch = base.match(/(20\d{2})/)
  if (dateMatch) tags.push(dateMatch[1])
  return [...new Set(tags)]
}

function analyzeDir(dir, depth = 0) {
  if (depth > 20) return []
  const results = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      results.push(...analyzeDir(full, depth + 1))
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase()
      const type = getType(ext)
      if (type === 'other') continue
      const tags = extractTags(e.name, type)
      let size = 0
      try { size = fs.statSync(full).size } catch {}
      results.push({
        name: e.name,
        path: full,
        ext,
        type,
        size,
        tags,
        group: tags[0] || type
      })
    }
  }
  return results
}

function abortError() {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

// 去重专用异步枚举：同步递归会在超大媒体库里冻结主进程，也无法响应取消。
async function analyzeDirAsync(dir, { signal, onProgress, maxDepth = 20 } = {}) {
  const results = []
  const pending = [{ dir, depth: 0 }]
  let directoriesScanned = 0
  while (pending.length > 0) {
    throwIfAborted(signal)
    const current = pending.pop()
    if (!current || current.depth > maxDepth) continue
    let entries
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true })
    } catch (error) {
      if (signal?.aborted) throw abortError()
      continue
    }
    directoriesScanned += 1
    for (const entry of entries) {
      throwIfAborted(signal)
      const full = path.join(current.dir, entry.name)
      if (entry.isDirectory()) {
        pending.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      const type = getType(ext)
      if (type === 'other') continue
      let stat
      try { stat = await fs.promises.stat(full) } catch { continue }
      const size = stat.size
      const tags = extractTags(entry.name, type)
      results.push({
        name: entry.name,
        path: full,
        ext,
        type,
        size,
        mtimeMs: stat.mtimeMs,
        tags,
        group: tags[0] || type
      })
      onProgress?.({ phase: 'scanning', filesScanned: results.length, directoriesScanned, currentFile: entry.name })
    }
  }
  throwIfAborted(signal)
  return results
}

function clusterByTag(files) {
  const groups = {}
  for (const f of files) {
    const key = f.group || 'other'
    if (!groups[key]) groups[key] = []
    groups[key].push(f)
  }
  return groups
}

// 异步流式哈希：abort 会 destroy 当前流，停止继续读盘，而不只是丢弃最终结果。
function hashFile(filePath, { signal, onProgress, createReadStream = fs.createReadStream } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const hash = crypto.createHash('sha256')
    let bytesRead = 0
    let settled = false
    let stream
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      const error = abortError()
      if (stream && !stream.destroyed) stream.destroy(error)
      else finish(reject, error)
    }
    try {
      stream = createReadStream(filePath)
    } catch (error) {
      finish(reject, error)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.once('error', (error) => finish(reject, signal?.aborted ? abortError() : error))
    stream.on('data', (chunk) => {
      if (signal?.aborted) return onAbort()
      hash.update(chunk)
      bytesRead += chunk.length
      onProgress?.({ bytesRead })
    })
    stream.once('end', () => finish(resolve, hash.digest('hex')))
  })
}

async function findDuplicates(files, { signal, onProgress, hashFileImpl = hashFile, hashCache = {}, onFileHashed } = {}) {
  const bySize = new Map()
  const dupes = []
  for (const file of files) {
    if (!file.size) continue
    const group = bySize.get(file.size) || []
    group.push(file)
    bySize.set(file.size, group)
  }

  const candidateGroups = [...bySize.values()].filter((group) => group.length >= 2)
  const totalFiles = candidateGroups.reduce((sum, group) => sum + group.length, 0)
  const totalBytes = candidateGroups.reduce((sum, group) => sum + group.reduce((groupSum, file) => groupSum + file.size, 0), 0)
  let processedFiles = 0
  let processedBytes = 0
  onProgress?.({ phase: 'hashing', processedFiles, totalFiles, bytesRead: processedBytes, totalBytes, currentFile: '' })

  for (const group of candidateGroups) {
    const seen = new Map()
    for (const file of group) {
      throwIfAborted(signal)
      let hash
      let currentBytes = 0
      try {
        const cached = hashCache?.[file.path]
        if (cached?.hash && Number(cached.size) === Number(file.size) && Number(cached.mtimeMs) === Number(file.mtimeMs)) {
          hash = cached.hash
        } else {
          hash = await hashFileImpl(file.path, {
            signal,
            onProgress: ({ bytesRead }) => {
              currentBytes = bytesRead
              onProgress?.({
                phase: 'hashing',
                processedFiles,
                totalFiles,
                bytesRead: processedBytes + bytesRead,
                totalBytes,
                currentFile: file.name
              })
            }
          })
          onFileHashed?.(file, hash)
        }
      } catch (error) {
        if (signal?.aborted) throw abortError()
        processedFiles += 1
        processedBytes += currentBytes
        onProgress?.({ phase: 'hashing', processedFiles, totalFiles, bytesRead: processedBytes, totalBytes, currentFile: file.name })
        continue
      }
      const original = seen.get(hash)
      if (original) {
        dupes.push({ original: original.path, duplicate: file.path, name: file.name })
      } else {
        seen.set(hash, file)
      }
      processedFiles += 1
      processedBytes += file.size
      onProgress?.({ phase: 'hashing', processedFiles, totalFiles, bytesRead: processedBytes, totalBytes, currentFile: file.name })
    }
  }
  throwIfAborted(signal)
  return dupes
}

function suggestClip(files) {
  const suggestions = []
  const clusters = clusterByTag(files)
  for (const [tag, group] of Object.entries(clusters)) {
    if (group.length >= 2) {
      suggestions.push({
        tag,
        count: group.length,
        files: group.map((f) => f.path),
        suggestion: `按"${tag}"聚类 ${group.length} 个文件，可剪合集`
      })
    }
  }
  return suggestions
}

module.exports = { analyzeDir, analyzeDirAsync, extractTags, clusterByTag, hashFile, findDuplicates, suggestClip }
