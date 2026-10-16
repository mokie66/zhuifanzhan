/**
 * 关键验证：MacCMS 的 t= 参数到底是「精确匹配」还是「含子分类」
 *
 * 这直接决定聚合层要不要展开子分类逐个查。
 * 如果顶级 id 匹配不到数据，就必须用子分类 id 查询再合并。
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const SOURCES = [
  { key: 'lzi', name: '量子', api: 'http://cj.lziapi.com/api.php/provide/vod/' },
  { key: 'ffzy', name: '非凡', api: 'http://cj.ffzyapi.com/api.php/provide/vod/' },
  { key: 'dytt', name: '电影天堂', api: 'http://caiji.dyttzyapi.com/api.php/provide/vod/' },
  { key: 'tyys', name: '天涯', api: 'http://tyyszy.com/api.php/provide/vod' },
  { key: 'iqiyi', name: '爱奇艺', api: 'https://www.iqiyizyapi.com/api.php/provide/vod/' },
]

async function jget(url, timeout = 20000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(timeout),
  })
  const t = await r.text()
  if (t.trimStart().startsWith('<')) return { __html: true, list: [], total: 0 }
  return JSON.parse(t.replace(/^\uFEFF/, ''))
}

const q = (api, s) => api + (api.includes('?') ? '&' : '?') + s

for (const src of SOURCES) {
  console.log('\n' + '='.repeat(88))
  console.log(`【${src.name}】`)
  console.log('='.repeat(88))

  let classes = []
  try {
    const d = await jget(q(src.api, 'ac=list'))
    classes = (d.class || []).map((c) => ({
      id: Number(c.type_id),
      pid: Number(c.type_pid || 0),
      name: String(c.type_name || '').trim(),
    }))
    console.log(`  分类表 ${classes.length} 个`)
  } catch (e) {
    console.log(`  ✘ 取分类表失败: ${e.message}`)
    continue
  }

  // 找出属于「电影」顶级分类的顶级 id 与其子分类
  const roots = classes.filter((c) => !c.pid)
  const movieRoot = roots.find((r) => /电影/.test(r.name))
  if (!movieRoot) {
    console.log('  未找到电影顶级分类，跳过')
    continue
  }
  const children = classes.filter((c) => c.pid === movieRoot.id)
  console.log(`  电影顶级: id=${movieRoot.id} "${movieRoot.name}"   子分类 ${children.length} 个: ${children.map((c) => `${c.id}:${c.name}`).slice(0, 6).join(' ')}`)

  // 1) 用顶级 id 查
  try {
    const d = await jget(q(src.api, `ac=detail&pg=1&t=${movieRoot.id}`))
    const items = d.list || []
    console.log(`  [顶级 id=${movieRoot.id}]  返回 ${items.length} 条  total=${d.total ?? '?'}`)
    if (items.length) {
      const tids = [...new Set(items.map((x) => x.type_id))]
      console.log(`      实际 type_id 分布: ${tids.slice(0, 8).join(', ')}`)
      console.log(`      分类名: ${[...new Set(items.map((x) => x.type_name))].slice(0, 5).join(', ')}`)
    }
  } catch (e) {
    console.log(`  [顶级 id] 失败: ${e.message.slice(0, 60)}`)
  }

  // 2) 用第一个子分类 id 查
  if (children.length) {
    const c0 = children[0]
    try {
      const d = await jget(q(src.api, `ac=detail&pg=1&t=${c0.id}`))
      const items = d.list || []
      console.log(`  [子分类 id=${c0.id} "${c0.name}"]  返回 ${items.length} 条  total=${d.total ?? '?'}`)
      if (items.length) {
        const tids = [...new Set(items.map((x) => x.type_id))]
        console.log(`      实际 type_id 分布: ${tids.slice(0, 8).join(', ')}`)
      }
    } catch (e) {
      console.log(`  [子分类 id] 失败: ${e.message.slice(0, 60)}`)
    }
  }

  // 3) 不带 t 查（对照）
  try {
    const d = await jget(q(src.api, 'ac=detail&pg=1'))
    const items = d.list || []
    console.log(`  [不带 t]  返回 ${items.length} 条  total=${d.total ?? '?'}`)
    if (items.length) {
      const tids = [...new Set(items.map((x) => x.type_id))]
      console.log(`      实际 type_id 分布: ${tids.slice(0, 8).join(', ')}`)
    }
  } catch (e) {
    console.log(`  [不带 t] 失败: ${e.message.slice(0, 60)}`)
  }
}
