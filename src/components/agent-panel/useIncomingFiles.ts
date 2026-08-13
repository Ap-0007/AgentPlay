import type { AgentAttachment, DocumentCapabilities } from './types'
import { selectDocumentPreviewPath } from '../../document-preview-routing.mjs'

type IncomingFileOptions = {
  addMessage: (role: 'user' | 'agent', text: string) => void
  appendAttachments: (files: AgentAttachment[]) => void
  documentCapabilities: DocumentCapabilities | null
  setDocumentCapabilities: (value: DocumentCapabilities) => void
}

export default function useIncomingFiles(options: IncomingFileOptions) {
  const { addMessage, appendAttachments, documentCapabilities, setDocumentCapabilities } = options

  // Electron 32+ 不再保证 File.path，必须通过 webUtils.getPathForFile 获取真实路径。
  const attachIncomingFiles = async (files: FileList | File[]) => {
    const paths = Array.from(files)
      .map((file) => window.aiPlayer?.files?.getPathForFile?.(file) || (file as File & { path?: string }).path || '')
      .filter((value): value is string => Boolean(value))
    if (!paths.length) {
      addMessage('agent', '[错误] 没有读取到文件路径，请从资源管理器复制文件后再粘贴')
      return
    }
    const result = await window.aiPlayer?.documents?.attachPaths?.(paths)
    if (!result) return
    if (!Array.isArray(result)) {
      addMessage('agent', `[错误] ${result.error}`)
      return
    }
    if (!result.length) return
    appendAttachments(result)
    const previewPath = selectDocumentPreviewPath(result)
    if (previewPath) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: previewPath }))
    if (!documentCapabilities) {
      const capabilities = await window.aiPlayer?.documents?.capabilities()
      if (capabilities) setDocumentCapabilities(capabilities)
    }
  }

  const handleDropFiles = async (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    await attachIncomingFiles(event.dataTransfer.files)
  }

  const handlePasteFiles = async (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files)
    if (!files.length) return
    event.preventDefault()
    event.stopPropagation()
    await attachIncomingFiles(files)
  }

  return { attachIncomingFiles, handleDropFiles, handlePasteFiles }
}
