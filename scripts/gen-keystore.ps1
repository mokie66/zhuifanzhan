<#
.SYNOPSIS
    生成 Android 发布签名密钥（keystore）并写入签名配置

.DESCRIPTION
    release 版 APK 必须签名。debug 版用的是 Android 默认调试密钥，
    其 application-debuggable=true 会让任何能接触设备的人用 adb 调试你的 App，
    且部分安全软件会因此弹警告。

    本脚本会：
      1. 复用 _android-env.ps1 定位 JDK（自动取最高版本）
      2. 生成自签名 keystore（RSA 2048，有效期 30 年）
      3. 在 android/keystore.properties 写入签名配置（已被 .gitignore 忽略）
      4. 提示备份

.PARAMETER Alias
    密钥别名，默认 zhuifan

.PARAMETER Dname
    证书主题。默认用中性信息（CN=Zhuifan 等），**不要填真实姓名/公司**——
    证书信息会打进 APK，任何人都能用 keytool 读到。

.PARAMETER Force
    已存在时强制重新生成（旧签名的包将无法覆盖升级安装）

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\gen-keystore.ps1
#>
[CmdletBinding()]
param(
    [string]$Alias = 'zhuifan',
    [string]$Dname = 'CN=Zhuifan, OU=Personal, O=Personal, L=Unknown, ST=Unknown, C=CN',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot '_android-env.ps1')

function Write-Step($m) { Write-Host "`n>>> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }

$androidDir = Join-Path $root 'android'
$ksPath     = Join-Path $androidDir "$Alias-release.jks"
$propsPath  = Join-Path $androidDir 'keystore.properties'

# ---------- 1. 定位 JDK ----------
Write-Step '定位 JDK'

$jdk = Resolve-Jdk -MinimumMajor 8   # keytool 本身 JDK 8 即可
if (-not $jdk) {
    Write-Host "`n未找到任何 JDK（keytool 随 JDK 提供）。安装方式：" -ForegroundColor Red
    Write-Host '    winget install --id Microsoft.OpenJDK.21' -ForegroundColor Yellow
    exit 1
}
$keytool = Join-Path $jdk.Path 'bin\keytool.exe'
Write-Ok "JDK $($jdk.Version) : $($jdk.Path)"

# ---------- 2. 已存在则确认 ----------
if ((Test-Path $ksPath) -and -not $Force) {
    Write-Host "`n密钥已存在: $ksPath" -ForegroundColor Yellow
    Write-Host '若要重新生成请加 -Force（注意：旧签名的 APK 将无法覆盖升级安装）' -ForegroundColor Yellow
    exit 0
}

# ---------- 3. 生成随机口令 ----------
Write-Step '生成密钥与口令'

# 用 GUID 派生：足够随机，且避免用户手输弱口令
$storePass = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')).Substring(0, 24)
$keyPass   = $storePass

# ---------- 4. 调用 keytool ----------
Write-Step '生成密钥库'

$r = Invoke-NativeCommand -FilePath $keytool -Arguments @(
    '-genkeypair',
    '-v',
    '-keystore', $ksPath,
    '-alias', $Alias,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10950',
    '-storepass', $storePass,
    '-keypass', $keyPass,
    '-dname', $Dname,
    # 强制英文输出，避免区域设置导致输出乱码难以排查
    '-J-Duser.language=en'
)
$r.Output | ForEach-Object { "    $_" }

if ($r.ExitCode -ne 0 -or -not (Test-Path $ksPath)) {
    Write-Host "`nkeytool 执行失败（退出码 $($r.ExitCode)）" -ForegroundColor Red
    exit 1
}
Write-Ok "密钥库已生成: $ksPath"

# ---------- 5. 写签名配置 ----------
Write-Step '写入签名配置'

# storeFile 用相对 android/app 的路径，避免把绝对路径写死
$props = @"
# Android 发布签名配置
# 本文件已被 .gitignore 忽略，切勿提交到版本库或随工程分发
# 若本文件或对应 .jks 泄露，他人即可伪造你的 App 签名

storeFile=../$Alias-release.jks
storePassword=$storePass
keyAlias=$Alias
keyPassword=$keyPass
"@

# Java 的 Properties.load 对 BOM 敏感，必须无 BOM
[IO.File]::WriteAllText($propsPath, $props, [Text.UTF8Encoding]::new($false))
Write-Ok "签名配置已写入: $propsPath"

# ---------- 6. 验证能读回 ----------
Write-Step '验证签名可用性'

$verify = Invoke-NativeCommand -FilePath $keytool -Arguments @(
    '-list', '-keystore', $ksPath, '-storepass', $storePass, '-alias', $Alias,
    '-J-Duser.language=en'
)
if ($verify.ExitCode -eq 0) {
    $verify.Output | Where-Object { $_ -match 'Alias|Valid|Signature algorithm|Subject' } |
        Select-Object -First 6 | ForEach-Object { "    $($_.Trim())" }
    Write-Ok '密钥可正常读取'
} else {
    Write-Host '    密钥读取失败：' -ForegroundColor Red
    $verify.Output | Select-Object -First 5 | ForEach-Object { "    $_" }
    exit 1
}

# ---------- 7. 备份提醒 ----------
Write-Host ''
Write-Host ('=' * 76) -ForegroundColor Yellow
Write-Host '  重要：请立即备份密钥' -ForegroundColor Yellow
Write-Host ('=' * 76) -ForegroundColor Yellow
Write-Host ''
Write-Host "  密钥库：  $ksPath"
Write-Host "  口令文件：$propsPath"
Write-Host ''
Write-Host '  Android 要求同一 App 的所有版本用同一密钥签名，否则用户无法覆盖升级安装' -ForegroundColor Gray
Write-Host '  （必须卸载重装，本地收藏与观看记录全部丢失）。' -ForegroundColor Gray
Write-Host ''
Write-Host '  这两个文件已被 .gitignore 忽略（*.jks / keystore.properties），' -ForegroundColor Gray
Write-Host '  但请另行备份到安全位置，并确认没有以其他方式分享出去。' -ForegroundColor Gray
Write-Host ''
Write-Host '下一步：构建 release 版 APK' -ForegroundColor Cyan
Write-Host '    powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1 -Release' -ForegroundColor White
