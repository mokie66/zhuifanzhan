<#
.SYNOPSIS
    构建 Android APK（自动定位 JDK 与 Android SDK）

.DESCRIPTION
    构建本项目的 Android 安装包。环境探测逻辑复用 _android-env.ps1，
    在中国大陆常见的「装了多个 JDK」「SDK 不在 C 盘」等情况下都能正确工作：
      1. JDK 按版本号降序取最高（Capacitor 8 要求 21+，用错版本会报「无效的源发行版：21」）
      2. Android SDK 优先读环境变量与 android/local.properties，不依赖固定盘符
      3. 缺少的 SDK 组件自动补装

    签名：release 版需要签名。首次构建 release 前先执行
          powershell -ExecutionPolicy Bypass -File scripts\gen-keystore.ps1

.PARAMETER Release
    构建 release 版（关闭 debuggable、禁止 adb 导出应用数据），默认 debug。

.PARAMETER SkipWeb
    跳过 web 构建与同步，只重跑 gradle（改过原生代码时用，快很多）。

.PARAMETER Clean
    构建前执行 gradle clean。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1
    powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1 -Release
    powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1 -SkipWeb
#>
[CmdletBinding()]
param(
    [switch]$Release,
    [switch]$SkipWeb,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot '_android-env.ps1')

