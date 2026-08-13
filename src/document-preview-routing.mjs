export function selectDocumentPreviewPath(documents) {
  if (!Array.isArray(documents)) return null
  const document = documents.find((item) => typeof item?.previewPath === 'string' && item.previewPath.trim())
  return document?.previewPath || null
}

export function selectPrimaryPreviewPath(media, documents) {
  const mediaPath = Array.isArray(media)
    ? media.find((item) => typeof item === 'string' && item.trim())
    : null
  return mediaPath || selectDocumentPreviewPath(documents)
}
