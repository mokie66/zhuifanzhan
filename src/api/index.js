/**
 * 业务接口层
 * ============
 * 视图层只调用这里的方法，不直接碰采集源细节。
 *
 * 设计要点
 * --------
 * 1. 多源并行：单源普遍 1~7 秒，串行不可接受，因此 allSettled 并行查后合并去重。
 *    任一源失败不影响整体。
 *
 * 2. 分类按源解析：各源 type_id 体系不同（同为电影，有的源是 1 有的是 7），
 *    查询前必须用 taxonomy 把语义分组翻译成该源自己的 id。
 *
 * 3. 【重要】t= 参数是精确匹配、不含子分类（实测结论见 taxonomy.js）。
 *    所以分两种查询策略：
 *      A. 首页/最新：不带 t 拉取，客户端按分类表过滤 —— 最新内容在第 1 页，1 次请求覆盖全部子分类
 *      B. 分类分页：用子分类 id 轮转（第 P 页取 children[(P-1)%n]）—— 保证分页真实、内容有变化
 *
 * 4. 缓存：分类表 30 分钟，列表/搜索 3 分钟。
 */

import { enabledSources, getSource } from './config.js'
import { getClasses, detail as rawDetail, list as rawList, search as rawSearch } from './maccms.js'
import {
  resolveGroups,
  buildNavCategories,
  groupLabel,
  queryTypeIds,
  matchGroup,
} from './taxonomy.js'
import { normalizeVodList, mergeVods, normalizeTitle, slimVodList } from '@/utils/media.js'
import { rankVods } from './rank.js'

/* ------------------------------------------------------------------ *
 * 缓存（内存 + localStorage 两级，跨 App 启动保留）
 *
 * 原先只有一个内存 Map，App 一关就没了，导致每次启动首页必然冷启动。
 * 现在第二次起可以瞬间用上次的数据渲染，再后台刷新。
 * 详见 api/cache.js。
 * ------------------------------------------------------------------ */
import {
  readCache,
  writeCache,
  clearAll as clearAllCache,
  clearMemory as clearMemoryCache,
  cacheStats,
} from './cache.js'
import { checkAvailable, recordSuccess, recordFailure, healthSnapshot } from './health.js'

/**
 * 读缓存：只认「新鲜」的，过期即视为未命中。
 *
 * 注意与 cacheGetSoft 的区别：readCache 会把「过期但仍在可用窗口内」
 * 的数据也返回（带 stale 标记）。对「最新更新」这类语义，过期就必须重取，
 * 否则会拿着 20 分钟前的列表当成最新。需要 stale-while-revalidate 的地方
 * （首页整体聚合）改用 cacheGetSoft。
 */
function cacheGet(key) {
  const hit = readCache(key)
  if (!hit || hit.stale) return null
  return hit.value
}

/**
 * 读缓存（含「过期但可用」信息）
 * @returns {{value:any, stale:boolean}|null}
 */
function cacheGetSoft(key) {
  return readCache(key)
}

function cacheSet(key, value, ttlMs) {
  return writeCache(key, value, ttlMs)
}

/**
 * 写「列表类」缓存：先瘦身再写。
 *
 * 列表项带着完整播放线路数据，实测占单条体积 99.4%，
 * 直接落盘会把 localStorage 撑到 MB 级并显著拖慢序列化。
 * 详见 media.js 的 slimVod 说明。
 *
 * 注意：详情缓存（detail:*）**不能**用这个函数 —— 详情页正需要那些线路数据。
 */
function cacheSetList(key, list, ttlMs) {
  return cacheSet(key, slimVodList(list), ttlMs)
}

export function clearCache({ keepPersistent = false } = {}) {
  if (keepPersistent) clearMemoryCache()
  else clearAllCache()
}

export function getCacheStats() {
  return cacheStats()
}

export function getSourceHealth() {
  return healthSnapshot()
}

/* ------------------------------------------------------------------ *
 * 源并发查询
 * ------------------------------------------------------------------ */

