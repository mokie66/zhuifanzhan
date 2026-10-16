/**
 * 诊断：热度相关字段的可用性
 * ==========================
 * 用户反馈「显示的都是没人看的资源」。要按热度排序，先得确认数据源里
 * 到底有没有可用的热度信号：
 *   vod_hits         播放量/点击数（MacCMS 原生字段）
 *   vod_score        评分
 *   vod_douban_score 豆瓣评分
 * 另外测试接口是否支持排序参数（by/order），若有则可由服务端排序。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'

const SOURCES = [
  ['量子', 'http://cj.lziapi.com/api.php/provide/vod/'],
  ['非凡', 'http://cj.ffzyapi.com/api.php/provide/vod/'],
  ['爱奇艺', 'https://www.iqiyizyapi.com/api.php/provide/vod/'],
  ['电影天堂', 'http://caiji.dyttzyapi.com/api.php/provide/vod/'],
  ['魔都', 'https://caiji.moduapi.cc/api.php/provide/vod/'],
]

async function jget(u, timeout = 25000) {
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) })
  const t = await r.text()
  if (t.trimStart().startsWith('<')) throw new Error('返回 HTML')
  return JSON.parse(t.replace(/^\uFEFF/, ''), (k, v) => v)
}

function stats(nums) {
  const valid = nums.filter((n) => Number.isFinite(n) && n > 0)
  if (!valid.length) return { n: 0, max: 0, median: 0 }
  valid.sort((a, b) => a - b)
  return {
    n: valid.length,
    max: valid[0] === undefined ? 0 : valid[valid.length - 1],
    median: valid[Math.floor(valid.length / 2)],
  }
}

console.log('='.repeat(92))
console.log('一、热度字段的填充情况（每源抽样 40 条）')
console.log('='.repeat(92))

for (const [name, api] of SOURCES) {
  try {
    const d = await jget(api + (api.includes('?') ? '&' : '?') + 'ac=detail&pg=1')
    let list = d.list || []
    if (list.length < 40) {
      const d2 = await jget(api + (api.includes('?') ? '&' : '?') + 'ac=detail&pg=2')
      list = list.concat(d2.list || [])
    }
    list = list.slice(0, 40)
    if (!list.length) { console.log(`\n【${name}】无数据`); continue }

    const hits = list.map((v) => Number(v.vod_hits) || 0)
    const score = list.map((v) => Number(v.vod_score) || 0)
    const db = list.map((v) => Number(v.vod_douban_score) || 0)

    const hN = hits.filter((x) => x > 0).length
    const sN = score.filter((x) => x > 0).length
    const dN = db.filter((x) => x > 0).length

    console.log(`\n【${name}】样本 ${list.length} 条`)
    console.log(`  vod_hits         非零 ${String(hN).padStart(2)}/${list.length}  ${hN ? JSON.stringify(stats(hits)) : ''}`)
    console.log(`  vod_score        非零 ${String(sN).padStart(2)}/${list.length}  ${sN ? JSON.stringify(stats(score)) : ''}`)
    console.log(`  vod_douban_score 非零 ${String(dN).padStart(2)}/${list.length}  ${dN ? JSON.stringify(stats(db)) : ''}`)

    // 展示 hits 最高的 3 条与最低的 3 条，看差异是否明显
    if (hN > 3) {
      const sorted = [...list].sort((a, b) => (Number(b.vod_hits) || 0) - (Number(a.vod_hits) || 0))
      console.log('  hits 最高 3 条:')
      sorted.slice(0, 3).forEach((v) => console.log(`     ${String(v.vod_hits).padStart(9)}  《${v.vod_name}》 score=${v.vod_score || '-'}`))
      console.log('  hits 最低 3 条:')
      sorted.slice(-3).forEach((v) => console.log(`     ${String(v.vod_hits).padStart(9)}  《${v.vod_name}》 score=${v.vod_score || '-'}`))
    }
  } catch (e) {
    console.log(`\n【${name}】失败: ${e.message.slice(0, 60)}`)
  }
}

console.log('\n' + '='.repeat(92))
console.log('二、接口是否支持排序参数（by / order）')
console.log('='.repeat(92))
const base = 'http://cj.lziapi.com/api.php/provide/vod/'
const tryParams = [
  ['默认（无排序参数）', ''],
  ['by=hits', '&by=hits'],
  ['by=hits&order=desc', '&by=hits&order=desc'],
  ['order=vod_hits desc', '&order=vod_hits%20desc'],
  ['sort=hits', '&sort=hits'],
]
for (const [label, qs] of tryParams) {
  try {
    const d = await jget(`${base}?ac=detail&pg=1${qs}`)
    const list = d.list || []
    const first5 = list.slice(0, 5).map((v) => Number(v.vod_hits) || 0)
    const ascending = first5.every((x, i) => i === 0 || x <= first5[i - 1] + 1e-9)
    const descending = first5.every((x, i) => i === 0 || x >= first5[i - 1] - 1e-9)
    console.log(`  ${label.padEnd(24)} 条数=${String(list.length).padStart(2)}  前5条hits=[${first5.join(', ')}]  ${descending ? '看起来已按降序' : ascending ? '看起来按升序' : '无明显排序'}`)
    console.log(`      首条: 《${list[0]?.vod_name || '-'}》`)
  } catch (e) {
    console.log(`  ${label.padEnd(24)} 失败: ${e.message.slice(0, 50)}`)
  }
}

console.log('\n' + '='.repeat(92))
console.log('三、不同子分类的 hits 分布（判断热点是否集中在某些分类）')
console.log('='.repeat(92))
try {
  const cls = await jget(`${base}?ac=list`)
  const roots = (cls.class || []).filter((c) => !Number(c.type_pid))
  const target = roots.find((r) => /连续剧|电视剧/.test(r.type_name))
  if (target) {
    const children = (cls.class || []).filter((c) => Number(c.type_pid) === Number(target.type_id))
    console.log(`  「${target.type_name}」下 ${children.length} 个子分类：`)
    for (const c of children.slice(0, 8)) {
      try {
        const d = await jget(`${base}?ac=detail&pg=1&t=${c.type_id}`)
        const list = d.list || []
        const h = list.map((v) => Number(v.vod_hits) || 0)
        const st = stats(h)
        console.log(`     t=${String(c.type_id).padStart(3)} ${String(c.type_name).padEnd(8)} ${String(list.length).padStart(2)}条  hits 最大=${String(st.max).padStart(8)} 中位=${String(st.median).padStart(7)}`)
      } catch (e) {
        console.log(`     t=${c.type_id} ${c.type_name} 失败`)
      }
    }
  }
} catch (e) {
  console.log('  失败:', e.message.slice(0, 60))
}
