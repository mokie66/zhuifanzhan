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
import { normalizeVodList, mergeVods, normalizeTitle } from '@/utils/media.js'

/* ------------------------------------------------------------------ *
 * 缓存
 * ------------------------------------------------------------------ */
const cache = new Map()

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() > hit.expire) {
    cache.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expire: Date.now() + ttlMs })
  if (cache.size > 200) {
    const firstKey = cache.keys().next().value
    cache.delete(firstKey)
  }
  return value
}

export function clearCache() {
  cache.clear()
}

/* ------------------------------------------------------------------ *
 * 源并发查询
 * ------------------------------------------------------------------ */

const PER_SOURCE_TIMEOUT = 14000

/** 并发跑多个源，返回成功结果与失败明细 */
async function fanOut(sources, task, { timeout = PER_SOURCE_TIMEOUT } = {}) {
  const jobs = sources.map((src) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    return task(src, ctrl.signal)
      .then((value) => ({ ok: true, source: src, value }))
      .catch((err) => ({ ok: false, source: src, error: err?.message || String(err) }))
      .finally(() => clearTimeout(timer))
  })
  const settled = await Promise.allSettled(jobs)
  const results = settled.map((r) =>
    r.status === 'fulfilled' ? r.value : { ok: false, source: null, error: 'unexpected' }
  )
  return {
    ok: results.filter((r) => r.ok),
    failed: results.filter((r) => !r.ok),
  }
}

/* ------------------------------------------------------------------ *
 * 导航分类
 * ------------------------------------------------------------------ */

export async function getNavCategories({ force = false } = {}) {
  if (!force) {
    const cached = cacheGet('nav:categories')
    if (cached) return cached
  }
  const sources = enabledSources()
  const { ok } = await fanOut(sources, async (src) => {
    const classes = await getClasses(src)
    return { key: src.key, classes }
  })
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

/** 按语义分组取最新（首页用） */
export async function getLatest(group, { limit = 12 } = {}) {
  const key = `latest:${group}:${limit}`
  const cached = cacheGet(key)
  if (cached) return cached

  const sources = enabledSources()
  const { ok } = await fanOut(sources, (src, signal) =>
    fetchLatestByGroup(
      src,
      group,
      Math.ceil(limit / 2) + 6,
      signal,
      sources.findIndex((s) => s.key === src.key)
    )
  )

  const all = []
  ok.forEach((r) => all.push(...r.value.items))
  const merged = mergeVods(all, sources).slice(0, limit)
  return cacheSet(key, merged, 3 * 60 * 1000)
}

/** 一次取多个分组的最新（首页用） */
export async function getLatestMulti(groups, { limit = 8 } = {}) {
  const entries = await Promise.all(
    groups.map(async (g) => [g, await getLatest(g, { limit }).catch(() => [])])
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
  const result = {
    group,
    groupLabel: groupLabel(group),
    page,
    pageCount: Math.min(maxPageCount, 500),
    hasMore: ok.length > 0 && page < Math.min(maxPageCount, 500),
    items: merged,
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
  return cacheSet(key, result, 3 * 60 * 1000)
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
  return cacheSet(key, result, 3 * 60 * 1000)
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

export async function getHomeFeed() {
  const key = 'home:feed'
  const cached = cacheGet(key)
  if (cached) return cached

  const [latest, categories] = await Promise.all([
    getLatestMulti(['tv', 'anime', 'movie'], { limit: 8 }).catch(() => ({})),
    getNavCategories().catch(() => []),
  ])

  const tv = latest.tv || []
  const anime = latest.anime || []
  const movie = latest.movie || []

  const pool = [...tv, ...movie, ...anime].filter((v) => v.poster)
  const hero = pool.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0] || pool[0] || null

  const feed = { hero, latestTv: tv, latestAnime: anime, latestMovie: movie, categories }
  return cacheSet(key, feed, 3 * 60 * 1000)
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