/**
 * 单个请求超时
 *
 * 原值 14000（14 秒）太宽松：实测最慢的 ac=list 要 20 秒，
 * 14 秒超时意味着首屏要白等 14 秒才放弃。采集源正常响应在 300ms~6s，
 * 超过 6 秒的基本可以认为不值得等。
 */
const PER_SOURCE_TIMEOUT = 6000

/**
 * 分类表任务的超时（外层）。
 *
 * 要比 maccms.js 里分类表自身的超时（CLASS_TIMEOUT=7000）略长，
 * 这样先触发的是内层那个超时，错误信息更准确（「分类表超时」而不是「任务超时」）。
 */
const CLASS_FETCH_TIMEOUT = 8000

/**
 * 首屏总预算：超过这个时间就用已有数据渲染，不再等慢源。
 *
 * 这是解决「首页要等 20 秒」的关键 —— 用户不该为最慢的那个源买单。
 * 拿不到的分区会显示为空，后台继续补齐（见 getHomeFeed 的预热逻辑）。
 */
const HOME_BUDGET_MS = 7000

/**
 * 等一组 Promise，但最多等 budgetMs：到点就把已完成的那些交出来。
 *
 * 未完成的任务**不取消** —— 让它继续跑完并写入缓存，下次打开就有数据了。
 * 这是首屏体验的核心取舍：宁可先显示 4 个源的内容，也不要让用户盯着
 * 转圈等第 7 个源（实测最慢的源要 20 秒）。
 */
function settleWithin(promises, budgetMs) {
  return new Promise((resolve) => {
    const out = new Array(promises.length).fill(undefined)
    let settled = 0
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      resolve(out)
    }
    const timer = setTimeout(finish, budgetMs)
    promises.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => {
          out[i] = v
        })
        .catch(() => {
          out[i] = undefined
        })
        .finally(() => {
          if (++settled === promises.length) {
            clearTimeout(timer)
            finish()
          }
        })
    })
  })
}

/**
 * 并发跑多个源，返回成功结果与失败明细
 *
 * 相比原版增加：
 *   1. 熔断：跳过健康度不佳的源（健康度持久化，App 重启后依然生效）
 *   2. 健康度记录：成功/失败/慢 都回写，供下次决策
 *   3. deadline：首屏总预算，到点返回部分结果
 */
async function fanOut(
  sources,
  task,
  { timeout = PER_SOURCE_TIMEOUT, skipUnhealthy = true, deadline = 0 } = {}
) {
  const usable = []
  const skipped = []
  for (const src of sources) {
    const h = checkAvailable(src.key)
    if (skipUnhealthy && !h.usable) {
      skipped.push({ source: src, error: `已熔断（${h.reason}）` })
    } else {
      usable.push(src)
    }
  }
  if (skipped.length) {
    // 便于排查「为什么首页少了几个源」
    console.info(
      `[fanOut] 跳过 ${skipped.length} 个不健康源: ${skipped.map((s) => s.source.key).join(', ')}`
    )
  }

  const jobs = usable.map((src) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    const t0 = Date.now()
    return task(src, ctrl.signal)
      .then((value) => {
        recordSuccess(src.key, Date.now() - t0)
        return { ok: true, source: src, value }
      })
      .catch((err) => {
        recordFailure(src.key)
        const msg = err?.name === 'AbortError' ? `超时 ${timeout}ms` : err?.message || String(err)
        return { ok: false, source: src, error: msg }
      })
      .finally(() => clearTimeout(timer))
  })

  let results
  if (deadline > 0) {
    const partial = await settleWithin(jobs, deadline)
    const pendingCount = partial.filter((r) => r === undefined).length
    if (pendingCount) {
      console.info(`[fanOut] 预算 ${deadline}ms 到点，${pendingCount} 个源仍在跑（后台补齐）`)
    }
    results = partial.map(
      (r) => r || { ok: false, source: null, error: '超出首屏预算（后台继续）', pending: true }
    )
  } else {
    const settled = await Promise.allSettled(jobs)
    results = settled.map((r) =>
      r.status === 'fulfilled' ? r.value : { ok: false, source: null, error: 'unexpected' }
    )
  }

  return {
    ok: results.filter((r) => r.ok),
    failed: [...results.filter((r) => !r.ok), ...skipped],
    skipped: skipped.length,
  }
}

