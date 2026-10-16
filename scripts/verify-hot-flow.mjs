/**
 * 验证「热门榜」完整流程
 * ========================
 * 覆盖三个关键场景：
 *   1. 首次启动：短预算先出结果（可能退化）+ 后台长预算升级
 *   2. 二次启动：缓存命中，秒开
 *   3. 专门的榜单页（/anime、/tv）：长预算直接取优质结果
 *
 * 运行前先起 dev server：npm run dev
 * 运行：node --import ./scripts/register-loader.mjs scripts/verify-hot-flow.mjs [--fresh]
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'

const STORE = 'F:/workspaceDeepseek/recon_y2s52n7/_hot-shim.json'
if (process.argv.includes('--fresh')) rmSync(STORE, { force: true })

let data = {}
if (existsSync(STORE)) {
  try {
    data = JSON.parse(readFileSync(STORE, 'utf8'))
  } catch {
    data = {}
  }
}
const flush = () => writeFileSync(STORE, JSON.stringify(data))
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v)
      flush()
    },
    removeItem: (k) => {
      delete data[k]
      flush()
    },
    key: (i) => Object.keys(data)[i] ?? null,
    get length() {
      return Object.keys(data).length
    },
    clear: () => {
      data = {}
      flush()
    },
  },
  configurable: true,
  writable: true,
})

const DEV = 'http://localhost:5173'
const rf = globalThis.fetch
let reqCount = 0
globalThis.fetch = (i, o) => {
  reqCount++
  return rf(typeof i === 'string' && i.startsWith('/') ? DEV + i : i, o)
}
globalThis.window = globalThis.window || undefined

const { getHomeFeed, getHotList } = await import('@/api/index.js')

const show = (label, list) => {
  const withHits = list.filter((v) => (Number(v.hits) || 0) > 0).length
  console.log(
    `  ${label.padEnd(22)} ${String(list.length).padStart(2)} 部，其中 ${withHits} 部有播放量数据`
  )
  list.slice(0, 6).forEach((v, i) => {
    console.log(
      `      ${String(i + 1).padStart(2)}. hits=${String(Number(v.hits) || 0).padStart(7)} 《${v.title}》`
    )
  })
}

console.log('='.repeat(88))
console.log('阶段 1：首次启动（短预算出结果）')
console.log('='.repeat(88))
let t0 = Date.now()
let upgraded = null
const first = await getHomeFeed({ onRefresh: (fresh) => (upgraded = fresh) })
const firstMs = Date.now() - t0
console.log(`  首屏耗时 ${firstMs} ms，请求 ${reqCount} 次`)
show('热门国漫', first.hotAnime || [])
show('热门电视剧', first.hotTv || [])
const firstWeak =
  !(first.hotAnime || []).some((v) => Number(v.hits) > 0) ||
  !(first.hotTv || []).some((v) => Number(v.hits) > 0)
console.log(`  首屏是否退化（无播放量数据）: ${firstWeak ? '是（预期内，会后台升级）' : '否'}`)

console.log()
console.log('='.repeat(88))
console.log('阶段 2：等后台升级（长预算重取热门榜）')
console.log('='.repeat(88))
if (firstWeak) {
  t0 = Date.now()
  await new Promise((r) => setTimeout(r, 16000))
  console.log(`  等待 ${Date.now() - t0} ms`)
  if (upgraded) {
    show('升级后·热门国漫', upgraded.hotAnime || [])
    show('升级后·热门电视剧', upgraded.hotTv || [])
    const okNow = (upgraded.hotAnime || []).some((v) => Number(v.hits) > 0)
    console.log(`  升级是否拿到播放量数据: ${okNow ? '✔ 是' : '✘ 否'}`)
  } else {
    console.log('  ⚠ 未收到升级回调（可能所有源都超时了）')
  }
} else {
  console.log('  首屏已有优质数据，无需升级')
}

console.log()
console.log('='.repeat(88))
console.log('阶段 3：二次启动（缓存命中，应秒开）')
console.log('='.repeat(88))
reqCount = 0
t0 = Date.now()
const second = await getHomeFeed()
const secondMs = Date.now() - t0
console.log(`  耗时 ${secondMs} ms，请求 ${reqCount} 次`)
show('热门国漫', second.hotAnime || [])
console.log(
  `  判定: ${secondMs < 300 && reqCount === 0 ? '✔ 命中缓存，零请求秒开' : '⚠ 未完全命中缓存'}`
)

console.log()
console.log('='.repeat(88))
console.log('阶段 4：专门榜单页（/anime 12 部，长预算）')
console.log('='.repeat(88))
t0 = Date.now()
const page12 = await getHotList('anime', { limit: 12 })
console.log(`  耗时 ${Date.now() - t0} ms`)
show('榜单页·热门国漫', page12)
