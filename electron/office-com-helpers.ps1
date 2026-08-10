$script:AgentPlayTransientOfficeStartupHResults = @(
  -2146959355, # 0x80080005 CO_E_SERVER_EXEC_FAILURE
  -2147023174  # 0x800706BA RPC_S_SERVER_UNAVAILABLE
)

function New-AgentPlayOfficeApplication {
  param(
    [Parameter(Mandatory=$true)][string]$ProgId,
    [ValidateRange(1, 5)][int]$MaxAttempts = 3
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      return New-Object -ComObject $ProgId
    } catch {
      $isTransient = $script:AgentPlayTransientOfficeStartupHResults -contains $_.Exception.HResult
      if (-not $isTransient -or $attempt -eq $MaxAttempts) { throw }
      Start-Sleep -Milliseconds (300 * $attempt)
    }
  }
  throw "Office COM 启动失败: $ProgId"
}

function Stop-AgentPlayOfficeApplication {
  param($Application, [string]$Name = 'OFFICE')
  if (-not $Application) { return }
  try {
    $Application.Quit()
  } catch {
    # Office may exit after its last read-only document closes. RPC unavailable
    # means the target process is already gone; every other HRESULT must fail.
    if ($_.Exception.HResult -ne -2147023174) { throw }
    Write-Output "$Name QUIT OK | process already exited"
  } finally {
    try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Application) } catch { }
  }
}
