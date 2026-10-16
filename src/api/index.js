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
import { rankVods, rankHot, rankSearchResults } from './rank.js'

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
import {
  checkAvailable,
  recordSuccess,
  recordFailure,
  healthSnapshot,
  HEALTH_TUNING,
} from './health.js'

/** 默认的「慢请求」判定阈值（各调用方可按自己的预算覆盖） */
const SLOW_MS_DEFAULT = HEALTH_TUNING.SLOW_MS

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
 *
 * 为什么是 9 秒而不是更短：热门榜依赖爱奇艺/魔都，实测这两个源
 * 「分类表 + 数据」合计要 6.5 秒（爱奇艺 0.9+5.6；魔都 3.4+2.8）。
 * 用 7 秒会时灵时不灵 —— 拿不到播放量数据就退化成「刚入库的批量新番」，
 * 也就是用户反复反馈的内容质量问题。
 * 这 9 秒只在**首次安装后的第一次打开**付出，之后有持久化缓存是瞬开，
 * 所以宁可多等 2 秒也要保证内容是对的。
 */
const HOME_BUDGET_MS = 9000

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
  {
    timeout = PER_SOURCE_TIMEOUT,
    skipUnhealthy = true,
    deadline = 0,
    slowMs = SLOW_MS_DEFAULT,
  } = {}
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
        recordSuccess(src.key, Date.now() - t0, slowMs)
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
 * 热门榜专用预算。
 *
 * 比首屏预算长：实测两个「有热度数据」的源都很慢 ——
 *   魔都   分类表 3445ms + 数据 2756ms ≈ 6.2s
 *   爱奇艺 分类表  861ms + 数据 5646ms ≈ 6.5s
 * 用 6s 预算会刚好错过，热门榜拿不到 hits 数据就退化成兜底排序了。
 * 热门榜只用于专门的榜单页（用户在等内容），且缓存 30 分钟，等得起。
 */
const HOT_BUDGET_MS = 11000

/**
 * 判定热门榜结果是否「不够好」：一条带播放量的都没有
 * 说明有热度数据的源没赶上预算，此时应后台用更长预算重取。
 */
function isWeakHotList(list) {
  return !Array.isArray(list) || !list.some((v) => (Number(v.hits) || 0) > 0)
}

/**
 * 记住「每个源在每个分组下选中的子分类 id」的缓存时长
 * 24 小时足够：子分类 id 基本不变，而这是分类表不可用时的唯一兜底。
 */
const SUBCAT_MEMO_TTL = 24 * 60 * 60 * 1000

/**
 * 解析某个源在某个分组下应该查哪些子分类
 *
 * 为什么要有「记住」这一层：
 *   部分源的分类表接口极不稳定 —— 实测魔都的 ac=list 直接超时（>25 秒），
 *   但它的数据接口完全正常（2.4 秒返回 20 条且都带播放量）。
 *   如果没有兜底，魔都就会因为「拿不到分类表」而整个被跳过，
 *   而它恰恰是热门榜最重要的数据源之一。
 *   所以每次成功解析后把结果记下来，失败时直接用上次记住的 id。
 *
 * @returns {Promise<number[]|null>} 子分类 id 列表；彻底无法确定时返回 null
 */
async function resolveHotPicks(src, group, preferRe) {
  const memoKey = `subcat:${group}:${src.key}`
  try {
    const classes = await getClasses(src)
    const groups = resolveGroups(classes)
    const g = groups[group]
    if (!g) return null

    const children = [...new Set(g.children || [])].map((id) => {
      const c = classes.find((x) => x.type_id === id)
      return { id, name: c ? c.type_name : '' }
    })

    // 优先名字匹配的子分类，其次第一个子分类，最后退回顶级 id
    let picks = preferRe ? children.filter((c) => preferRe.test(c.name)).map((c) => c.id) : []
    if (!picks.length && children.length) picks = [children[0].id]
    if (!picks.length) picks = [g.typeId]

    writeCache(memoKey, picks, SUBCAT_MEMO_TTL)
    return picks
  } catch {
    // 分类表拿不到 → 用上次记住的
    const memo = readCache(memoKey)
    if (memo && Array.isArray(memo.value) && memo.value.length) return memo.value
    return null
  }
}

