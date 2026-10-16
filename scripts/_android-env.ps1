<#
.SYNOPSIS
    Android 构建环境探测（共享模块）

.DESCRIPTION
    被 build-apk.ps1 与 gen-keystore.ps1 共同引用，避免两处重复实现同一套逻辑。

    探测两类工具链：
      JDK          Capacitor 8 的 Android 工程要求 JDK 21+，用错版本会报「无效的源发行版：21」
      Android SDK  需要含 platform-tools，且要有 android-36 与 build-tools 36.0.0

    两条踩过的坑，这里都做了处理：
      1. JDK 必须按**版本号降序**取最高。直接按目录名排序会先命中 jdk-17（字典序 17 < 21），
         导致选到不满足要求的版本。
      2. 调用 keytool / gradlew 这类原生命令时，它们会把正常输出写进 stderr。
         在 $ErrorActionPreference='Stop' 下 PowerShell 会把它当致命错误抛出，
         所以必须临时放宽偏好并改用 $LASTEXITCODE 判断成败。

    注意：本文件含中文，必须保存为 UTF-8 with BOM，
          否则 Windows PowerShell 5.1 会按 ANSI 解码导致解析失败。
#>

function Get-JavaMajorVersion {
    <#
      读取 java.exe 的主版本号，失败返回 0。

      注意：必须走 Invoke-NativeCommand。
      因为 `java -version` 把版本号写在 **stderr**，在 $ErrorActionPreference='Stop'
      下会被 PowerShell 当作致命错误抛出；若用 try/catch 简单吞掉，
      就会让所有 JDK 都返回 0 —— 表现为「明明装了 JDK 却报未找到」。
      这个坑实际踩过一次，别再改回去。
    #>
    param([Parameter(Mandatory)][string]$JavaExe)
    $r = Invoke-NativeCommand -FilePath $JavaExe -Arguments @('-version')
    $line = $r.Output | Where-Object { $_ -match 'version' } | Select-Object -First 1
    if ("$line" -match '"(\d+)') { return [int]$Matches[1] }
    return 0
}

function Resolve-Jdk {
    <#
      定位满足最低版本要求的 JDK，返回版本号最高的那个。
      @returns @{ Path; Version } 或 $null
    #>
    param([int]$MinimumMajor = 21)

    $candidates = @()

    # 环境变量优先（通常是用户刻意配置）
    if ($env:JAVA_HOME -and (Test-Path $env:JAVA_HOME)) { $candidates += $env:JAVA_HOME }

    # Android Studio 自带的 JBR
    foreach ($p in @(
        "$env:LOCALAPPDATA\Programs\Android Studio\jbr",
        "$env:ProgramFiles\Android\Android Studio\jbr"
    )) { if (Test-Path $p) { $candidates += $p } }

    # 常见安装位置
    foreach ($glob in @(
        "$env:ProgramFiles\Microsoft\jdk-*",
        "$env:ProgramFiles\Eclipse Adoptium\jdk-*",
        "$env:ProgramFiles\Java\jdk-*",
        "$env:ProgramFiles\BellSoft\LibericaJDK-*",
        "$env:ProgramFiles\Zulu\zulu-*",
        "$env:ProgramFiles\Amazon Corretto\jdk*",
        "$env:LOCALAPPDATA\Programs\Eclipse Adoptium\jdk-*"
    )) {
        # 注意：-Directory 是 Get-ChildItem 的参数，Get-Item 没有该参数
        Get-ChildItem -Path $glob -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { $candidates += $_.FullName }
    }

    # PATH 里的 java 反推
    $javaOnPath = Get-Command java -ErrorAction SilentlyContinue
    if ($javaOnPath) {
        $candidates += (Split-Path -Parent (Split-Path -Parent $javaOnPath.Source))
    }

    # 逐个求版本，收集满足条件的
    $found = @()
    foreach ($cand in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        $javaExe = Join-Path $cand 'bin\java.exe'
        if (-not (Test-Path $javaExe)) { continue }
        $major = Get-JavaMajorVersion -JavaExe $javaExe
        if ($major -ge $MinimumMajor) {
            $found += [pscustomobject]@{ Path = $cand; Version = $major }
        }
    }

    if (-not $found) { return $null }
    # 关键：按版本号降序，取最高。不能依赖目录名排序
    return ($found | Sort-Object -Property Version -Descending | Select-Object -First 1)
}

