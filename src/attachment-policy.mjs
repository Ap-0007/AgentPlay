function attachmentIdentity(file) {
  const previewPath = String(file?.previewPath || '').trim()
  if (previewPath) return `path:${previewPath.replace(/\\/g, '/').toLowerCase()}`
  return `file:${String(file?.name || '').trim().toLowerCase()}|${String(file?.ext || '').toLowerCase()}|${Number(file?.size) || 0}`
}

export function dedupeAttachments(files) {
  const latest = new Map()
  for (const file of Array.isArray(files) ? files : []) latest.set(attachmentIdentity(file), file)
  return [...latest.values()]
}
