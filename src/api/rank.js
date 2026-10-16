/**
 * 热度排序与低质降权
 * ====================
 * 为什么需要
 * ----------
 * 采集源默认按「更新时间倒序」返回，而最新入库的内容被大量批量生产的
 * 动态漫、AI 短剧淹没。结果是首页全是没人看的资源，观感很差。
 *
 * 数据现实（实测，见 scripts/_diag-popularity.mjs）
 * ------------------------------------------------
 *   vod_hits 填充率：爱奇艺 40/40、魔都 40/40、量子 0/40、非凡 0/40、电影天堂 1/40
 *   vod_score 填充率：各源 5~13%
 *   接口不支持排序参数：by / order / sort 加什么都没用，返回同一批数据
 *
 * 由此得出两条设计约束：
 *   1. 只能客户端排序
 *   2. **不能把 hits 为 0 的一律排到末尾** —— 否则量子/非凡/电影天堂
 *      （三个主力源）的内容会被整体埋掉，首页只剩两三个源，
 *      既不利于冗余也减少了可播片源。所以按「有 hits → 有 score →
 *      仅时间」分三层各自排序后再交错合并。
 */

/** 低质内容特征：批量生产的动态漫、AI 短剧、无意义合集 */
const LOW_QUALITY_PATTERNS = [
  /动态漫/, // 动态漫画，多为批量灌水
  /漫剧/,
  /^AI/i,
  /解说$/, // 影视解说剪辑
  /合集$/,
]

/** 标题疑似灌水：纯数字、单字重复、异常短 */
function looksSpammy(title) {
  const t = String(title || '').trim()
  if (!t) return true
  if (t.length <= 1) return true
  if (/^\d+$/.test(t)) return true
  // 同一字符重复 4 次以上
  if (/(.)\1{3,}/.test(t)) return true
  return false
}

/**
 * 低质降权系数（越小越靠后）
 * 返回 1 表示不降权；返回 0.1 表示显著降权（不是删除）
 */
export function qualityFactor(vod) {
  const title = String(vod?.title || '')
  let f = 1
  if (LOW_QUALITY_PATTERNS.some((rx) => rx.test(title))) f *= 0.25
  if (looksSpammy(title)) f *= 0.2
  return f
}

/**
 * 热度分（0~1）
 *
 * hits 跨度极大（实测 2 ~ 44029），线性刻度会让头部几部永远霸榜、
 * 其余无法区分，所以用对数刻度。
 *
 * 注意：不同源的 hits 量级差异很大（爱奇艺最高 8425，魔都 44029），
 * 直接跨源比较会偏向魔都。因此 hits 只在**同源内**比较，
 * 跨源比较交给下面的分层合并处理。
 */
export function hitsToScore(hits, { cap = 50000 } = {}) {
  const h = Math.max(0, Number(hits) || 0)
  if (h <= 0) return 0
  const v = Math.log10(h + 1) / Math.log10(cap + 1)
  return Math.min(1, v)
}

/** 评分归一（豆瓣/站内评分多为 0~10） */
export function scoreToScore(score) {
  const s = Number(score) || 0
  if (s <= 0) return 0
  return Math.min(1, Math.max(0, (s - 5) / 4.5)) // 5 分以下不作为正向信号
}

/**
 * 解析时间字符串为时间戳
 *
 * 需要兼容两种格式：
 *   ISO 8601      "2026-10-16T04:23:12.000Z"   —— 标准，直接 new Date 可解析
 *   MacCMS 格式   "2026-10-16 10:00:00"        —— 部分浏览器（尤其 Safari）解析不了，
 *                                                需要把日期分隔符换成 "/" 再试
 *
 * 注意不能无脑 replace：对 ISO 串做替换会得到 "2026/10/16T04:23:12.000Z"，
 * 那是非法日期，会导致所有 ISO 时间都解析失败（实测踩过）。
 */
function parseTime(v) {
  if (typeof v === 'number') return v
  const s = String(v || '').trim()
  if (!s) return NaN
  // 先按标准格式试
  let ts = new Date(s).getTime()
  if (Number.isFinite(ts)) return ts
  // 再按 MacCMS 的 "YYYY-MM-DD HH:mm:ss" 试
  ts = new Date(s.replace(/-/g, '/')).getTime()
  return Number.isFinite(ts) ? ts : NaN
}

