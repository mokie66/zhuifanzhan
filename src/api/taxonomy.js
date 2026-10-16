/**
 * 分类语义归一（解决各源 type_id 编号不一致的问题）
 * ==================================================
 * 实测结论：各源的分类编号体系互不相同 ——
 *   源 A：1=电影 2=连续剧 3=综艺 4=动漫
 *   源 B：7=电影 8=连续剧 9=综艺 40=动漫
 * 所以**禁止跨源硬编码 type_id**，否则在别的源上会查到完全不相干的分类。
 *
 * 本模块的做法：读取每个源自己的分类表 → 按「名称语义」把分类归一到统一的
 * group → 得到该源在这个 group 下应该使用的 type_id。
 *
 * 判断依据有两层，缺一不可：
 *   1) 层级：type_pid === 0 的是顶级分类，它的子分类继承父级语义
 *   2) 名称：顶级分类名往往带「片」字（电影片/综艺片/动漫片），需要关键词匹配
 */

/**
 * 语义分组定义
 *
 * priority 越小越先匹配 —— 顺序很重要，例如「动漫电影」应归入动漫而非电影，
 * 所以动漫必须排在电影前面。
 */
export const SEMANTIC_GROUPS = [
  { key: 'anime',   label: '动漫',   priority: 10, pattern: /动漫|动画|\b番\b|新番|国漫|日漫|番剧/ },
  { key: 'short',   label: '短剧',   priority: 15, pattern: /短剧/ },
  { key: 'variety', label: '综艺',   priority: 20, pattern: /综艺/ },
  { key: 'tv',      label: '电视剧', priority: 30, pattern: /连续剧|电视剧|国产剧|欧美剧|韩国剧|日本剧|港台剧|海外剧|泰国剧|台湾剧|香港剧|新加坡剧|美剧|日剧|韩剧|^剧$|剧$/ },
  { key: 'movie',   label: '电影',   priority: 40, pattern: /电影|^片$|片$/ },
  { key: 'doc',     label: '纪录片', priority: 50, pattern: /纪录|记录|纪实/ },
  { key: 'sports',  label: '体育',   priority: 60, pattern: /体育|足球|篮球|网球/ },
]

/** 归入「其他」的分类统一 key */
export const OTHER_GROUP = { key: 'other', label: '其他' }

/** 取语义分组的展示名 */
export function groupLabel(key) {
  const g = SEMANTIC_GROUPS.find((x) => x.key === key)
  return g ? g.label : OTHER_GROUP.label
}

/**
 * 把一个分类名匹配到语义分组
 * @returns {string} 分组 key，未匹配返回 'other'
 */
export function matchGroup(typeName) {
  const name = String(typeName || '').trim()
  if (!name) return 'other'
  // 按 priority 升序尝试，先命中先返回
  const sorted = [...SEMANTIC_GROUPS].sort((a, b) => a.priority - b.priority)
  for (const g of sorted) {
    if (g.pattern.test(name)) return g.key
  }
  return 'other'
}

/**
 * 分析一个源的分类表，得到「语义分组 → 该源可用的 type_id」
 *
 * @param {Array<{type_id:number,type_pid:number,type_name:string}>} classes
 * @returns {Record<string, {key:string, label:string, typeId:number, typeIds:number[], children:number[]}>}
 */
export function resolveGroups(classes = []) {
  const byId = new Map(classes.map((c) => [c.type_id, c]))
  const roots = classes.filter((c) => !c.type_pid || !byId.has(c.type_pid))
  const result = {}

  // 第一遍：顶级分类按名称定语义
  const rootGroup = new Map()
  roots.forEach((root) => {
    const g = matchGroup(root.type_name)
    rootGroup.set(root.type_id, g)
    if (!result[g]) {
      result[g] = {
        key: g,
        label: groupLabel(g),
        typeId: root.type_id,   // 查询时用顶级 id，MacCMS 会自动包含子分类
        typeIds: [root.type_id],
        children: [],
        sourceName: root.type_name,
      }
    }
  })

  // 第二遍：子分类继承父级语义；若有独立语义也补进来
  classes.forEach((c) => {
    if (!c.type_pid) return
    let g = rootGroup.get(c.type_pid)
    if (!g) g = matchGroup(c.type_name)
    // 子分类自身语义更强时以自身为准（例如「动漫电影」挂在电影下）
    const selfGroup = matchGroup(c.type_name)
    if (selfGroup !== 'other' && selfGroup !== g) {
      const selfDef = SEMANTIC_GROUPS.find((x) => x.key === selfGroup)
      const parentDef = SEMANTIC_GROUPS.find((x) => x.key === g)
      if (selfDef && (!parentDef || selfDef.priority < parentDef.priority)) {
        g = selfGroup
      }
    }
    if (result[g]) {
      result[g].children.push(c.type_id)
      result[g].typeIds.push(c.type_id)
    }
  })

  return result
}

