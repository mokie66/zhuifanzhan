/**
 * 验证修正后的查询策略（通过 dev 代理，同时验证代理与策略）
 *
 * 策略 A：不带 t 拉取 + 客户端按分组过滤（首页/最新用）
 * 策略 B：子分类 id 轮转分页（分类浏览用）
 *
 * 运行前先起 dev server：npm run dev
 * 运行：node scripts/verify-strategy.mjs
 */
import { resolveGroups } from '../src/api/taxonomy.js'

const BASE = 'http://localhost:5173/collect'

const SOURCES = [
  { key: 'lzi', name: '量子' },
  { key: 'ffzy', name: '非凡' },
  { key: 'iqiyi', name: '爱奇艺' },
  { key: 'dytt', name: '电影天堂' },
  { key: 'modu', name: '魔都' },
  { key: 'tyys', name: '天涯' },
  { key: 'zuida', name: '最大' },
]

async function jget(url, timeout = 25000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  const t = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 80)}`)
  if (t.trimStart().startsWith('<')) throw new Error('返回 HTML 而非 JSON')
  return JSON.parse(t.replace(/^\uFEFF/, ''))
}

// 注意字段名必须与 taxonomy.resolveGroups 期望的一致（type_id/type_pid/type_name），
// 否则会静默解析不出任何分组。
const norm = (c) => ({
  type_id: Number(c.type_id),
  type_pid: Number(c.type_pid || 0),
  type_name: String(c.type_name || '').trim(),
})

const GROUPS = ['movie', 'tv', 'anime']

console.log('='.repeat(92))
console.log('策略 A：不带 t 拉取 + 客户端按分组过滤（首页/最新）')
console.log('='.repeat(92))

for (const src of SOURCES) {
  let classes = []
  try {
    const d = await jget(`${BASE}/${src.key}?ac=list`)
    classes = (d.class || []).map(norm)
  } catch (e) {
    console.log(`\n【${src.name}】✘ 分类表失败: ${e.message.slice(0, 60)}`)
    continue
  }
  console.log(`\n【${src.name}】分类表 ${classes.length} 个`)

  for (const g of GROUPS) {
    const groups = resolveGroups(classes)
    const def = groups[g]
    if (!def) {
      console.log(`  - ${g.padEnd(7)} 无此分组`)
      continue
    }
    const idSet = new Set([def.typeId, ...(def.children || [])])
    try {
      const d = await jget(`${BASE}/${src.key}?ac=detail&pg=1`) // 不带 t
      const items = d.list || []
      // 分页拉 2 页，过滤
      let got = items.filter((x) => idSet.has(Number(x.type_id)))
      if (got.length < 4) {
        const d2 = await jget(`${BASE}/${src.key}?ac=detail&pg=2`)
        got = got.concat((d2.list || []).filter((x) => idSet.has(Number(x.type_id))))
      }
      const rate = items.length ? Math.round((items.filter((x) => idSet.has(Number(x.type_id))).length / items.length) * 100) : 0
      const flag = got.length >= 4 ? '✔' : got.length > 0 ? '~' : '✘'
      const titles = got.slice(0, 3).map((x) => x.vod_name).join(' / ')
      console.log(
        `  ${flag} ${g.padEnd(7)} 过滤后 ${String(got.length).padStart(2)} 条 (第1页命中率 ${String(rate).padStart(3)}%)  ${titles}`
      )
    } catch (e) {
      console.log(`  ✘ ${g.padEnd(7)} 失败: ${e.message.slice(0, 60)}`)
    }
  }
}

console.log('\n' + '='.repeat(92))
console.log('策略 B：子分类 id 轮转分页（分类浏览）')
console.log('='.repeat(92))

for (const src of SOURCES) {
  let classes = []
  try {
    const d = await jget(`${BASE}/${src.key}?ac=list`)
    classes = (d.class || []).map(norm)
  } catch (e) {
    console.log(`\n【${src.name}】✘ ${e.message.slice(0, 50)}`)
    continue
  }
  const groups = resolveGroups(classes)
  console.log(`\n【${src.name}】`)
  for (const g of GROUPS) {
    const def = groups[g]
    if (!def) continue
    const children = [...new Set(def.children || [])]
    if (!children.length) {
      console.log(`  - ${g.padEnd(7)} 无子分类，只能用顶级 ${def.typeId}（多数源为空）`)
      continue
    }
    // 模拟第 1、2、3 页的规划
    const out = []
    for (const page of [1, 2, 3]) {
      const idx = (page - 1) % children.length
      const subPage = Math.floor((page - 1) / children.length) + 1
      const tid = children[idx]
      try {
        const d = await jget(`${BASE}/${src.key}?ac=detail&pg=${subPage}&t=${tid}`)
        const n = (d.list || []).length
        const nm = classes.find((c) => c.type_id === tid)?.name || '?'
        out.push(`P${page}→t=${tid}(${nm})/pg${subPage}:${n}条`)
      } catch (e) {
        out.push(`P${page}→t=${tid}:ERR`)
      }
    }
    const allOk = out.every((o) => !o.includes('ERR') && !o.endsWith(':0条'))
    console.log(`  ${allOk ? '✔' : '~'} ${g.padEnd(7)} ${out.join('   ')}`)
  }
}

console.log('\n' + '='.repeat(92))
console.log('搜索验证')
console.log('='.repeat(92))
for (const src of SOURCES) {
  try {
    const d = await jget(`${BASE}/${src.key}?ac=detail&pg=1&wd=${encodeURIComponent('神')}`)
    const items = d.list || []
    const withPlay = items.filter((x) => x.vod_play_url).length
    const m3u8 = items.filter((x) => /\.m3u8/i.test(x.vod_play_url || '')).length
    console.log(
      `  ${items.length ? '✔' : '✘'} ${src.name.padEnd(8)} 返回 ${String(items.length).padStart(2)} 条  含播放地址 ${withPlay}  含m3u8 ${m3u8}   ${items[0]?.vod_name || ''}`
    )
  } catch (e) {
    console.log(`  ✘ ${src.name.padEnd(8)} ${e.message.slice(0, 60)}`)
  }
}
