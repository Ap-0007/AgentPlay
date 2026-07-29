$ErrorActionPreference = 'Continue'
$out = 'D:\BUILD-~1\temp\office-quality'

# 1) Word COM 验证编辑后的 DOCX 能正常打开
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open("$out\复杂夹具-已编辑.docx", $false, $true)
  $paras = $doc.Paragraphs.Count
  $tables = $doc.Tables.Count
  Write-Output "WORD OK | 段落 $paras | 表格 $tables"
  $doc.Close($false)
} finally {
  $word.Quit()
}

# 2) PowerPoint COM 验证编辑后的 PPTX 能正常打开
$ppt = New-Object -ComObject PowerPoint.Application
try {
  $pres = $ppt.Presentations.Open("$out\母版夹具-已编辑.pptx", $true, $false, $false)
  $slides = $pres.Slides.Count
  $firstTitle = ''
  try { $firstTitle = $pres.Slides.Item(1).Shapes.Item(1).TextFrame.TextRange.Text } catch {}
  Write-Output "PPT OK | 页数 $slides | 首页标题 $firstTitle"
  $pres.Close()
} finally {
  $ppt.Quit()
}

# 3) Excel COM 重算公式
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
  $wb = $excel.Workbooks.Open("$out\公式夹具.xlsx")
  $excel.Calculate()
  $c1 = $wb.Worksheets.Item(1).Range('C1').Value2
  $d1 = $wb.Worksheets.Item(1).Range('D1').Value2
  $e1 = $wb.Worksheets.Item(1).Range('E1').Value2
  Write-Output "EXCEL RECALC | C1=$c1 (期望19) | D1=$d1 (期望12) | E1=$e1 (期望大)"
  $wb.Close($false)
} finally {
  $excel.Quit()
}
