/**
 * 诊断：「爆火内容」的取数可行性
 * ================================
 * 用户要求首页展示「6 部爆火的国漫 + 6 部电视剧」。
 * 但前面已实测：vod_hits 只有爱奇艺/魔都提供，vod_score 填充率仅 5~13%，
 * 接口也不支持 by/order 排序参数。
 *
 * 所以先回答一个关键问题：按「国产动漫」子分类取数、再按 hits 排序，
 * 能不能真的捞出知名热门作品？如果捞出来的还是冷门新番，那这个方案就不成立，
 * 得换思路（例如另找带热度数据的源）。
 *
 * 运行：node scripts/diagnose-hot.mjs
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
  return JSON.parse(t.replace(/^\uFEFF/, ''))
}

const q = (api, qs) => api + (api.includes('?') ? '&' : '?') + qs

/** 在分类表里找名字匹配的子分类 */
function findChildren(classes, re) {
  const roots = classes.filter((c) => !Number(c.type_pid))
  const root = roots.find((r) => re.root.test(String(r.type_name)))
  if (!root) return { root: null, children: [] }
  const children = classes.filter((c) => Number(c.type_pid) === Number(root.type_id))
  return { root, children }
}

const TARGETS = [
  { name: '国漫', re: { root: /动漫|动画/, child: /国产动漫|国产动画|国漫/ } },
  { name: '电视剧', re: { root: /连续剧|电视剧/, child: /国产剧|大陆剧|内地剧/ } },
]

for (const target of TARGETS) {
  console.log('='.repeat(100))
  console.log(`目标分类：${target.name}`)
  console.log('='.repeat(100))

  const pool = []

  for (const [srcName, api] of SOURCES) {
    try {
      const cls = await jget(q(api, 'ac=list'))
      const all = (cls.class || []).map((c) => ({
        type_id: Number(c.type_id),
        type_pid: Number(c.type_pid || 0),
        type_name: String(c.type_name || '').trim(),
      }))
      const { root, children } = findChildren(all, target.re)
      if (!root) {
        console.log(`\n【${srcName}】未找到「${target.name}」顶级分类`)
        continue
      }
      const hit = children.find((c) => target.re.child.test(c.type_name))
      const tid = hit ? hit.type_id : root.type_id
      const tname = hit ? hit.type_name : root.type_name

      // 取 2 页，扩大候选池
      const items = []
      for (const pg of [1, 2]) {
        try {
          const d = await jget(q(api, `ac=detail&pg=${pg}&t=${tid}`))
          items.push(...(d.list || []).map((v) => ({ ...v, _src: srcName })))
        } catch {
          /* 单页失败忽略 */
        }
      }
      pool.push(...items)

      const withHits = items.filter((v) => Number(v.vod_hits) > 0).length
      const withScore = items.filter((v) => Number(v.vod_score) > 0).length
      console.log(
        `\n【${srcName}】t=${tid} ${tname}  取到 ${items.length} 条  ` +
          `有 hits ${withHits} / 有评分 ${withScore}`
      )

      // 该源内部按 hits 排序展示前 5
      const byHits = [...items].sort(
        (a, b) => (Number(b.vod_hits) || 0) - (Number(a.vod_hits) || 0)
      )
      byHits.slice(0, 5).forEach((v) => {
        const h = Number(v.vod_hits) || 0
        const s = Number(v.vod_score) || 0
        console.log(
          `     hits=${String(h).padStart(7)}  score=${String(s).padStart(4)}  ` +
            `${String(v.vod_time || '').slice(0, 10)}  《${v.vod_name}》`
        )
      })
    } catch (e) {
      console.log(`\n【${srcName}】失败: ${e.message.slice(0, 60)}`)
    }
  }

  // 合并后按 hits 排序（跨源，用于看整体效果）
  console.log(`\n---- 合并 ${pool.length} 条后按 hits 排序 Top 15 ----`)
  const merged = [...pool].sort(
    (a, b) => (Number(b.vod_hits) || 0) - (Number(a.vod_hits) || 0)
  )
  merged.slice(0, 15).forEach((v, i) => {
    const h = Number(v.vod_hits) || 0
    const s = Number(v.vod_score) || 0
    console.log(
      `  ${String(i + 1).padStart(2)}. hits=${String(h).padStart(7)} score=${String(s).padStart(4)} ` +
        `${String(v._src).padEnd(5)} 《${v.vod_name}》`
    )
  })

  // 按评分排序（hits 缺失时的替补信号）
  console.log(`\n---- 同为这批数据，按评分排序 Top 10（hits 缺失时的替补） ----`)
  const byScore = [...pool]
    .filter((v) => Number(v.vod_score) > 0)
    .sort((a, b) => Number(b.vod_score) - Number(a.vod_score))
  byScore.slice(0, 10).forEach((v, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. score=${String(Number(v.vod_score)).padStart(4)} ` +
        `hits=${String(Number(v.vod_hits) || 0).padStart(7)} ${String(v._src).padEnd(5)} 《${v.vod_name}》`
    )
  })
  console.log()
}