function Resolve-AndroidSdk {
    <#
      定位 Android SDK（需含 platform-tools）。
      @returns SDK 路径 或 $null
    #>
    param([string]$ProjectRoot)

    $candidates = @()

    # 环境变量
    if ($env:ANDROID_HOME)     { $candidates += $env:ANDROID_HOME }
    if ($env:ANDROID_SDK_ROOT) { $candidates += $env:ANDROID_SDK_ROOT }

    # 工程自己的权威声明
    if ($ProjectRoot) {
        $lp = Join-Path $ProjectRoot 'android\local.properties'
        if (Test-Path $lp) {
            $line = Get-Content $lp -ErrorAction SilentlyContinue |
                    Where-Object { $_ -match '^\s*sdk\.dir\s*=' } | Select-Object -First 1
            if ($line) {
                $dir = ($line -split '=', 2)[1].Trim()
                # Java Properties 中转义：\\ -> \ ，\: -> :
                $dir = $dir -replace '\\\\', '\' -replace '\\:', ':'
                if (Test-Path $dir) { $candidates += $dir }
            }
        }
    }

    # 常见位置
    $candidates += @(
        "$env:LOCALAPPDATA\Android\Sdk",
        "$env:USERPROFILE\AppData\Local\Android\Sdk",
        "C:\Android\Sdk"
    )

    foreach ($cand in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        if (Test-Path (Join-Path $cand 'platform-tools')) { return $cand }
    }
    return $null
}

function Invoke-NativeCommand {
    <#
      安全调用原生命令。

      为什么需要它：keytool / gradlew / sdkmanager 都会把**正常输出**写进 stderr。
      在 $ErrorActionPreference='Stop' 下，PowerShell 会把 stderr 输出当成致命错误抛出
      （表现为 NativeCommandError），导致明明成功的命令被判为失败。

      处理方式：临时把偏好放宽为 Continue，完整捕获输出，只以 $LASTEXITCODE 判断成败。

      @returns @{ ExitCode; Output }
    #>
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(ValueFromRemainingArguments)][string[]]$Arguments
    )

    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $FilePath @Arguments 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
        return @{ ExitCode = $code; Output = $out }
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Resolve-AndroidComponent {
    <#
      确保指定的 SDK 组件已安装，缺失则用 sdkmanager 自动补装。
      @returns $true 表示全部就绪
    #>
    param(
        [Parameter(Mandatory)][string]$Sdk,
        [Parameter(Mandatory)][string[]]$Packages,
        [string]$JdkPath
    )

    $missing = @()
    foreach ($pkg in $Packages) {
        # 包名形如 platforms;android-36 / build-tools;36.0.0
        $parts = $pkg -split ';'
        $rel = switch ($parts[0]) {
            'platforms'   { "platforms\$($parts[1])" }
            'build-tools' { "build-tools\$($parts[1])" }
            'platform-tools' { 'platform-tools' }
            default       { "$($parts[0])\$($parts[1])" }
        }
        if (-not (Test-Path (Join-Path $Sdk $rel))) { $missing += $pkg }
    }

    if ($missing.Count -eq 0) { return $true }

    $sdkmanager = Join-Path $Sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
    if (-not (Test-Path $sdkmanager)) {
        Write-Warning "缺少组件（$($missing -join ', ')），且找不到 sdkmanager，无法自动补装"
        return $false
    }

    Write-Host "    正在安装缺失组件：$($missing -join ', ')" -ForegroundColor Yellow
    if ($JdkPath) { $env:JAVA_HOME = $JdkPath }
    $r = Invoke-NativeCommand -FilePath $sdkmanager -Arguments (@('--sdk_root=' + $Sdk) + $missing)
    $r.Output | Select-Object -Last 3 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
    return ($r.ExitCode -eq 0)
}
