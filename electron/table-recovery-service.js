// 表格恢复：OCR 词坐标 → 行列聚类 → XLSX 网格。
// 行=按 y 中心容差归并；列=行内大空隙切单元格后按 x 起点向最宽行对齐。
// 没有多列结构时如实报错（多半是普通文字页），不硬凑表格。
const fs = require('fs')
const path = require('path')
const ExcelJS = require('exceljs')
const { normalizeOcrText } = require('./ocr-service')

function clusterRows(words, { rowTolerance } = {}) {
  const heights = words.map((w) => w.h).sort((a, b) => a - b)
  const medianH = heights[Math.floor(heights.length / 2)] || 10
  const tolerance = rowTolerance || Math.max(6, medianH * 0.7)
  const sorted = [...words].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x)
  const rows = []
  for (const w of sorted) {
    const cy = w.y + w.h / 2
    const row = rows[rows.length - 1]
    if (row && Math.abs(cy - row.cy) <= tolerance) {
      row.words.push(w)
      row.cy = (row.cy * (row.words.length - 1) + cy) / row.words.length
    } else {
      rows.push({ cy, words: [w] })
    }
  }
  return rows.map((row) => row.words.sort((a, b) => a.x - b.x))
}

function clusterColumns(rows) {
  // 列边界按字号高度相对阈值：超过 1.5 倍字高的空隙视为新单元格。
  // （按词距中位数会把"无词内空格"的规整表格整行并成一格——07-29 实踩）
  const heights = rows.flat().map((w) => w.h).sort((a, b) => a - b)
  const medianH = heights[Math.floor(heights.length / 2)] || 16
  const threshold = Math.max(12, medianH * 1.5)
  const cellRows = rows.map((row) => {
    const cells = []
    for (const w of row) {
      const last = cells[cells.length - 1]
      if (last && (w.x - last.right) > threshold) {
        cells.push({ x: w.x, right: w.x + w.w, text: w.text })
      } else if (last) {
        last.right = w.x + w.w
        // 词间按单空格拼接，收尾统一走 normalizeOcrText 收拢 CJK/数字内空格
        last.text += ' ' + w.text
      } else {
        cells.push({ x: w.x, right: w.x + w.w, text: w.text })
      }
    }
    return cells.map((cell) => ({ ...cell, text: normalizeOcrText(cell.text) }))
  })
  const anchor = cellRows.reduce((best, cells) => (cells.length > best.length ? cells : best), [])
  const centers = anchor.map((cell) => cell.x)
  return cellRows.map((cells) => {
    const out = new Array(centers.length).fill('')
    for (const cell of cells) {
      let best = 0
      let bestDist = Infinity
      centers.forEach((cx, index) => {
        const dist = Math.abs(cell.x - cx)
        if (dist < bestDist) {
          bestDist = dist
          best = index
        }
      })
      out[best] = out[best] ? `${out[best]} ${cell.text}` : cell.text
    }
    return out
  })
}

function writeOut(finalPath, buffer) {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  const tempPath = `${finalPath}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, buffer)
  fs.renameSync(tempPath, finalPath)
}

// 往已有工作簿写入一个表（PDF 逐页恢复时一页一表）；返回网格信息
async function recoverTableInto(workbook, words, sheetName) {
  if (!Array.isArray(words) || words.length === 0) throw new Error('没有识别到文字')
  const rows = clusterRows(words)
  const grid = clusterColumns(rows)
  const wideRows = grid.filter((row) => row.filter(Boolean).length >= 2)
  if (wideRows.length < 2) throw new Error('没有检测到多列表格结构')
  const sheet = workbook.addWorksheet(sheetName)
  for (const row of grid) sheet.addRow(row)
  for (let index = 0; index < grid[0].length; index += 1) sheet.getColumn(index + 1).width = 22
  return { rows: grid.length, cols: grid[0].length }
}

async function recoverTable({ words, finalPath, sheetName = '表格1' }) {
  if (!Array.isArray(words) || words.length === 0) throw new Error('没有识别到文字，无法恢复表格')
  const workbook = new ExcelJS.Workbook()
  const info = await recoverTableInto(workbook, words, sheetName)
  writeOut(finalPath, await workbook.xlsx.writeBuffer())
  return {
    ...info,
    summary: `表格恢复完成：${info.rows} 行 × ${info.cols} 列（词级 OCR 聚类，边界单元格建议人工抽查）`
  }
}

module.exports = { recoverTable, recoverTableInto, clusterRows, clusterColumns }
