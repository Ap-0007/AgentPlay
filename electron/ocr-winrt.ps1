param(
  [string[]]$ImagePaths = @(),
  [string]$LangTag = '',
  [switch]$ListLanguages,
  [switch]$Words
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 2 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
if (-not $asTaskGeneric) { throw '找不到 WinRT AsTask 桥接方法' }
function Await-WinRt($AsyncOperation, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $task = $asTask.Invoke($null, @($AsyncOperation, [System.Threading.CancellationToken]::None))
  return $task.GetAwaiter().GetResult()
}
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]

$available = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
if ($ListLanguages) {
  Write-Output ("LANGS=" + (($available | ForEach-Object { $_.LanguageTag }) -join ','))
  exit 0
}

$engine = $null
if ($LangTag) {
  $lang = $available | Where-Object { $_.LanguageTag -eq $LangTag } | Select-Object -First 1
  if (-not $lang) { throw "本机未安装 OCR 识别语言：$LangTag" }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  if (-not $engine) { throw "无法启动 OCR 识别语言：$LangTag" }
} else {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $engine) { throw '本机没有可用的 OCR 识别语言' }

foreach ($imagePath in $ImagePaths) {
  Write-Output "###IMAGE $imagePath"
  try {
    $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRt ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    if ($Words) {
      # 表格恢复模式：逐词输出坐标（x y w h text，制表符分隔）
      foreach ($line in $result.Lines) {
        foreach ($word in $line.Words) {
          $r = $word.BoundingRect
          Write-Output ("W`t{0}`t{1}`t{2}`t{3}`t{4}" -f [math]::Round($r.X), [math]::Round($r.Y), [math]::Round($r.Width), [math]::Round($r.Height), $word.Text)
        }
      }
    } else {
      Write-Output '###TEXT'
      Write-Output $result.Text
    }
  } catch {
    Write-Output "###ERROR $($_.Exception.Message)"
  }
  Write-Output '###END'
}
