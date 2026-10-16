<#
.SYNOPSIS
    在 GitHub 创建私有仓库并推送本项目

.DESCRIPTION
    自动完成：校验凭据 → 创建私有仓库 → 推送 main 分支。

    关于凭据安全（本脚本的重点）：
      直接把 token 写进 remote URL 会把它留在 .git/config 里，属于常见泄露点。
      本脚本的做法是：推送时临时使用带 token 的地址，推送完成后立刻把 origin
      改回不含 token 的干净地址，并校验 .git/config 里没有残留。

.PARAMETER Token
    GitHub Personal Access Token（需 repo 权限）。
    不传则读取环境变量 GITHUB_TOKEN / GH_TOKEN。

.PARAMETER RepoName
    仓库名，默认 personal-media-vue

.PARAMETER Description
    仓库描述

.PARAMETER Public
    设为公开仓库。默认私有。

.EXAMPLE
    $env:GITHUB_TOKEN = 'ghp_xxx'
    powershell -ExecutionPolicy Bypass -File scripts\publish-github.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\publish-github.ps1 -Token 'ghp_xxx' -RepoName my-media
#>
[CmdletBinding()]
param(
    [string]$Token,
    [string]$RepoName = 'personal-media-vue',
    [string]$Description = '多源聚合影视播放前端（Vue3 + hls.js + Capacitor）',
    [switch]$Public
)

$ErrorActionPreference = 'Stop'

