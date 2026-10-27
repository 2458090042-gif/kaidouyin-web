param(
    [string]$JsFile = "c.js",      # 注入的脚本：c.js = 不限画质，c1.js = 1080P 封顶
    [string]$ExeSuffix = ""        # 输出后缀：空 = 开抖音.exe，1 = 开抖音1.exe，2 = 开抖音2.exe
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
# 杀掉可能占用 exe 文件的运行实例（进程名用码点构造避免编码问题）
$exeName = [string]([char]0x5F00) + [char]0x6296 + [char]0x97F3 + $ExeSuffix
Get-Process -Name $exeName -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300

$cs = Get-Content -Raw -Encoding UTF8 (Join-Path $root "main.cs")
$js = Get-Content -Raw -Encoding UTF8 (Join-Path $root $JsFile)
$m  = Get-Content -Raw -Encoding UTF8 (Join-Path $root "manifest.json")
$jsE = $js.Replace('"', '""')
$mE  = $m.Replace('"', '""')
$cs = $cs.Replace('__MANIFEST__', $mE).Replace('__SCRIPT__', $jsE)
if ($cs.Contains('__MANIFEST__') -or $cs.Contains('__SCRIPT__')) { throw "placeholder replace failed" }

$out = Join-Path $env:TEMP ("kai_douyin" + $ExeSuffix + ".exe")
if (Test-Path $out) { Remove-Item $out -Force }
# 用 Windows PowerShell 5.1 + .NET Framework 编译：产物只有一个 exe，不依赖 .NET 8 运行时
$csPath = Join-Path $env:TEMP ("kai_douyin" + $ExeSuffix + ".cs")
[System.IO.File]::WriteAllText($csPath, $cs, (New-Object System.Text.UTF8Encoding($true)))
$build = @"
`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition (Get-Content -Raw -Encoding UTF8 '$csPath') ``
    -OutputAssembly '$out' -OutputType WindowsApplication ``
    -ReferencedAssemblies System.Management
"@
$buildPath = Join-Path $env:TEMP ("kai_douyin_build" + $ExeSuffix + ".ps1")
[System.IO.File]::WriteAllText($buildPath, $build, (New-Object System.Text.UTF8Encoding($true)))
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $buildPath
Remove-Item $buildPath -Force -ErrorAction SilentlyContinue
Remove-Item $csPath -Force -ErrorAction SilentlyContinue
if (-not (Test-Path $out)) { throw "compile output missing" }
Write-Output ("COMPILED: " + (Get-Item $out).Length)

$destName = $exeName + ".exe"
$destDir = Join-Path $root "dist"
New-Item -ItemType Directory $destDir -Force | Out-Null
$dest = Join-Path $destDir $destName
$oldHash = if (Test-Path $dest) { (Get-FileHash $dest -Algorithm SHA256).Hash } else { "NONE" }
Copy-Item $out $dest -Force
$newHash = (Get-FileHash $dest -Algorithm SHA256).Hash
Write-Output ("OLD_HASH: " + $oldHash)
Write-Output ("NEW_HASH: " + $newHash)
Write-Output ("DEST_SIZE: " + (Get-Item $dest).Length)
Remove-Item $out -Force
Write-Output "BUILD_OK"
