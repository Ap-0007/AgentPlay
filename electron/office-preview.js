const path = require('path')
const mammoth = require('mammoth')
const ExcelJS = require('exceljs')

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function cellText(value) {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('')
  if (Object.prototype.hasOwnProperty.call(value, 'result')) return cellText(value.result)
  if (Object.prototype.hasOwnProperty.call(value, 'text')) return cellText(value.text)
  try { return JSON.stringify(value) } catch { return String(value) }
}

function buildSpreadsheetHtml(rows) {
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
  return `<table><tbody>${body}</tbody></table>`
}

async function previewDocx(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.doc') {
    try {
      const WordExtractor = require('word-extractor')
      const document = await new WordExtractor().extract(filePath)
      const text = String(document.getBody() || '').trim()
      if (!text) return { success: false, error: '这份 DOC 没有可预览的文字内容' }
      return { success: true, html: text.split(/\r?\n/).map((line) => `<p>${escapeHtml(line) || '&nbsp;'}</p>`).join('') }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }
  if (ext !== '.docx') {
    return { success: false, error: '仅支持安全预览 .docx/.doc，其他格式请使用系统 Office 打开' }
  }
  try {
    const result = await mammoth.convertToHtml({ path: filePath })
    return { success: true, html: result.value }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

async function previewXlsx(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.xlsx') {
    return { success: false, error: '旧式 .xls 不在安全预览范围，请使用系统 Office 打开' }
  }
  try {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)
    const sheet = workbook.worksheets[0]
    if (!sheet) return { success: false, error: '工作簿中没有可预览的工作表' }
    // 预览限 1000 行：全量读 10 万行会撑爆主进程内存并冻结
    const MAX_ROWS = 1000
    const rows = []
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber <= MAX_ROWS) rows.push(row.values.slice(1).map(cellText))
    })
    const total = sheet.rowCount
    const html = buildSpreadsheetHtml(rows)
    const note = total > MAX_ROWS
      ? `<p style="padding:8px;color:#888;font:12px system-ui">仅预览前 ${MAX_ROWS} 行（共 ${total} 行），完整内容请用系统 Office 打开</p>`
      : ''
    return { success: true, html: note + html }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

module.exports = { buildSpreadsheetHtml, escapeHtml, previewDocx, previewXlsx }