function Write-Step($m) { Write-Host "`n>>> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "    $m" -ForegroundColor Yellow }
function Write-Err($m)  { Write-Host "    $m" -ForegroundColor Red }

# 本项目 Android 工程要求的最低版本（Capacitor 8 决定）
$JDK_MIN        = 21
$SDK_PLATFORM   = 'android-36'
$SDK_BUILDTOOLS = '36.0.0'

# ===========================================================================
# 1. 定位 JDK
# ===========================================================================
Write-Step "检测 JDK（需要 $JDK_MIN+）"

$jdk = Resolve-Jdk -MinimumMajor $JDK_MIN
if (-not $jdk) {
    Write-Err "未找到 JDK $JDK_MIN+"
    Write-Host ''
    Write-Host '  Capacitor 8 的 Android 工程要求 JDK 21 或更高。安装方式：' -ForegroundColor Yellow
    Write-Host '    winget install --id Microsoft.OpenJDK.21' -ForegroundColor White
    Write-Host ''
    Write-Host '  或设置 JAVA_HOME 指向已有的 JDK 21+' -ForegroundColor Yellow
    exit 1
}
Write-Ok "JDK $($jdk.Version) : $($jdk.Path)"

# ===========================================================================
# 2. 定位 Android SDK
# ===========================================================================
Write-Step '检测 Android SDK'

$sdk = Resolve-AndroidSdk -ProjectRoot $root
if (-not $sdk) {
    Write-Err '未找到 Android SDK（需含 platform-tools 目录）'
    Write-Host ''
    Write-Host '  设置环境变量指向 SDK 目录：' -ForegroundColor Yellow
    Write-Host '    setx ANDROID_HOME "D:\path\to\android-sdk"' -ForegroundColor White
    Write-Host ''
    Write-Host '  或用命令行工具自行安装：' -ForegroundColor Yellow
    Write-Host '    https://dl.google.com/android/repository/commandlinetools-win-*_latest.zip' -ForegroundColor Gray
    Write-Host "    sdkmanager --sdk_root=<SDK> `"platform-tools`" `"platforms;$SDK_PLATFORM`" `"build-tools;$SDK_BUILDTOOLS`"" -ForegroundColor Gray
    exit 1
}
Write-Ok "SDK : $sdk"

# 同步写入 local.properties，保证 gradle 也能找到
$localProps = Join-Path $root 'android\local.properties'
$needWrite = $true
if (Test-Path $localProps) {
    $cur = Get-Content $localProps -Raw -ErrorAction SilentlyContinue
    if ($cur -and $cur -match [regex]::Escape($sdk)) { $needWrite = $false }
}
if ($needWrite) {
    $escaped = $sdk -replace '\\', '/'
    [IO.File]::WriteAllText($localProps, "sdk.dir=$escaped`n", [Text.UTF8Encoding]::new($false))
    Write-Ok '已写入 android/local.properties'
}

# ===========================================================================
# 3. 检查并按需补装 SDK 组件
# ===========================================================================
Write-Step '检查 SDK 组件'

$ok = Resolve-AndroidComponent -Sdk $sdk -JdkPath $jdk.Path `
        -Packages @("platforms;$SDK_PLATFORM", "build-tools;$SDK_BUILDTOOLS")
if (-not $ok) {
    Write-Err "SDK 组件不完整，无法继续"
    exit 1
}
Write-Ok "$SDK_PLATFORM / build-tools $SDK_BUILDTOOLS 就绪"

# ===========================================================================
# 4. 装配环境变量
# ===========================================================================
$env:JAVA_HOME        = $jdk.Path
$env:ANDROID_HOME     = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:PATH             = "$($jdk.Path)\bin;$sdk\platform-tools;$env:PATH"

# ===========================================================================
# 5. 构建
# ===========================================================================
Push-Location $root
try {
    if (-not $SkipWeb) {
        Write-Step '构建 web 产物'
        $b = Invoke-NativeCommand -FilePath 'npm' -Arguments @('run', 'build')
        if ($b.ExitCode -ne 0) {
            Write-Err 'web 构建失败'
            $b.Output | Select-Object -Last 15 | ForEach-Object { "    $_" }
            exit 1
        }
        Write-Ok 'web 构建完成'

        Write-Step '同步到 Android 工程'
        $s = Invoke-NativeCommand -FilePath 'npx' -Arguments @('cap', 'sync', 'android')
        if ($s.ExitCode -ne 0) {
            Write-Err 'cap sync 失败'
            $s.Output | Select-Object -Last 15 | ForEach-Object { "    $_" }
            exit 1
        }
        Write-Ok '同步完成'
    } else {
        Write-Warn2 '已跳过 web 构建与同步'
    }

    # release 前检查签名
    if ($Release) {
        $ksProps = Join-Path $root 'android\keystore.properties'
        if (-not (Test-Path $ksProps)) {
            Write-Host ''
            Write-Err '未配置发布签名，无法产出可安装的 release 包'
            Write-Host '  请先执行：' -ForegroundColor Yellow
            Write-Host '    powershell -ExecutionPolicy Bypass -File scripts\gen-keystore.ps1' -ForegroundColor White
            exit 1
        }
        Write-Ok '签名配置已就绪'
    }

    $task = if ($Release) { 'assembleRelease' } else { 'assembleDebug' }
    Write-Step "Gradle 构建（$task）"

    Push-Location (Join-Path $root 'android')
    try {
        $gradlew = Join-Path (Get-Location) 'gradlew.bat'
        if ($Clean) {
            Write-Warn2 '执行 gradle clean…'
            $null = Invoke-NativeCommand -FilePath $gradlew -Arguments @('clean')
        }
        # gradle 输出很长，实时打印更能反映进度，这里直接调用（错误由退出码判断）
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $gradlew $task
            $gradleExit = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $prev
        }
        if ($gradleExit -ne 0) {
            Write-Err "gradle $task 失败（退出码 $gradleExit）"
            exit 1
        }
    } finally {
        Pop-Location
    }

    # =======================================================================
    # 6. 报告产物
    # =======================================================================
    Write-Step '构建产物'
    $variant = if ($Release) { 'release' } else { 'debug' }
    $apkDir = Join-Path $root "android\app\build\outputs\apk\$variant"

    if (-not (Test-Path $apkDir)) {
        Write-Warn2 "未找到产物目录: $apkDir"
        exit 0
    }
    $apks = Get-ChildItem $apkDir -Filter '*.apk' -ErrorAction SilentlyContinue
    if (-not $apks) {
        Write-Warn2 "产物目录里没有 APK: $apkDir"
        exit 0
    }

    $apksigner = Join-Path $sdk "build-tools\$SDK_BUILDTOOLS\apksigner.bat"

    foreach ($apk in $apks) {
        $mb = [math]::Round($apk.Length / 1MB, 2)
        Write-Ok "$($apk.Name)  ($mb MB)"
        Write-Host "        $($apk.FullName)" -ForegroundColor Gray

        if ((Test-Path $apksigner) -and $apk.Name -match 'release') {
            $sig = Invoke-NativeCommand -FilePath $apksigner -Arguments @('verify', '--print-certs', $apk.FullName)
            if ($sig.ExitCode -eq 0) {
                $dn = ($sig.Output | Select-String -Pattern 'certificate DN' | Select-Object -First 1)
                Write-Host "        已签名 OK  $($dn -replace '.*DN:\s*', '')" -ForegroundColor Green
            } else {
                Write-Host '        未签名（无法安装）' -ForegroundColor Red
            }
        }
    }

    Write-Host ''
    Write-Host '安装到已连接设备：' -ForegroundColor Cyan
    foreach ($apk in $apks) {
        Write-Host "    adb install -r `"$($apk.FullName)`"" -ForegroundColor White
    }

    if (-not $Release) {
        Write-Host ''
        Write-Warn2 '这是 debug 包：application-debuggable=true，任何能接触设备的人都可用 adb 调试。'
        Write-Warn2 '若要分发给他人，建议构建 release 版：'
        Write-Host '    powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1 -Release' -ForegroundColor White
    }

    Write-Host ''
    Write-Host ('=' * 76) -ForegroundColor Cyan
    Write-Host '  全部完成' -ForegroundColor Cyan
    Write-Host ('=' * 76) -ForegroundColor Cyan
} finally {
    Pop-Location
}
