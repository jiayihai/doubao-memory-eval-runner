$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '未找到 .NET Framework C# 编译器' }
$source = Join-Path $projectDirectory 'ui\RunnerWindow.cs'
$previewSource = Join-Path $projectDirectory 'ui\DatasetPreviewWindow.cs'
$manualSource = Join-Path $projectDirectory 'ui\ManualStepWindow.cs'
$package = Get-Content -LiteralPath (Join-Path $projectDirectory 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$destination = Join-Path $projectDirectory ('豆包测评执行器V1_' + $package.version + '.exe')
& $compiler /nologo /codepage:65001 /target:winexe /platform:anycpu /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll "/out:$destination" $source $previewSource $manualSource
if ($LASTEXITCODE -ne 0) { throw '窗口编译失败' }
Write-Output "已生成：$destination"

Copy-Item -LiteralPath (Join-Path $projectDirectory 'ui\App.config') -Destination ($destination + '.config') -Force