/**
 * 热门榜统一取这么多条并缓存，调用方按需截取。
 *
 * 为什么缓存键里不带 limit（原来带，是错的）：
 *   首页要 6 条、底部导航的榜单页要 12 条，键写成 hot:anime:6 和 hot:anime:12
 *   就变成两份互不复用的缓存。用户在首页看完点「动漫」，会重新拉一次
 *   （最长 11 秒），体感很差。
 *   改成「一个分组一份池子」，首页和榜单页共享，切换底部导航就是瞬开。
 */
const HOT_POOL_SIZE = 12

/**
 * 热门榜单
 *
 * 取数策略全部基于实测（见 scripts/diagnose-hot.mjs）
 * ---------------------------------------------------
 * 1. 只用「有热度数据」的源参与排序。实测 vod_hits 填充率：
 *      魔都 40/40、爱奇艺 40/40、量子 0/40、非凡 0/40、电影天堂 2/40
 *    没有 hits 的源无法参与热度排序，硬排进来只会把批量动态漫带到榜首。
 *    rankHot 内部会剔除它们。
 * 2. 优先取「国产动漫 / 国产剧」这类子分类。爆款高度集中在这里，
 *    实测按 hits 排序捞出来的正是《遮天》《沧元图》《大主宰》这类真正的热门作品。
 * 3. 取 2 页扩大候选池 —— 只取一页的话热门作品可能刚好压在下一页。
 * 4. 缓存分级：拿到真实热度数据的缓存 30 分钟（热门变化慢）；
 *    只有兜底结果的只缓存 2 分钟，让后台重取能尽快替换掉它。
 * ------------------------------------------------------------------ */

/** 各分组下优先选取的子分类名（用于匹配 type_name） */
const HOT_PREFERRED_SUB = {
  anime: '国产动漫|国产动画|国漫',
  tv: '国产剧|大陆剧|内地剧',
  movie: '国产|大陆',
  variety: '大陆|内地|国产',
}

