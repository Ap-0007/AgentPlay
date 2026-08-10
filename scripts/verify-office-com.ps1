$ErrorActionPreference = 'Stop'
$out = 'D:\BUILD-~1\temp\office-quality'
. (Join-Path $PSScriptRoot '..\electron\office-com-helpers.ps1')

# 1) Verify the edited DOCX with the real Word COM runtime.
$word = New-AgentPlayOfficeApplication -ProgId 'Word.Application'
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open("$out\complex-fixture-edited.docx", $false, $true)
  $paras = $doc.Paragraphs.Count
  $tables = $doc.Tables.Count
  Write-Output "WORD OPEN OK | paragraphs=$paras | tables=$tables"
  $doc.Close($false)
} finally {
  Stop-AgentPlayOfficeApplication -Application $word -Name 'WORD'
}

# 2) Verify the edited PPTX with the real PowerPoint COM runtime.
$ppt = New-AgentPlayOfficeApplication -ProgId 'PowerPoint.Application'
try {
  $pres = $ppt.Presentations.Open("$out\master-fixture-edited.pptx", $true, $false, $false)
  $slides = $pres.Slides.Count
  $firstTitle = ''
  try { $firstTitle = $pres.Slides.Item(1).Shapes.Item(1).TextFrame.TextRange.Text } catch { }
  Write-Output "POWERPOINT OPEN OK | slides=$slides | firstTitle=$firstTitle"
  $pres.Close()
} finally {
  Stop-AgentPlayOfficeApplication -Application $ppt -Name 'POWERPOINT'
}

# 3) Recalculate the formula fixture with the real Excel COM runtime.
$excel = New-AgentPlayOfficeApplication -ProgId 'Excel.Application'
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
  $wb = $excel.Workbooks.Open("$out\formula-fixture.xlsx")
  $excel.Calculate()
  $c1 = $wb.Worksheets.Item(1).Range('C1').Value2
  $d1 = $wb.Worksheets.Item(1).Range('D1').Value2
  $e1 = $wb.Worksheets.Item(1).Range('E1').Value2
  Write-Output "EXCEL RECALC OK | C1=$c1 expected=19 | D1=$d1 expected=12 | E1=$e1 expected=large"
  $wb.Close($false)
} finally {
  Stop-AgentPlayOfficeApplication -Application $excel -Name 'EXCEL'
}
