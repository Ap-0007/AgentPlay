# Excel 图表/透视表生成（COM，确定性）：在已另存的输出文件上追加图表页/透视表页。
# 设计红线：宏全程禁用（DisplayAlerts=false 且不执行任何宏）；只改输出文件，不碰用户的源文件；
# 任何失败由调用方按"如实报错"处理，绝不假装成功。
param(
  [Parameter(Mandatory=$true)][string]$File,
  [int]$Chart = 0,
  [string]$ChartTitle = '数据图表',
  [switch]$Pivot,
  [string]$RowField = '',
  [string]$ValueField = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'office-com-helpers.ps1')

$excel = New-AgentPlayOfficeApplication -ProgId 'Excel.Application'
$excel.Visible = $false
$excel.DisplayAlerts = $false
$wb = $null
try {
  $wb = $excel.Workbooks.Open($File)
  $ws = $wb.Worksheets.Item(1)
  $used = $ws.UsedRange
  if ($used.Rows.Count -lt 2) { throw '数据不足（至少需要表头加一行数据）' }

  if ($Chart -ne 0) {
    $chartSheet = $wb.Worksheets.Add()
    $chartSheet.Name = 'AgentPlay图表'
    $obj = $chartSheet.ChartObjects().Add(20, 20, 640, 400)
    $obj.Chart.SetSourceData($used)
    $obj.Chart.ChartType = $Chart
    $obj.Chart.HasTitle = $true
    $obj.Chart.ChartTitle.Text = $ChartTitle
  }

  if ($Pivot) {
    $headers = @()
    foreach ($cell in $used.Rows.Item(1).Cells) { $headers += [string]$cell.Text }
    if ($headers.Count -lt 2) { throw '列数不足（透视表至少需要两列）' }
    $row = if ($RowField -ne '') { $RowField } else { [string]$headers[0] }
    $val = $ValueField
    if ($val -eq '') {
      # 默认第一个数值列作为汇总值
      for ($c = 2; $c -le $headers.Count; $c++) {
        $v = $ws.Cells.Item(2, $c).Value2
        if ($null -ne $v -and ($v -is [double] -or $v -is [int] -or $v -is [long] -or $v -is [decimal])) { $val = [string]$headers[$c - 1]; break }
      }
      if ($val -eq '') { throw '没有可汇总的数值列，请指明要汇总哪一列' }
    }
    $pivotSheet = $wb.Worksheets.Add()
    $pivotSheet.Name = 'AgentPlay透视表'
    $cache = $wb.PivotCaches().Create(1, $used)
    $pt = $cache.CreatePivotTable($pivotSheet.Range('A3'), 'AgentPlay透视')
    $pt.PivotFields($row).Orientation = 1   # xlRowField
    $pt.PivotFields($val).Orientation = 4   # xlDataField（默认求和）
  }

  $wb.Save()
  $wb.Close($false)
  try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($wb) } catch { }
  $wb = $null
  Write-Output 'ENRICH-OK'
} finally {
  if ($wb) {
    try { $wb.Close($false) } catch { }
    try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($wb) } catch { }
  }
  Stop-AgentPlayOfficeApplication -Application $excel -Name 'EXCEL'
}
