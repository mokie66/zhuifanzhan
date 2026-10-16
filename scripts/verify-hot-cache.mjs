/**
 * 验证「首页与榜单页共用热门榜缓存」
 * =====================================
 * 用户诉求：首页加载完后把底部导航（电视剧 / 动漫）的数据备好，
 * 这样用户点过去体验更好。
 *
 * 关键点：热门榜原来按 `hot:<分组>:<条数>` 缓存，首页要 6 条、榜单页要 12 条，
 * 键不同 → 互不复用 → 点底部导航要重新拉一次（最长 11 秒）。
 * 现在改成「一个分组一份池子」（hot:<分组>），两边共享。
 *
 * 运行：node --import ./scripts/register-loader.mjs scripts/verify-hot-cache.mjs
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'

const STORE = 'F:/workspaceDeepseek/recon_y2s52n7/_uni-shim.json'
rmSync(STORE, { force: true })

let data = {}
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

let pass = 0
let fail = 0
const log = (ok, label, extra = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${extra ? '  ' + extra : ''}`)
  ok ? pass++ : fail++
}

console.log('='.repeat(84))
console.log('冷启动：首页取数')
console.log('='.repeat(84))
reqCount = 0
let t0 = Date.now()
const feed = await getHomeFeed()
console.log(`  首页 ${Date.now() - t0} ms，请求 ${reqCount} 次`)
console.log(`  热门国漫 ${feed.hotAnime.length} 部 / 热门电视剧 ${feed.hotTv.length} 部`)

console.log()
console.log('='.repeat(84))
console.log('等预热完成（首页加载完后后台补齐榜单页数据）')
console.log('='.repeat(84))
await new Promise((r) => setTimeout(r, 3000))

console.log()
console.log('='.repeat(84))
console.log('用户点底部导航「动漫」/「电视剧」——应为零请求瞬开')
console.log('='.repeat(84))

reqCount = 0
t0 = Date.now()
const anime12 = await getHotList('anime', { limit: 12 })
const animeMs = Date.now() - t0
console.log(`  点「动漫」  ${animeMs} ms，请求 ${reqCount} 次，拿到 ${anime12.length} 部`)

reqCount = 0
t0 = Date.now()
const tv12 = await getHotList('tv', { limit: 12 })
const tvMs = Date.now() - t0
console.log(`  点「电视剧」${tvMs} ms，请求 ${reqCount} 次，拿到 ${tv12.length} 部`)

console.log()
console.log('='.repeat(84))
log(anime12.length === 12, '「动漫」页拿到 12 部（首页只用了 6 部，池子够用）')
log(tv12.length === 12, '「电视剧」页拿到 12 部')
log(animeMs < 200, '「动漫」页瞬开（< 200ms）', `${animeMs} ms`)
log(tvMs < 200, '「电视剧」页瞬开（< 200ms）', `${tvMs} ms`)

const hotKeys = Object.keys(data).filter((k) => k.startsWith('pmv:cache:hot:'))
console.log()
console.log(`  热门榜缓存键: ${hotKeys.map((k) => k.replace('pmv:cache:', '')).join(', ')}`)
log(
  hotKeys.length === 2 && hotKeys.every((k) => !/:\d+$/.test(k)),
  '缓存键按分组聚合（不带条数），首页与榜单页共用同一份'
)

// 首页的 6 部应当是榜单页 12 部的前缀（同一份数据切片）
const samePrefix = feed.hotAnime.every((v, i) => anime12[i] && v.title === anime12[i].title)
log(samePrefix, '首页 6 部与榜单页前 6 部一致（同一池子切片，不会出现内容跳变）')

console.log()
console.log('='.repeat(84))
console.log(`结果：通过 ${pass}  失败 ${fail}`)
console.log('='.repeat(84))
process.exit(fail > 0 ? 1 : 0)
