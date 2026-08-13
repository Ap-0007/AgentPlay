import type { AgentAttachment, SuggestedAction } from './types'

export function kindLabel(kind: string) {
  const labels: Record<string, string> = {
    'pdf-merge': '本地合并 PDF',
    'pdf-split': '本地拆分 PDF',
    'spreadsheet-edit': '表格清理与公式处理',
    convert: '本地格式转换',
    'ai-generate': 'AI 内容生成与整理',
    'docx-edit': '本地无损编辑 DOCX',
    'pptx-edit': '本地页面级编辑 PPTX',
    'office-convert': '本机 Office 高保真转换',
    'ai-bundle': 'AI 成套生成',
    'image-convert': '本地图片转换',
    'image-ask': '图片理解（云端视觉或本机 OCR）'
  }
  return labels[kind] || kind
}

export function buildSuggestedActions(attachments: AgentAttachment[]): SuggestedAction[] {
  if (!attachments.length) return []
  const exts = new Set(attachments.map((file) => file.ext))
  const has = (...list: string[]) => list.some((ext) => exts.has(ext))
  const actions: SuggestedAction[] = []
  if (has('.docx', '.doc', '.txt', '.md', '.rtf', '.odt')) {
    actions.push(
      { label: '整理成 Word', text: '把所选资料整理成结构清晰的中文 Word 文档，保留事实和关键数据，增加标题和要点。' },
      { label: '转成 PDF', text: '把所选文件高保真转成 PDF，保留原版式。' },
      { label: '做成 PPT', text: '根据所选资料制作一套 12 页以内的中文演示稿，每页只保留关键结论。' },
      { label: '提取文字', text: '提取所选文件的全部文字，另存为 TXT 文件。' }
    )
  }
  if (has('.xlsx', '.csv', '.ods')) {
    actions.push(
      { label: '清理表格', text: '清理所有文本首尾空格，并去除重复行。' },
      { label: '表格转 PDF', text: '把所选表格转成 PDF。' }
    )
  }
  if (has('.pdf')) {
    actions.push(
      { label: '提取文字', text: '提取 PDF 全部文字，另存为 TXT 文件。' },
      { label: '合并 PDF', text: '按照所选顺序合并这些 PDF，另存为一个新文件。' },
      { label: '拆分 PDF', text: '把 PDF 按页拆分成单页文件。' }
    )
  }
  if (has('.pptx', '.odp')) actions.push({ label: '演示稿转 PDF', text: '把演示稿转成 PDF。' })
  return actions.slice(0, 6)
}