function Write-Step($m) { Write-Host "`n>>> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "    $m" -ForegroundColor Yellow }
function Write-Err($m)  { Write-Host "    $m" -ForegroundColor Red }

$root = Split-Path -Parent $PSScriptRoot

# ===========================================================================
# 1. 取凭据
# ===========================================================================
Write-Step '检查凭据'

if (-not $Token) {
    $Token = $env:GITHUB_TOKEN
    if (-not $Token) { $Token = $env:GH_TOKEN }
}

if (-not $Token) {
    Write-Err '未提供 GitHub Token'
    Write-Host ''
    Write-Host '  获取方式：https://github.com/settings/tokens' -ForegroundColor Yellow
    Write-Host '    1. Generate new token (classic)' -ForegroundColor Gray
    Write-Host '    2. 勾选 repo 权限（创建私有仓库 + 推送必需）' -ForegroundColor Gray
    Write-Host '    3. 生成后立即复制（页面刷新就看不到了）' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  然后二选一：' -ForegroundColor Yellow
    Write-Host '    $env:GITHUB_TOKEN = ''ghp_xxx''; powershell -File scripts\publish-github.ps1' -ForegroundColor White
    Write-Host '    powershell -File scripts\publish-github.ps1 -Token ''ghp_xxx''' -ForegroundColor White
    exit 1
}
Write-Ok "已取得 Token（长度 $($Token.Length)，不回显内容）"

$headers = @{
    'Authorization'        = "Bearer $Token"
    'Accept'               = 'application/vnd.github+json'
    'User-Agent'           = 'publish-github-script'
    'X-GitHub-Api-Version' = '2022-11-28'
}

# ===========================================================================
# 2. 校验 token 并取用户名
# ===========================================================================
Write-Step '校验凭据并获取账号信息'

try {
    $me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers -TimeoutSec 30
} catch {
    Write-Err '凭据无效或网络不可达'
    Write-Host "    $($_.Exception.Message)" -ForegroundColor Gray
    exit 1
}
$login = $me.login
Write-Ok "账号: $login"

# 检查 scope（classic token 才有这个头；fine-grained token 无此头但也能用）
try {
    $resp = Invoke-WebRequest -Uri 'https://api.github.com/user' -Headers $headers -TimeoutSec 20 -UseBasicParsing
    $scopes = $resp.Headers['X-OAuth-Scopes']
    if ($scopes) {
        Write-Ok "Token 权限: $scopes"
        if ("$scopes" -notmatch 'repo') {
            Write-Warn2 '警告：Token 缺少 repo 权限，可能无法创建私有仓库或推送'
        }
    } else {
        Write-Warn2 '未能读取权限列表（fine-grained token 属正常）'
    }
} catch { }

# ===========================================================================
# 3. 创建私有仓库
# ===========================================================================
Write-Step "创建仓库 $login/$RepoName"

$visibility = if ($Public) { $false } else { $true }
$payload = @{
    name        = $RepoName
    description = $Description
    private     = $visibility
    auto_init   = $false      # 本地已有提交，不要远端初始化以免冲突
    has_issues  = $true
    has_wiki    = $false
} | ConvertTo-Json

try {
    $repo = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post `
        -Headers $headers -Body $payload -ContentType 'application/json' -TimeoutSec 60
    Write-Ok "已创建: $($repo.html_url)"
    Write-Ok "可见性: $(if($repo.private){'私有'}else{'公开'})"
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 422) {
        Write-Warn2 "仓库 $RepoName 已存在，直接推送"
        $repo = Invoke-RestMethod -Uri "https://api.github.com/repos/$login/$RepoName" -Headers $headers -TimeoutSec 30
        Write-Ok "使用已有仓库: $($repo.html_url)"
    } else {
        Write-Err "创建仓库失败（HTTP $status）"
        Write-Host "    $($_.Exception.Message)" -ForegroundColor Gray
        exit 1
    }
}

$cleanUrl   = "https://github.com/$login/$RepoName.git"
$authUrl    = "https://$login`:$Token@github.com/$login/$RepoName.git"

# ===========================================================================
# 4. 配置 remote 并推送
# ===========================================================================
Push-Location $root
try {
    # 确保已初始化
    if (-not (Test-Path '.git')) {
        Write-Err '当前目录不是 git 仓库，请先执行 git init 并提交'
        exit 1
    }

    # 分支名
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    if ($branch -eq 'HEAD') { $branch = 'main' }

    # 提交数检查
    $commitCount = (git rev-list --count HEAD 2>$null)
    if (-not $commitCount -or [int]$commitCount -eq 0) {
        Write-Err '本地没有任何提交，请先 commit'
        exit 1
    }
    Write-Ok "本地分支 $branch，共 $commitCount 个提交"

    Write-Step '推送'

    # 先用干净地址设置 origin（避免 token 落进 .git/config）
    $existing = git remote 2>$null
    if ($existing -contains 'origin') {
        git remote set-url origin $cleanUrl
    } else {
        git remote add origin $cleanUrl
    }

    # 推送时临时用带 token 的地址：不写进任何配置文件
    $prevEA = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & git push $authUrl "$branch`:$branch" --set-upstream 2>&1 |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        $pushExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEA
    }

    if ($pushExit -ne 0) {
        Write-Err "推送失败（退出码 $pushExit）"
        Write-Host ''
        Write-Host '  常见原因：' -ForegroundColor Yellow
        Write-Host '    - Token 缺 repo 权限' -ForegroundColor Gray
        Write-Host '    - Token 已过期' -ForegroundColor Gray
        Write-Host '    - 网络问题（部分网络环境需代理访问 github.com）' -ForegroundColor Gray
        exit 1
    }
    Write-Ok '推送完成'

    # =======================================================================
    # 5. 清理与校验（关键：确认 token 没留在配置里）
    # =======================================================================
    Write-Step '校验凭据未残留'

    git remote set-url origin $cleanUrl

    $cfg = Get-Content '.git/config' -Raw
    if ($cfg -match [regex]::Escape($Token)) {
        Write-Err '.git/config 中发现 token，正在清理'
        git remote set-url origin $cleanUrl
        Write-Warn2 '已重置 remote，请确认 .git/config 内容'
    } else {
        Write-Ok '.git/config 中无 token 残留'
    }

    $remoteUrl = (git remote get-url origin).Trim()
    Write-Ok "origin = $remoteUrl"

    # 工作区的 .git 之外也不该有残留
    $leaked = Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\node_modules\\|\\\.git\\' } |
        Select-String -Pattern ([regex]::Escape($Token)) -List -ErrorAction SilentlyContinue
    if ($leaked) {
        Write-Warn2 '以下文件中发现 token 字符串（请检查）：'
        $leaked | ForEach-Object { Write-Host "      $($_.Path)" -ForegroundColor Yellow }
    } else {
        Write-Ok '工作区文件中无 token 残留'
    }

    # =======================================================================
    # 6. 完成
    # =======================================================================
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor Cyan
    Write-Host '  推送完成' -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor Cyan
    Write-Host ''
    Write-Host "  仓库地址: $($repo.html_url)" -ForegroundColor White
    Write-Host "  可见性:   $(if($repo.private){'私有（仅自己可见）'}else{'公开'})" -ForegroundColor White
    Write-Host ''
    Write-Host '  后续更新只需：' -ForegroundColor Cyan
    Write-Host '    git add -A; git commit -m "说明"; git push' -ForegroundColor White
    Write-Host ''
    Write-Host '  注意：今后推送仍需要凭据。可选：' -ForegroundColor Yellow
    Write-Host '    - 用 Windows 凭据管理器记住（首次 push 时输入，之后自动）' -ForegroundColor Gray
    Write-Host '    - 安装 gh CLI 并 gh auth login' -ForegroundColor Gray
    Write-Host '    - 配置 SSH key 后改用 git@github.com 地址' -ForegroundColor Gray
    Write-Host ''
} finally {
    Pop-Location
}
