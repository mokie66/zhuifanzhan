/**
 * 首页冷启动耗时诊断
 * ====================
 * 目标：找出「每次进 App 首页都很慢」的真实原因，量化每个环节的耗时与请求数。
 *
 * 支持模拟「App 重启」：
 *   Node 里没有 localStorage，所以这里用文件做垫片。
 *   --store <file>   使用该文件作为 localStorage 的落盘位置
 *   --no-store       不用垫片（等价于首次安装，无任何持久化）
 *
 *   先跑一次 --store a.json（冷启动，写入缓存）
 *   再跑一次 --store a.json（模拟重启，应能秒开）
 *
 * 运行前先起 dev server：npm run dev
 * 运行：node --import ./scripts/register-loader.mjs scripts/diagnose-home-perf.mjs [--store f]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const storeIdx = argv.indexOf('--store')
const storeFile = storeIdx >= 0 ? argv[storeIdx + 1] : null
const noStore = argv.includes('--no-store')

/**
 * 最小 localStorage 垫片，落盘到文件。
 * 只实现项目用到的 getItem / setItem / removeItem / key / length。
 */
function installLocalStorage(file) {
  let data = {}
  if (file && existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      data = {}
    }
  }
  const flush = () => {
    if (file) writeFileSync(file, JSON.stringify(data))
  }
  const ls = {
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
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
}

if (!noStore) installLocalStorage(storeFile || 'F:/workspaceDeepseek/recon_y2s52n7/_ls-shim.json')

const DEV = 'http://localhost:5173'

const realFetch = globalThis.fetch
const reqs = []
let inFlight = 0
let maxInFlight = 0

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' && input.startsWith('/') ? DEV + input : String(input)
  const t0 = Date.now()
  inFlight++
  maxInFlight = Math.max(maxInFlight, inFlight)
  try {
    const res = await realFetch(url, init)
    const rec = { url, ms: Date.now() - t0, status: res.status }
    reqs.push(rec)
    return res
  } catch (e) {
    reqs.push({ url, ms: Date.now() - t0, status: 'ERR', err: e.message })
    throw e
  } finally {
    inFlight--
  }
}

globalThis.window = globalThis.window || undefined

const t0 = Date.now()
const { getHomeFeed } = await import('@/api/index.js')
const { cacheStats } = await import('@/api/cache.js')
const feed = await getHomeFeed()
const firstPaint = Date.now() - t0

// 记录「首屏返回时」已经发出了多少请求 —— 这个数字直接决定加载快慢
const reqsAtFirstPaint = reqs.length

// 若是 stale-while-revalidate 路径，后台刷新会继续跑，等一小会儿看最终态
let refreshed = null
if (reqsAtFirstPaint < reqs.length) {
  await new Promise((r) => setTimeout(r, 50))
}
const total = Date.now() - t0

const src = (u) => {
  try {
    const m = u.match(/\/collect\/([^?]+)\?(.*)$/)
    if (!m) return { key: '?', q: '' }
    return { key: m[1], q: m[2] }
  } catch {
    return { key: '?', q: '' }
  }
}

console.log('='.repeat(96))
console.log('首页耗时')
console.log('='.repeat(96))
console.log(`  首屏返回    : ${firstPaint} ms   ← 用户实际感知的等待时间`)
console.log(`  总耗时      : ${total} ms`)
console.log(`  日志落盘    : ${storeFile ? storeFile : noStore ? '（未启用）' : '默认位置'}`)
try {
  const st = cacheStats()
  console.log(`  缓存规模    : 内存 ${st.memory} 项，落盘 ${st.persisted} 项（${Math.round(st.bytes / 1024)} KB）`)
} catch {
  /* 忽略 */
}
console.log(`  请求数      : ${reqs.length}（首屏返回时已发出 ${reqsAtFirstPaint}）`)
console.log(`  峰值并发    : ${maxInFlight}`)
console.log()

// 按类型归类
const byAc = {}
for (const r of reqs) {
  const { q } = src(r.url)
  const ac = (q.match(/ac=(\w+)/) || [, 'none'])[1]
  const isList = ac === 'list'
  const k = isList ? 'ac=list（分类表）' : `ac=${ac}（数据）`
  byAc[k] = byAc[k] || { n: 0, ms: 0, max: 0 }
  byAc[k].n++
  byAc[k].ms += r.ms
  byAc[k].max = Math.max(byAc[k].max, r.ms)
}
console.log('  按接口类型:')
for (const [k, v] of Object.entries(byAc)) {
  console.log(`    ${k.padEnd(24)} ${String(v.n).padStart(3)} 次  总 ${String(v.ms).padStart(6)} ms  最慢 ${String(v.max).padStart(5)} ms  均 ${String(Math.round(v.ms / v.n)).padStart(5)} ms`)
}
console.log()

// 按源归类
const bySrc = {}
for (const r of reqs) {
  const { key, q } = src(r.url)
  const ac = (q.match(/ac=(\w+)/) || [, 'none'])[1]
  bySrc[key] = bySrc[key] || { list: 0, data: 0, ms: 0, max: 0 }
  if (ac === 'list') bySrc[key].list++
  else bySrc[key].data++
  bySrc[key].ms += r.ms
  bySrc[key].max = Math.max(bySrc[key].max, r.ms)
}
console.log('  按源:')
const sorted = Object.entries(bySrc).sort((a, b) => b[1].ms - a[1].ms)
for (const [k, v] of sorted) {
  console.log(`    ${k.padEnd(8)} 分类表 ${v.list} 次 + 数据 ${String(v.data).padStart(2)} 次 = ${String(v.list + v.data).padStart(2)} 次   累计 ${String(v.ms).padStart(6)} ms   最慢 ${String(v.max).padStart(5)} ms`)
}
console.log()

// 最慢的请求
console.log('  最慢的 10 个请求:')
;[...reqs].sort((a, b) => b.ms - a.ms).slice(0, 10).forEach((r, i) => {
  const { key, q } = src(r.url)
  console.log(`    ${String(i + 1).padStart(2)}. ${String(r.ms).padStart(6)} ms  ${key.padEnd(8)} ${q.slice(0, 40)}`)
})
console.log()

// 超时/失败
const bad = reqs.filter((r) => r.status !== 200)
console.log(`  非 200 响应: ${bad.length} 个`)
bad.slice(0, 8).forEach((r) => {
  const { key, q } = src(r.url)
  console.log(`    ${key.padEnd(8)} HTTP ${r.status}  ${q.slice(0, 40)}`)
})
console.log()

console.log('='.repeat(96))
console.log('结果概览')
console.log('='.repeat(96))
console.log(`  动漫 ${feed.latestAnime.length} 部 | 电视剧 ${feed.latestTv.length} 部 | 电影 ${feed.latestMovie.length} 部 | 导航 ${feed.categories.length} 项`)
console.log()

// 串行 vs 理论最优
const sumMs = reqs.reduce((a, r) => a + r.ms, 0)
console.log(`  所有请求耗时之和 : ${sumMs} ms`)
console.log(`  实际墙钟         : ${total} ms`)
console.log(`  并发效率         : ${(sumMs / total).toFixed(1)}x（越接近峰值并发越说明并发充分）`)
console.log(`  理论最优（按源内串行、源间并行）: 约 ${Math.round(Math.max(...Object.values(bySrc).map((v) => v.ms)))} ms`)
