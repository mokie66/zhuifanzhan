/**
 * 通过 GitHub REST API 推送提交（git 协议被阻断时的替代方案）
 * ==================================================================
 * 什么时候需要它
 * --------------
 * 部分网络环境（如国内某些运营商）会针对性阻断 github.com:443 的 git 协议，
 * 表现为 `git push` 报 `Recv failure: Connection was reset` 或
 * `Failed to connect to github.com port 443`。
 * 但 api.github.com 通常仍然可达 —— 本脚本就走 API 完成推送。
 *
 * 原理
 * ----
 * 用 Git Data API 逐个重建提交：
 *   1. 对每个待推送提交，取出相对父提交的变更文件
 *   2. POST /git/blobs      上传文件内容（GitHub 按内容算出的 blob SHA 与本地一致）
 *   3. POST /git/trees      以父提交的 tree 为 base，构造新 tree
 *   4. POST /git/commits    带上完整的 author/committer 元数据与提交信息
 *   5. PATCH /git/refs/heads/<branch>  移动分支指针
 *
 * 因为 git 的 SHA 完全由内容与元数据决定，重建出来的提交 SHA 与本地相同，
 * 所以推送后历史不会分叉，`git fetch` 也不会产生多余的 merge。
 *
 * 用法
 * ----
 *   node scripts/push-via-api.mjs --token <TOKEN>
 *   GITHUB_TOKEN=xxx node scripts/push-via-api.mjs --remote origin --branch main
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const API = 'https://api.github.com'

function parseArgs(argv) {
  const out = { remote: 'origin', branch: 'main', dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--token' || a === '-t') out.token = argv[++i]
    else if (a === '--remote') out.remote = argv[++i]
    else if (a === '--branch') out.branch = argv[++i]
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--force') out.force = true
    else if (a === '--base') out.base = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv)
if (args.help) {
  console.log(`用法: node scripts/push-via-api.mjs --token <TOKEN> [--remote origin] [--branch main] [--dry-run]`)
  process.exit(0)
}

const token = args.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN
if (!token) {
  console.error('缺少 token。用 --token <TOKEN> 或设置 GITHUB_TOKEN 环境变量。')
  process.exit(1)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * git 调用统一带上 core.quotepath=false
 *
 * 不加这个的话，git 会对非 ASCII 路径加引号并转义成八进制字面量：
 *   "docs/\345\256\236\347\216\260\350\257\264\346\230\216.md"
 * 这种路径拿去 `git cat-file blob <sha>:<path>` 是找不到文件的
 * （实测踩过：中文文件名推送直接失败，纯 ASCII 的文件名则一直正常）。
 */
const GIT_FLAGS = ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=utf-8']

const git = (...a) => execFileSync('git', [...GIT_FLAGS, ...a], { cwd: root, encoding: 'utf8' }).trim()
/** 不裁剪输出：提交信息、文件内容必须逐字节保留，否则 SHA 会不同 */
const gitRaw = (...a) =>
  execFileSync('git', [...GIT_FLAGS, ...a], { cwd: root, encoding: 'utf8' })
const gitBuf = (...a) =>
  execFileSync('git', [...GIT_FLAGS, ...a], { cwd: root, maxBuffer: 512 * 1024 * 1024 })

/**
 * 精确读取提交对象
 *
 * 为什么不用 `git log --format=%B`：
 *   1. 它有结尾换行，容易被 trim 掉 —— 提交信息少一个 \n，SHA 就不同了
 *      （实测踩过：blob/tree 全部一致，只有 commit SHA 不一致）
 *   2. 它不暴露时区，而时区参与 commit 对象的哈希计算
 * 直接读 `git cat-file commit` 拿到原始对象最可靠。
 */