/** 更新时间新鲜度（越近越高，30 天内线性衰减） */
export function freshnessToScore(updatedAt, now = Date.now()) {
  const ts = parseTime(updatedAt)
  if (!Number.isFinite(ts)) return 0
  const days = (now - ts) / 86400000
  if (days < 0) return 1
  if (days >= 30) return 0
  return 1 - days / 30
}

/**
 * 单条影片的综合热度分
 * 权重设计意图：
 *   hits  0.55 —— 真实播放量是最强的热度信号
 *   score 0.25 —— 口碑，作为 hits 缺失时的主要替补
 *   新鲜度 0.20 —— 影视是时效性内容
 */
export function popularityScore(vod, now = Date.now()) {
  const hits = hitsToScore(vod?.hits)
  const score = scoreToScore(vod?.score)
  const fresh = freshnessToScore(vod?.updatedAt, now)
  const base = hits * 0.55 + score * 0.25 + fresh * 0.2
  return base * qualityFactor(vod)
}

/**
 * 排序并按源交错合并
 *
 * 为什么要交错而不是全局排序：
 *   只有两个源提供 hits。若直接全局按 hits 排，另外三个源的内容会全部沉底，
 *   首页就只剩爱奇艺和魔都——违背了多源冗余的设计目的，也减少了可播片源。
 *   所以先在各源内部排序，再轮流取，保证每个源都有曝光机会，
 *   同时让「有真实热度」的内容优先出现在前面。
 *
 * @param {Array} vods 已归一化的影片
 * @param {object} opts
 *   limit      返回条数上限。默认不截断（排序函数的职责是排序，不该隐式丢数据，
 *              需要截断由调用方显式传入）
 *   perSource  每源在首轮各取多少条（默认 2，即先保证每个源都有曝光）
 */
export function rankVods(vods, { limit = Infinity, now = Date.now(), perSource = 2 } = {}) {
  if (!Array.isArray(vods) || !vods.length) return []

  // 按源分组并各自排序
  const groups = new Map()
  vods.forEach((v) => {
    const k = v.sourceKey || '__unknown'
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(v)
  })

  const sorted = [...groups.entries()].map(([key, list]) => [
    key,
    list
      .map((v) => ({ v, s: popularityScore(v, now) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.v),
  ])

  // 第一轮：每个源各取 perSource 条，交错
  const out = []
  const cursors = new Map(sorted.map(([k]) => [k, 0]))
  for (let round = 0; round < perSource; round++) {
    for (const [key, list] of sorted) {
      const c = cursors.get(key)
      if (c < list.length && out.length < limit) {
        out.push(list[c])
        cursors.set(key, c + 1)
      }
    }
  }

  // 第二轮起：把剩余内容按分数全局排序补齐（避免交错导致整体无序）
  if (out.length < limit) {
    const rest = []
    for (const [key, list] of sorted) {
      for (let i = cursors.get(key); i < list.length; i++) rest.push(list[i])
    }
    rest.sort((a, b) => popularityScore(b, now) - popularityScore(a, now))
    for (const v of rest) {
      if (out.length >= limit) break
      out.push(v)
    }
  }

  return out.slice(0, limit)
}

/**
 * 打分：用于跨源合并时挑主记录
 *
 * 与 media.js 的 scoreVod 配合：那边按「线路多、集数全、字段完整」评估，
 * 这里补上热度维度，让有真实播放量的源成为主记录
 * （这样「N 源」角标、线路列表会更倾向于可播且热门的那个源）。
 */
export function popularityBoost(vod, now = Date.now()) {
  return popularityScore(vod, now) * 400
}

export const POPULARITY_TUNING = {
  weights: { hits: 0.55, score: 0.25, freshness: 0.2 },
  lowQualityPatterns: LOW_QUALITY_PATTERNS.map((r) => r.source),
  freshnessWindowDays: 30,
  hitsCap: 50000,
}