export async function getHotList(
  group,
  { limit = 12, pages = 2, deadline = HOT_BUDGET_MS, force = false } = {}
) {
  const key = `hot:${group}`
  const take = (list) => (Array.isArray(list) ? list.slice(0, limit) : [])

  if (!force) {
    const cached = cacheGet(key)
    if (cached) return take(cached)
  }

  const sources = enabledSources()
  const preferRe = HOT_PREFERRED_SUB[group] ? new RegExp(HOT_PREFERRED_SUB[group]) : null

  const { ok } = await fanOut(
    sources,
    async (src, signal) => {
      const picks = await resolveHotPicks(src, group, preferRe)
      if (!picks || !picks.length) return { items: [] }

      const items = []
      for (const tid of picks) {
        for (let pg = 1; pg <= pages; pg++) {
          try {
            const res = await rawList(src, { page: pg, typeId: tid }, { signal })
            items.push(...normalizeVodList(res.list, src))
          } catch {
            /* 单页失败不影响其他 */
          }
        }
      }
      return { items }
    },
    // slowMs 传热门榜预算：这些源本来就慢（魔都/爱奇艺 6 秒以上），
    // 按默认 6 秒判定会把它们记成「慢」进而熔断，等于把自己要用的源封了。
    { deadline, slowMs: deadline || HOT_BUDGET_MS }
  )

  const all = []
  ok.forEach((r) => all.push(...r.value.items))

  const merged = mergeVods(all, sources)
  // 池子按 HOT_POOL_SIZE 与 limit 的较大者取，避免调用方要得更多时拿不满
  const pool = rankHot(merged, { limit: Math.max(HOT_POOL_SIZE, limit) })

  // 只有拿到内容才写缓存（预算到点可能一个源都没回来）
  if (!pool.length) return []
  // 分级缓存：兜底结果只留 2 分钟，好让后台重取尽快替换
  const ttl = isWeakHotList(pool) ? 2 * 60 * 1000 : 30 * 60 * 1000
  cacheSetList(key, pool, ttl)
  return take(pool)
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
  // 按匹配强度重排：标题连续包含关键词的排前面，字被打散的（如搜「仙逆」
  // 命中「逆仙而上」）排后面。采集源原本的返回顺序只反映「哪个源先返回」，
  // 和相关性无关。详见 api/rank.js 的 matchTier 说明。
  const ranked = rankSearchResults(merged, kw)
  const result = {
    keyword: kw,
    page,
    group: group || null,
    items: ranked,
    total: ranked.length,
    rawTotal,
    hasMore: ok.some((r) => (r.value.items?.length || 0) >= 10),
    sourceStats: {
      total: sources.length,
      ok: ok.length,
      failed: failed.map((f) => ({ key: f.source?.key, error: f.error })),
      rawCount: all.length,
      mergedCount: ranked.length,
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

  homeInflight = buildHomeFeed({ onUpdate: onRefresh })
    .then((feed) => {
      // 通知启动闪屏：首页数据已就绪
      markHomeReady()
      // 首页出来后，后台把底部导航「动漫 / 电视剧」两个榜单页的数据备好，
      // 用户点过去就是瞬开。
      // 因为热门榜按「一个分组一份池子」缓存（见 HOT_POOL_SIZE），
      // 首页自己那次取数就已经填好了池子，这里的调用多数是缓存命中、零请求。
      // 真正起作用的情况：首页那次因预算不足只拿到兜底结果，
      // 这里会用完整预算补齐，用户点底部导航时已经是好数据。
      warmTabLists()
      return feed
    })
    .catch((err) => {
      // 失败也要放行闪屏，否则会一直卡在启动图上
      markHomeReady()
      throw err
    })
    .finally(() => {
      homeInflight = null
    })
  return homeInflight
}

/** 后台预热底部导航两个榜单页的数据（失败无所谓，用户点过去会正常加载） */
function warmTabLists() {
  Promise.all([
    getHotList('anime', { limit: HOT_POOL_SIZE }).catch(() => []),
    getHotList('tv', { limit: HOT_POOL_SIZE }).catch(() => []),
  ]).catch(() => null)
}

/* ------------------------------------------------------------------ *
 * 首页就绪信号（供启动闪屏等待）
 *
 * 为什么单独做一套而不是让闪屏直接调 getHomeFeed()：
 *   getHomeFeed 有并发去重（homeInflight）。若启动页先调用，它会成为
 *   那个「唯一的 Promise」，而它不携带 onRefresh 回调 —— 于是 HomeView
 *   后续的调用只会复用它，热门榜后台升级的结果就没人接收了。
 *   所以这里只提供「等待」能力，不参与任何请求的创建。
 * ------------------------------------------------------------------ */

let homeReadyFlag = false
const homeReadyWaiters = new Set()

/** 首页数据就绪（或已就绪过）时调用 */
function markHomeReady() {
  homeReadyFlag = true
  const waiters = [...homeReadyWaiters]
  homeReadyWaiters.clear()
  waiters.forEach((fn) => fn(true))
}

/**
 * 等待首页数据就绪。
 * 若当前没有请求在进行中（例如还没进首页），立即返回 false，不空等。
 *
 * @param {number} timeoutMs 最长等待时间
 * @returns {Promise<boolean>} 是否在超时前就绪
 */
export function waitHomeFeedReady(timeoutMs = 8000) {
  if (homeReadyFlag) return Promise.resolve(true)
  if (!homeInflight) return Promise.resolve(false)
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      homeReadyWaiters.delete(finish)
      resolve(ok)
    }
    homeReadyWaiters.add(finish)
    setTimeout(() => finish(false), timeoutMs)
  })
}