function readCommit(sha) {
  const raw = gitRaw('cat-file', 'commit', sha)
  const sep = raw.indexOf('\n\n')
  const header = raw.slice(0, sep)
  const message = raw.slice(sep + 2) // 逐字节保留，含结尾换行
  const lines = header.split('\n')

  const tree = lines.find((l) => l.startsWith('tree '))?.slice(5)
  const parents = lines.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7))

  const parseIdent = (prefix) => {
    const line = lines.find((l) => l.startsWith(prefix + ' '))
    if (!line) return null
    // 形如: author 张三 <a@b.c> 1700000000 +0800
    const m = line.match(/^\S+\s(.*)\s<([^>]*)>\s(\d+)\s([+-]\d{4})$/)
    if (!m) return null
    return { name: m[1], email: m[2], ts: Number(m[3]), tz: m[4] }
  }

  return {
    tree,
    parents,
    message,
    author: parseIdent('author'),
    committer: parseIdent('committer'),
    subject: message.split('\n')[0],
  }
}

/**
 * 把 git 的 `<时间戳> <±HHMM>` 转成带偏移的 ISO 8601
 * 必须保留原时区：commit 对象里存的就是本地时间+偏移，
 * 若转成 UTC（Z）会导致哈希不同。
 */
function toIso(ts, tz) {
  const sign = tz[0] === '-' ? -1 : 1
  const offMin = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)))
  const local = new Date((ts + offMin * 60) * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}` +
    `${tz.slice(0, 3)}:${tz.slice(3)}`
  )
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'push-via-api',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const msg = json?.message || text.slice(0, 200)
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${msg}`)
  }
  return json
}

/** 从 remote URL 解析 owner/repo */
function parseRepo(url) {
  const m = String(url).match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/)
  if (!m) throw new Error(`无法从 remote URL 解析 owner/repo: ${url}`)
  return { owner: m[1], repo: m[2] }
}