/**
 * 取某个语义分组在某源上应当使用的 type_id
 * 找不到时返回 null（调用方应跳过该源，而不是拿错误 id 去查）
 */
export function typeIdForGroup(classes, groupKey) {
  const groups = resolveGroups(classes)
  const g = groups[groupKey]
  return g ? g.typeId : null
}

/* ------------------------------------------------------------------ *
 * 关于 t= 参数（重要，实测结论）
 * ------------------------------------------------------------------ *
 * MacCMS 的 `t=` 是「精确匹配 type_id」，**不包含子分类**。
 * 实测：
 *   量子  t=1（电影片顶级） → total=1    只返回顶级分类自己的占位数据
 *   量子  t=6（动作片子类） → total=4974  正常
 *   非凡  t=1               → total=0    顶级分类下没有任何影片
 *   电影天堂 t=1            → total=0
 * 因此：
 *   - 用顶级 id 查询会得到空列表 → 绝对不能用
 *   - 正确做法有两种（见 index.js）：
 *       A. 不带 t 拉取，再用分类表在客户端按 type_id 过滤  ← 首选，只花 1 次请求
 *       B. 逐个用子分类 id 查询后合并                      ← 精确但要 N 次请求
 */

/**
 * 取某语义分组在该源下「实际存放影片」的 type_id 列表
 *
 * 关键判断：有子分类时**必须排除顶级 id**，因为顶级 id 在多数源上是空的
 * （或只有 1 条占位数据，混进列表会造成脏数据）。
 * 没有子分类时才退回用顶级 id 本身。
 */
export function queryTypeIds(classes, groupKey) {
  const g = resolveGroups(classes)[groupKey]
  if (!g) return []
  const children = [...new Set(g.children || [])]
  if (children.length) return children
  return g.typeIds?.length ? [...new Set(g.typeIds)] : [g.typeId]
}

/** 判断某个 type_id 是否属于指定语义分组（客户端过滤用） */
export function typeIdBelongsTo(classes, typeId, groupKey) {
  const ids = new Set(queryTypeIds(classes, groupKey))
  // 顶级 id 本身也算（少数源把影片直接挂在顶级下）
  const g = resolveGroups(classes)[groupKey]
  if (g) ids.add(g.typeId)
  return ids.has(Number(typeId))
}

/**
 * 判断一条影片数据是否属于某语义分组
 * 优先按 type_id 判断（准确）；源未提供 type_id 时退回按分类名判断
 */
export function vodBelongsToGroup(vod, classes, groupKey) {
  if (!vod) return false
  if (vod.categoryId) return typeIdBelongsTo(classes, vod.categoryId, groupKey)
  return matchGroup(vod.categoryName) === groupKey
}

/**
 * 汇总多个源的分类表，产出前端导航可用的分类列表
 * 只保留出现次数达到阈值的分组，避免个别源的怪异分类污染导航
 */
export function buildNavCategories(classMapBySource, { minSources = 1 } = {}) {
  const counter = new Map()
  Object.values(classMapBySource).forEach((classes) => {
    const groups = resolveGroups(classes)
    Object.keys(groups).forEach((g) => {
      if (g === 'other') return
      counter.set(g, (counter.get(g) || 0) + 1)
    })
  })

  const preferredOrder = ['movie', 'tv', 'anime', 'variety', 'short', 'doc', 'sports']
  return preferredOrder
    .filter((g) => (counter.get(g) || 0) >= minSources)
    .map((g) => ({
      key: g,
      label: groupLabel(g),
      sourceCount: counter.get(g) || 0,
    }))
}