/* ------------------------------------------------------------------ *
 * 导航分类
 * ------------------------------------------------------------------ */

export async function getNavCategories({ force = false, deadline = 0 } = {}) {
  if (!force) {
    const cached = cacheGet('nav:categories')
    if (cached) return cached
  }
  const sources = enabledSources()
  // deadline 必须传：分类表是最慢的接口，而且这里的 fanOut 曾漏传 deadline，
  // 导致首页 Promise.all 一直等到最慢的源（实测 20 秒），
  // 前面 getLatest 的预算形同虚设。
  const { ok } = await fanOut(
    sources,
    async (src) => {
      const classes = await getClasses(src)
      return { key: src.key, classes }
    },
    { deadline, timeout: CLASS_FETCH_TIMEOUT }
  )
  const classMap = {}
  ok.forEach((r) => {
    classMap[r.value.key] = r.value.classes
  })
  const categories = buildNavCategories(classMap, { minSources: 1 })
  return cacheSet('nav:categories', categories, 30 * 60 * 1000)
}

/* ------------------------------------------------------------------ *
 * 取某分组的最新内容
 *
 * 实测对比（见 scripts/verify-strategy.mjs）：
 *   策略 A（不带 t + 客户端过滤）：movie 分组只命中 0~3 条 —— 全局最新列表
 *     被短剧/剧集占满，电影很少出现，语义对但数据太稀
 *   策略 B（子分类 id 查询）：每个分组稳定 20 条/页
 * 结论：Homepage 也走策略 B。用 `t=子分类&pg=1` 拿到的同样是「该子分类下最新」，
 * 语义正确且数据充足；再让不同源取不同子分类，保证覆盖面。
 * ------------------------------------------------------------------ */