/** 首页数据是否已经就绪过 */
export function isHomeFeedReady() {
  return homeReadyFlag
}

/** 真正做聚合的那一层 */
async function buildHomeFeed(
  { onUpdate, hotDeadline = HOME_BUDGET_MS, forceHot = false } = {}
) {
  /**
   * 首页内容策略
   * ------------
   * 动漫 / 电视剧用「热门榜」（getHotList）而不是「最新」。
   * 原因：按更新时间取回来的全是刚入库的批量动态漫，观感差、也没人想看；
   * 热门榜按播放量排序，捞出来的是《遮天》《沧元图》《大主宰》这类真正的爆款。
   * 电影暂时仍用「最新」（用户只提了动漫和电视剧）。
   *
   * 热门榜用短预算先出结果：两个有热度数据的源都要 6 秒以上，
   * 若卡住不放会让首屏很难看。拿不到优质结果时下面会后台重取（见 upgradeHot）。
   */
  const [hotAnime, hotTv, latestMovie] = await Promise.all([
    getHotList('anime', { limit: 6, deadline: hotDeadline, force: forceHot }).catch(() => []),
    getHotList('tv', { limit: 6, deadline: hotDeadline, force: forceHot }).catch(() => []),
    getLatest('movie', { limit: 8, deadline: HOME_BUDGET_MS }).catch(() => []),
  ])

  const anime = hotAnime
  const tv = hotTv
  const movie = latestMovie

  const pool = [...tv, ...movie, ...anime].filter((v) => v.poster)
  const hero =
    pool.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0] || pool[0] || null

  // 不再返回 categories：首页的分类快捷入口已移除，没有其他视图在用，
  // 保留只会白白多跑一次「全源分类表聚合」。
  const feed = { hero, hotAnime: anime, hotTv: tv, latestMovie: movie }

  // 只有拿到内容才写缓存：预算到点时可能一个源都没回来，
  // 这时写空数据会把「没内容」固化数分钟，下次打开还是空的。
  const hasContent = tv.length || anime.length || movie.length
  if (hasContent) {
    // 各分区都先瘦身：播放线路数据占体积 99.4%，
    // 不瘦身会让 localStorage 记录达到 MB 级（实测 1.7MB），
    // 既逼近配额上限，序列化本身也要几百毫秒。
    const slim = {
      ...feed,
      hotAnime: slimVodList(anime),
      hotTv: slimVodList(tv),
      latestMovie: slimVodList(movie),
      hero: hero ? slimVodList([hero])[0] : null,
    }
    cacheSet('home:feed', slim, HOME_TTL)
  }

  // 热门榜质量不足（没拿到任何播放量数据）→ 后台用更长预算重取一次。
  // 只在首次（非 force）路径触发，避免 force 调用再套一层造成循环。
  if (!forceHot && (isWeakHotList(anime) || isWeakHotList(tv))) {
    upgradeHotInBackground(onUpdate)
  }

  return feed
}

/** 热门榜后台升级中标记（同时只跑一份） */
let hotUpgrading = false

/**
 * 后台用长预算重取热门榜，成功后把新数据推给界面。
 *
 * 为什么需要：
 *   魔都 / 爱奇艺都要 6 秒以上才返回带播放量的数据，而首屏预算只有 7 秒，
 *   首屏常常等不到它们，只能退化排序（结果是刚入库的批量新番）。
 *   这里先用退化结果把界面填上（用户不用干等），再在后台静静换成真正的热门榜。
 */
function upgradeHotInBackground(onUpdate) {
  if (hotUpgrading) return
  hotUpgrading = true
  buildHomeFeed({ hotDeadline: HOT_BUDGET_MS, forceHot: true })
    .then((fresh) => {
      if (fresh && typeof onUpdate === 'function') onUpdate(fresh)
    })
    .catch(() => null)
    .finally(() => {
      hotUpgrading = false
    })
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