async function main() {
  const remoteUrl = git('remote', 'get-url', args.remote)
  const { owner, repo } = parseRepo(remoteUrl)
  console.log(`仓库: ${owner}/${repo}`)
  console.log(`分支: ${args.branch}`)
  console.log()

  // 远端当前指向
  const refPath = `/repos/${owner}/${repo}/git/ref/heads/${args.branch}`
  let remoteSha
  try {
    const ref = await api('GET', refPath)
    remoteSha = ref.object.sha
    console.log(`远端 ${args.branch} = ${remoteSha.slice(0, 7)}`)
  } catch (e) {
    if (String(e.message).includes('404')) {
      console.log(`远端分支 ${args.branch} 不存在，将从零开始创建`)
      remoteSha = null
    } else throw e
  }

  // 待推送的提交（旧的在前）
  // 先确认远端提交在本地存在：若不存在（例如别处推送过、或本地被重置过），
  // git 无法算出差集，直接报 git 的原始错误会让人摸不着头脑。
  if (remoteSha) {
    let known = true
    try {
      git('cat-file', '-e', `${remoteSha}^{commit}`)
    } catch {
      known = false
    }
    if (!known) {
      console.error(`\n✘ 远端提交 ${remoteSha.slice(0, 7)} 在本地不存在。`)
      console.error('  git 无法计算差集。可选处理：')
      console.error('    1) 先 git fetch 取回远端历史（需要 git 协议可用）')
      console.error('    2) 若确认要以本地覆盖远端，先手动把远端分支指回共同祖先：')
      console.error(`         PATCH /repos/${owner}/${repo}/git/refs/heads/${args.branch}  {sha: <共同祖先>, force: true}`)
      console.error('    3) 或指定 --base <sha> 显式告诉脚本从哪里开始推送')
      if (args.base) {
        console.log(`\n  使用 --base ${args.base}`)
      } else {
        process.exit(1)
      }
    }
  }

  const baseSha = args.base || remoteSha
  const range = baseSha ? `${baseSha}..HEAD` : 'HEAD'
  const commits = git('log', '--reverse', '--format=%H', range)
    .split('\n')
    .filter(Boolean)

  if (!commits.length) {
    console.log('\n没有需要推送的提交，已是最新。')
    return
  }
  console.log(`待推送提交: ${commits.length} 个`)
  commits.forEach((c) => console.log(`  ${c.slice(0, 7)}  ${git('log', '-1', '--format=%s', c)}`))
  console.log()

  if (args.dryRun) {
    console.log('（--dry-run，未实际推送）')
    return
  }

  // 远端父提交的 tree 作为 base
  let baseTree = null
  let parentSha = remoteSha
  if (remoteSha) {
    const c = await api('GET', `/repos/${owner}/${repo}/git/commits/${remoteSha}`)
    baseTree = c.tree.sha
    console.log(`远端 base tree = ${baseTree.slice(0, 7)}`)
  }

  for (const sha of commits) {
    const meta = readCommit(sha)
    console.log(`\n>>> 重建提交 ${sha.slice(0, 7)}  ${meta.subject}`)

    // 变更文件（相对父提交）
    const parentShaForDiff = meta.parents[0] || null
    const changed = parentShaForDiff
      ? git('diff-tree', '-r', '--name-status', '--no-commit-id', parentShaForDiff, sha)
          .split('\n')
          .filter(Boolean)
      : git('ls-tree', '-r', '--name-only', sha).split('\n').filter(Boolean).map((p) => `A\t${p}`)

    const entries = []
    for (const line of changed) {
      const parts = line.split('\t')
      const status = parts[0][0]
      const path = parts[parts.length - 1]

      if (status === 'D') {
        entries.push({ path, mode: '100644', type: 'blob', sha: null })
        console.log(`    删除 ${path}`)
        continue
      }

      const content = gitBuf('cat-file', 'blob', `${sha}:${path}`)
      const blob = await api('POST', `/repos/${owner}/${repo}/git/blobs`, {
        content: content.toString('base64'),
        encoding: 'base64',
      })
      // 校验：GitHub 算出的 blob SHA 应与本地一致
      const localBlob = git('rev-parse', `${sha}:${path}`)
      const same = blob.sha === localBlob
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
      console.log(
        `    ${status === 'A' ? '新增' : '修改'} ${path}  blob=${blob.sha.slice(0, 7)}${same ? ' ✔一致' : ' ⚠与本地不一致'}`
      )
    }

    // 构造 tree
    const treeBody = { tree: entries }
    if (baseTree) treeBody.base_tree = baseTree
    const tree = await api('POST', `/repos/${owner}/${repo}/git/trees`, treeBody)
    const treeMatch = tree.sha === meta.tree
    console.log(`    tree = ${tree.sha.slice(0, 7)}${treeMatch ? ' ✔与本地一致' : ` ⚠与本地不一致（本地 ${meta.tree.slice(0, 7)}）`}`)

    // 构造 commit（带完整元数据与原始时区，以求 SHA 与本地一致）
    const commit = await api('POST', `/repos/${owner}/${repo}/git/commits`, {
      message: meta.message,
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
      author: {
        name: meta.author.name,
        email: meta.author.email,
        date: toIso(meta.author.ts, meta.author.tz),
      },
      committer: {
        name: meta.committer.name,
        email: meta.committer.email,
        date: toIso(meta.committer.ts, meta.committer.tz),
      },
    })
    const shaMatch = commit.sha === sha
    console.log(`    commit = ${commit.sha.slice(0, 7)}${shaMatch ? ' ✔与本地 SHA 一致' : ` ⚠与本地不同（本地 ${sha.slice(0, 7)}）`}`)

    baseTree = tree.sha
    parentSha = commit.sha
  }

  // 移动分支指针
  console.log(`\n>>> 更新分支指针 ${args.branch}`)
  if (remoteSha) {
    await api('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${args.branch}`, {
      sha: parentSha,
      force: !!args.force,
    })
  } else {
    await api('POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${args.branch}`,
      sha: parentSha,
    })
  }
  console.log(`    已更新为 ${parentSha}`)

  const localHead = git('rev-parse', 'HEAD')
  console.log()
  if (parentSha === localHead) {
    console.log('✔ 完成：远端 HEAD 与本地 HEAD 完全一致，历史未分叉')
  } else {
    console.log(`⚠ 完成，但远端 ${parentSha.slice(0, 7)} 与本地 ${localHead.slice(0, 7)} 不同。`)
    console.log('  内容一致但 SHA 不同，后续可执行 `git fetch && git reset --hard origin/main` 对齐。')
  }
}

main().catch((e) => {
  console.error('\n✘ 失败:', e.message)
  process.exit(1)
})