async function fetchLatestByGroup(src, group, want, signal, sourceIndex = 0) {
  const classes = await getClasses(src)
  const groups = resolveGroups(classes)
  const g = groups[group]
  if (!g) return { items: [], pageCount: 1 }

  const children = [...new Set(g.children || [])]
  const items = []

  if (children.length) {
    // 让不同源从不同子分类开始取，避免所有源都返回同一类内容（如全是动作片）
    const offset = sourceIndex % children.length
    const picks = [
      children[offset],
      children[(offset + 1) % children.length],
      children[(offset + 2) % children.length],
    ]
    for (const tid of [...new Set(picks)]) {
      if (items.length >= want) break
      try {
        const res = await rawList(src, { page: 1, typeId: tid }, { signal })
        items.push(...normalizeVodList(res.list, src))
      } catch {
        /* 单个子分类失败不影响其他 */
      }
    }
  }

  if (items.length < want) {
    // 无子分类（如天涯/最大），或子分类都查不到：先用顶级 id 试，再退回不带 t
    const idSet = new Set([g.typeId, ...children])
    try {
      const res = await rawList(src, { page: 1, typeId: g.typeId }, { signal })
      const got = normalizeVodList(res.list, src)
      if (got.length) items.push(...got)
    } catch {
      /* 顶级 id 多数源为空，忽略 */
    }
    if (items.length < want) {
      try {
        const res = await rawList(src, { page: 1 }, { signal })
        const got = normalizeVodList(res.list, src).filter((it) =>
          idSet.size ? idSet.has(it.categoryId) : true
        )
        items.push(...got)
      } catch {
        /* 兜底也失败就返回已有内容 */
      }
    }
  }

  // 去重（同一子分类可能重复）
  const seen = new Set()
  const unique = items.filter((it) => {
    const k = `${it.sourceKey}:${it.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  return { items: unique.slice(0, want), pageCount: 1 }
}

/**
 * 按语义分组取最新（首页用）
 *
 * @param {object} opts
 *   limit     返回条数
 *   deadline  总预算（毫秒）。首页传具体值以限制首屏等待；
 *             列表页不传（用户能接受翻页时多等一会儿，且需要完整结果）
 */
export async function getLatest(group, { limit = 12, deadline = 0 } = {}) {
  const key = `latest:${group}:${limit}`
  const cached = cacheGet(key)
  if (cached) return cached

  const sources = enabledSources()
  // 候选池取大一些：排序需要足够的样本才能把热门内容顶上来。
  // 之前只按「最新」取，热门但上线较早的片子根本没机会出现。
  const { ok } = await fanOut(
    sources,
    (src, signal) =>
      fetchLatestByGroup(
        src,
        group,
        Math.ceil(limit * 2.5) + 10,
        signal,
        sources.findIndex((s) => s.key === src.key)
      ),
    { deadline }
  )

  const all = []
  ok.forEach((r) => all.push(...r.value.items))
  const merged = mergeVods(all, sources)
  // 按热度重排（详见 api/rank.js 的说明）
  const ranked = rankVods(merged, { limit })

  // 只有拿到内容才写缓存：预算到点时可能一个源都没回来，
  // 此时写空数组会把「没数据」固化 3 分钟，下次打开还是空的。
  if (!ranked.length) return ranked
  // 列表项先瘦身：列表视图不需要播放线路数据（占单条体积 99.4%）
  return cacheSetList(key, ranked, 3 * 60 * 1000)
}

/** 一次取多个分组的最新（首页用） */
export async function getLatestMulti(groups, { limit = 8, deadline = 0 } = {}) {
  const entries = await Promise.all(
    groups.map(async (g) => [g, await getLatest(g, { limit, deadline }).catch(() => [])])
  )
  return Object.fromEntries(entries)
}

/* ------------------------------------------------------------------ *
 * 策略 B：子分类轮转分页
 * ------------------------------------------------------------------ */

function planPage(classes, group, page) {
  const groups = resolveGroups(classes)
  const g = groups[group]
  if (!g) return { typeId: null, subPage: page, groupFound: false }

  const children = [...new Set(g.children || [])]
  if (!children.length) {
    return { typeId: g.typeId, subPage: page, groupFound: true }
  }
  const idx = (page - 1) % children.length
  const subPage = Math.floor((page - 1) / children.length) + 1
  return { typeId: children[idx], subPage, groupFound: true }
}

/** 分类列表（多源聚合，支持分页） */
export async function getCategoryList({ group = 'tv', page = 1, pageSize = 24 } = {}) {
  const key = `list:${group}:${page}:${pageSize}`
  const cached = cacheGet(key)
  if (cached) return cached

  const sources = enabledSources()

  const plans = await Promise.all(
    sources.map(async (src) => {
      try {
        const classes = await getClasses(src)
        const p = planPage(classes, group, page)
        return { src, classes, ...p }
      } catch (e) {
        return {
          src,
          classes: [],
          typeId: null,
          subPage: page,
          groupFound: false,
          err: e.message,
        }
      }
    })
  )

  const usable = plans.filter((p) => p.groupFound && p.typeId != null)
  const effective = usable.length
    ? usable
    : plans.map((p) => ({ ...p, typeId: null, subPage: page }))

  const { ok, failed } = await fanOut(effective, async (plan, signal) => {
    const res = await rawList(plan.src, { page: plan.subPage, typeId: plan.typeId }, { signal })
    let items = normalizeVodList(res.list, plan.src)
    if (plan.groupFound && plan.typeId == null) {
      items = items.filter((it) => matchGroup(it.categoryName) === group)
    }
    return { items, pageCount: res.pageCount, total: res.total, plan }
  })

  const all = []
  let maxPageCount = 1
  ok.forEach((r) => {
    all.push(...r.value.items)
    maxPageCount = Math.max(maxPageCount, r.value.pageCount || 1)
  })

  const merged = mergeVods(all, sources)
  // 同一页内按热度重排：让有真实播放量/好评的内容排在前面，
  // 批量生产的动态漫等低质内容降权后置（不删除，见 api/rank.js）
  const ranked = rankVods(merged, { limit: Math.max(pageSize, merged.length) })
  const result = {
    group,
    groupLabel: groupLabel(group),
    page,
    pageCount: Math.min(maxPageCount, 500),
    hasMore: ok.length > 0 && page < Math.min(maxPageCount, 500),
    items: ranked,
    sourceStats: {
      total: effective.length,
      ok: ok.length,
      failed: failed.map((f) => ({ key: f.source?.key, error: f.error })),
      rawCount: all.length,
      mergedCount: merged.length,
      plans: ok.map((r) => ({
        key: r.value.plan.src.key,
        typeId: r.value.plan.typeId,
        subPage: r.value.plan.subPage,
      })),
    },
  }
  // 列表项先瘦身（详见 media.js 的 slimVod）
  return cacheSet(key, { ...result, items: slimVodList(result.items) }, 3 * 60 * 1000)
}

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

export async function searchMedia({ keyword, page = 1, group } = {}) {
  const kw = String(keyword || '').trim()
  if (!kw) return { items: [], total: 0, rawTotal: 0, keyword: '', sourceStats: null }

  const key = `search:${kw}:${page}:${group || ''}`
  const cached = cacheGet(key)
  if (cached) return cached

  const sources = enabledSources()
  const { ok, failed } = await fanOut(sources, async (src, signal) => {
    const res = await rawSearch(src, { keyword: kw, page }, { signal })
    return { source: src, items: normalizeVodList(res.list, src), total: res.total }
  })

  const buckets = []
  let rawTotal = 0
  ok.forEach((r) => {
    buckets.push({ src: r.source, items: r.value.items })
    rawTotal += r.value.total || r.value.items.length
  })

  let all = []
  if (group) {
    for (const b of buckets) {
      let ids = []
      try {
        ids = queryTypeIds(await getClasses(b.src), group)
      } catch {
        /* 拿不到分类表就不过滤 */
      }
      const matched = ids.length ? b.items.filter((it) => ids.includes(it.categoryId)) : b.items
      all.push(...matched)
    }
  } else {
    buckets.forEach((b) => all.push(...b.items))
  }

  const merged = mergeVods(all, sources)
  const result = {
    keyword: kw,
    page,
    group: group || null,
    items: merged,
    total: merged.length,
    rawTotal,
    hasMore: ok.some((r) => (r.value.items?.length || 0) >= 10),
    sourceStats: {
      total: sources.length,
      ok: ok.length,
      failed: failed.map((f) => ({ key: f.source?.key, error: f.error })),
      rawCount: all.length,
      mergedCount: merged.length,
    },
  }
  // 列表项先瘦身（详见 media.js 的 slimVod）
  return cacheSet(key, { ...result, items: slimVodList(result.items) }, 3 * 60 * 1000)
}

/** 搜索联想 */
export async function searchSuggest(keyword, { limit = 8 } = {}) {
  const kw = String(keyword || '').trim()
  if (!kw) return []
  const key = `suggest:${kw}:${limit}`
  const cached = cacheGet(key)
  if (cached) return cached

  const { items } = await searchMedia({ keyword: kw, page: 1 })
  const seen = new Set()
  const words = []
  items.forEach((it) => {
    if (it.title && !seen.has(it.title)) {
      seen.add(it.title)
      words.push({ text: it.title, group: it.categoryName, id: it.id, sourceKey: it.sourceKey })
    }
  })
  const result = words.slice(0, limit)
  return cacheSet(key, result, 5 * 60 * 1000)
}

/* ------------------------------------------------------------------ *
 * 详情
 * ------------------------------------------------------------------ */

export async function getDetail({ sourceKey, id, withMirrors = true } = {}) {
  const cacheKeyName = `detail:${sourceKey}:${id}:${withMirrors ? 1 : 0}`
  const cached = cacheGet(cacheKeyName)
  if (cached) return cached

  const primary = getSource(sourceKey)
  if (!primary) throw new Error(`未知的采集源: ${sourceKey}`)

  const res = await rawDetail(primary, { ids: id })
  const list = normalizeVodList(res.list, primary)
  const found = list.find((v) => v.id === String(id)) || list[0]
  if (!found) throw new Error('未找到该影片，可能已下架')

  let vod = {
    ...found,
    mirrors: [],
    allLines: found.lines.map((l) => ({
      ...l,
      sourceKey: found.sourceKey,
      sourceName: found.sourceName,
      mirrored: false,
    })),
  }

  if (withMirrors && found.title) {
    vod = await enrichWithMirrors(vod)
  }

  return cacheSet(cacheKeyName, vod, 10 * 60 * 1000)
}

/** 用片名到其他源找同名片，补充可用线路（「换源」的数据基础） */
async function enrichWithMirrors(vod) {
  const sources = enabledSources().filter((s) => s.key !== vod.sourceKey)
  if (!sources.length) return vod

  const target = normalizeTitle(vod.title)
  const { ok } = await fanOut(
    sources,
    async (src, signal) => {
      const res = await rawSearch(src, { keyword: vod.title, page: 1 }, { signal })
      const items = normalizeVodList(res.list, src)
      return { source: src, items: items.filter((v) => normalizeTitle(v.title) === target) }
    },
    { timeout: 9000 }
  )

  const mirrors = []
  const extraLines = []
  ok.forEach((r) => {
    r.value.items.forEach((m) => {
      mirrors.push({
        sourceKey: m.sourceKey,
        sourceName: m.sourceName,
        id: m.id,
        playable: m.playable,
        episodeCount: m.episodeCount,
        lines: m.lines,
        poster: m.poster,
        remarks: m.remarks,
      })
      m.lines.forEach((l) =>
        extraLines.push({ ...l, sourceKey: m.sourceKey, sourceName: m.sourceName, mirrored: true })
      )
    })
  })

  const ownLines = vod.lines.map((l) => ({
    ...l,
    sourceKey: vod.sourceKey,
    sourceName: vod.sourceName,
    mirrored: false,
  }))

  const seen = new Set()
  const allLines = [...ownLines, ...extraLines].filter((l) => {
    const sig = `${l.key}|${l.episodes[0]?.url || ''}`
    if (seen.has(sig)) return false
    seen.add(sig)
    return true
  })

  return {
    ...vod,
    mirrors,
    allLines,
    episodeCount: Math.max(vod.episodeCount, ...mirrors.map((m) => m.episodeCount || 0)),
  }
}

/* ------------------------------------------------------------------ *
 * 首页
 * ------------------------------------------------------------------ */

const HOME_TTL = 3 * 60 * 1000

/** 首页聚合进行中的 Promise（并发去重，避免同时发起多份） */
let homeInflight = null
/** 后台刷新进行中标记 */
let homeRefreshing = false

/**
 * 首页聚合
 *
 * 三种路径：
 *   1. 缓存新鲜        → 直接返回，一个请求都不发（App 内切换页面时走这里）
 *   2. 缓存过期但可用   → **立即返回旧数据**，同时后台刷新并通过 onRefresh 回调新数据
 *   3. 无缓存（冷启动）→ 带总预算请求，最多等 HOME_BUDGET_MS
 *
 * 路径 2 是解决「每次进 App 都要等好久」的关键：用户看到的是上次的内容，
 * 秒开；新内容在后台悄悄更新。这就是 stale-while-revalidate。
 *
 * @param {object} opts
 *   force     忽略缓存，强制重取
 *   onRefresh 后台刷新完成后的回调，参数是新的 feed
 */
export async function getHomeFeed({ force = false, onRefresh } = {}) {
  const key = 'home:feed'

  if (!force) {
    const hit = cacheGetSoft(key)
    if (hit && !hit.stale) return hit.value

    if (hit) {
      // 过期但可用：先给旧数据，后台刷新
      if (typeof onRefresh === 'function') {
        refreshHomeInBackground().then((fresh) => {
          if (fresh) onRefresh(fresh)
        })
      } else {
        refreshHomeInBackground()
      }
      return hit.value
    }

    // 并发去重：已有冷启动请求在跑就复用
    if (homeInflight) return homeInflight
  }

  homeInflight = buildHomeFeed().finally(() => {
    homeInflight = null
  })
  return homeInflight
}

/** 真正做聚合的那一层 */
async function buildHomeFeed() {
  const [latest, categories] = await Promise.all([
    getLatestMulti(['tv', 'anime', 'movie'], {
      limit: 8,
      deadline: HOME_BUDGET_MS,
    }).catch(() => ({})),
    getNavCategories({ deadline: HOME_BUDGET_MS }).catch(() => []),
  ])

  const tv = latest.tv || []
  const anime = latest.anime || []
  const movie = latest.movie || []

  const pool = [...tv, ...movie, ...anime].filter((v) => v.poster)
  const hero =
    pool.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0] || pool[0] || null

  const feed = { hero, latestTv: tv, latestAnime: anime, latestMovie: movie, categories }

  // 只有拿到内容才写缓存：预算到点时可能一个源都没回来，
  // 这时写空数据会把「没内容」固化数分钟，下次打开还是空的。
  const hasContent = tv.length || anime.length || movie.length
  if (hasContent) {
    // 三个分区都先瘦身：这四项播放线路数据占体积 99.4%，
    // 不瘦身会让 localStorage 记录达到 MB 级（实测 1.7MB），
    // 既逼近配额上限，序列化本身也要几百毫秒。
    const slim = {
      ...feed,
      latestTv: slimVodList(tv),
      latestAnime: slimVodList(anime),
      latestMovie: slimVodList(movie),
      hero: hero ? slimVodList([hero])[0] : null,
    }
    cacheSet('home:feed', slim, HOME_TTL)
  }

  return feed
}

/** 后台刷新首页（不阻塞调用方） */
function refreshHomeInBackground() {
  if (homeRefreshing) return Promise.resolve(null)
  homeRefreshing = true
  return buildHomeFeed()
    .catch(() => null)
    .finally(() => {
      homeRefreshing = false
    })
}

/** 相关推荐 */
export async function getRecommendations(vod, { limit = 6 } = {}) {
  if (!vod?.title) return []
  const group = guessGroup(vod)
  const list = await getLatest(group, { limit: limit + 4 }).catch(() => [])
  const selfKey = normalizeTitle(vod.title)
  return list.filter((v) => normalizeTitle(v.title) !== selfKey).slice(0, limit)
}

/** 按分类名猜语义分组 */
export function guessGroup(vod) {
  const name = String(vod?.categoryName || '')
  if (/动漫|动画|番/.test(name)) return 'anime'
  if (/短剧/.test(name)) return 'short'
  if (/综艺/.test(name)) return 'variety'
  if (/纪录|记录/.test(name)) return 'doc'
  if (/电影/.test(name)) return 'movie'
  return 'tv'
}

/* ------------------------------------------------------------------ *
 * 源健康检查
 * ------------------------------------------------------------------ */

export async function checkSourcesHealth() {
  const sources = enabledSources()
  const { ok, failed } = await fanOut(
    sources,
    async (src, signal) => {
      const res = await rawList(src, { page: 1 }, { signal })
      return { total: res.total, upstreamMs: res.upstreamMs, sample: res.list.length }
    },
    { timeout: 12000 }
  )
  return sources.map((src) => {
    const good = ok.find((r) => r.source.key === src.key)
    const bad = failed.find((r) => r.source?.key === src.key)
    return {
      key: src.key,
      name: src.name,
      weight: src.weight,
      ok: Boolean(good),
      total: good?.value.total || 0,
      upstreamMs: good?.value.upstreamMs || 0,
      sample: good?.value.sample || 0,
      error: bad?.error || '',
    }
  })
}

export { groupLabel, resolveGroups, queryTypeIds }
