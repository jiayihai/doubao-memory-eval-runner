$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExecutable = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node.exe')) { Join-Path $PSScriptRoot 'node.exe' } elseif ($env:NODE_EXECUTABLE -and (Test-Path -LiteralPath $env:NODE_EXECUTABLE)) { $env:NODE_EXECUTABLE } elseif ($nodeCommand) { $nodeCommand.Source } else { throw '请先从 https://nodejs.org/ 安装 Node.js 22.15 或更新版本（包含 npm），然后重新打开此安装程序。' }
$versionText = & $nodeExecutable --version
if ($LASTEXITCODE -ne 0) { throw '无法运行 Node.js' }
$nodeVersion = [Version]($versionText.Trim().TrimStart('v'))
if ($nodeVersion -lt [Version]'22.15.0') { throw ('Node.js 版本过旧：' + $versionText + '；需要 22.15 或更新版本。') }
$npmExecutable = Join-Path (Split-Path -Parent $nodeExecutable) 'npm.cmd'
if (-not (Test-Path -LiteralPath $npmExecutable)) {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommand) { throw '未找到 npm.cmd，请重新安装包含 npm 的 Node.js。' }
    $npmExecutable = $npmCommand.Source
}
Write-Output ('Node.js ' + $versionText + '；按 package-lock.json 安装公开依赖……')
& $npmExecutable ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org --offline=false
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。请检查到 registry.npmjs.org 的网络连接，处理后重新运行；不要忽略安装失败。' }
& $nodeExecutable --input-type=module -e "import ExcelJS from 'exceljs'; import JSZip from 'jszip'; const b=new ExcelJS.Workbook(); b.addWorksheet('InstallCheck').getCell('A1').value='OK'; const data=await b.xlsx.writeBuffer(); const copy=new ExcelJS.Workbook(); await copy.xlsx.load(data); if(copy.getWorksheet(1).getCell('A1').value!=='OK')throw new Error('Excel dependency check failed'); console.log('ExcelJS + JSZip: OK');"
if ($LASTEXITCODE -ne 0) { throw 'Excel 依赖验证失败，尚未完成安装。' }
& (Join-Path $PSScriptRoot '构建窗口.ps1')
Write-Output '安装完成。请打开本目录的豆包测评执行器V1_1.8.0.exe，并在界面选择实际豆包程序路径。'
