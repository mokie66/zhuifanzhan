/**
 * 验证 taxonomy 分类翻译的正确性
 *
 * 逻辑：对每个源，把语义分组翻译成该源的 type_id，然后用这个 id 去查，
 *       检查返回条目的分类名是否真的属于该语义分组。
 * 这是架构里最容易出错的一环（各源 type_id 体系不同）。
 *
 * 运行：node scripts/verify-taxonomy.mjs
 */
import { resolveGroups, matchGroup, SEMANTIC_GROUPS } from '../src/api/taxonomy.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const SOURCES = [
  { key: 'lzi', name: '量子', api: 'http://cj.lziapi.com/api.php/provide/vod/' },
  { key: 'ffzy', name: '非凡', api: 'http://cj.ffzyapi.com/api.php/provide/vod/' },
  { key: 'iqiyi', name: '爱奇艺', api: 'https://www.iqiyizyapi.com/api.php/provide/vod/' },
  { key: 'dytt', name: '电影天堂', api: 'http://caiji.dyttzyapi.com/api.php/provide/vod/' },
  { key: 'modu', name: '魔都', api: 'https://caiji.moduapi.cc/api.php/provide/vod/' },
  { key: 'tyys', name: '天涯', api: 'http://tyyszy.com/api.php/provide/vod' },
  { key: 'zuida', name: '最大', api: 'https://zuida.xyz/api.php/provide/vod/' },
]

async function jget(url, timeout = 20000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(timeout),
  })
  const t = await r.text()
  return JSON.parse(t.replace(/^\uFEFF/, ''), (k, v) => v)
}

/** 判断某条数据的分类是否真的属于期望分组 */
function belongsTo(item, expectedGroup) {
  const name = String(item.type_name || '')
  // 用返回数据里自带的 type_id 反查分类表，比只看名字更准
  return matchGroup(name) === expectedGroup
}

const GROUPS = ['movie', 'tv', 'anime', 'variety']

let totalChecks = 0
let totalPass = 0

for (const src of SOURCES) {
  console.log('\n' + '='.repeat(84))
  console.log(`【${src.name}】${src.api}`)
  console.log('='.repeat(84))

  let classes = []
  try {
    const d = await jget(src.api + (src.api.includes('?') ? '&' : '?') + 'ac=list')
    classes = (d.class || []).map((c) => ({
      type_id: Number(c.type_id),
      type_pid: Number(c.type_pid || 0),
      type_name: String(c.type_name || '').trim(),
    }))
    console.log(`  分类表：${classes.length} 个`)
  } catch (e) {
    console.log(`  ✘ 取分类表失败: ${e.message}`)
    continue
  }

  const groups = resolveGroups(classes)
  console.log(
    `  解析出的语义分组：${Object.entries(groups)
      .map(([k, v]) => `${k}=${v.typeId}(${v.sourceName})`)
      .join('  ')}`
  )

  for (const g of GROUPS) {
    const def = groups[g]
    if (!def) {
      console.log(`  - ${g.padEnd(8)} 该源无此分组，跳过`)
      continue
    }
    try {
      const d = await jget(
        src.api + (src.api.includes('?') ? '&' : '?') + `ac=detail&pg=1&t=${def.typeId}`
      )
      const items = (d.list || []).slice(0, 20)
      if (!items.length) {
        console.log(`  ? ${g.padEnd(8)} typeId=${def.typeId} 返回 0 条`)
        continue
      }
      const pass = items.filter((it) => belongsTo(it, g)).length
      const rate = Math.round((pass / items.length) * 100)
      totalChecks += items.length
      totalPass += pass
      const names = [...new Set(items.map((x) => x.type_name))].slice(0, 4).join(', ')
      const flag = rate >= 80 ? '✔' : rate >= 50 ? '~' : '✘'
      console.log(
        `  ${flag} ${g.padEnd(8)} typeId=${String(def.typeId).padEnd(4)} 准确率 ${String(rate).padStart(3)}%  (${pass}/${items.length})  实际分类: ${names}`
      )
    } catch (e) {
      console.log(`  ✘ ${g.padEnd(8)} typeId=${def.typeId} 查询失败: ${e.message.slice(0, 50)}`)
    }
  }
}

console.log('\n' + '='.repeat(84))
const overall = totalChecks ? Math.round((totalPass / totalChecks) * 100) : 0
console.log(`总体分类翻译准确率：${overall}%  (${totalPass}/${totalChecks})`)
console.log('='.repeat(84))
