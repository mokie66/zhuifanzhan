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
 * 热门榜单排序
 * ==============
 * 与 rankVods 的区别（两者用途不同，不要混用）
 * --------------------------------------------
 * rankVods（「最新」场景）：
 *   目的是「多源都有曝光」—— 各源内部排序后交错取数。
 *   但交错会强制每个源都出几条，把没有热度数据、只有批量动态漫的源也塞进来。
 *   用在「最新更新」列表上没问题，用在「爆火榜单」上就是错的。
 *
 * rankHot（本函数，「热门」场景）：
 *   目的是「只留真正热的」—— 不做无差别交错。
 *
 * 为什么按「源内排名」而不是原始 hits 直接比较
 * ------------------------------------------
 * 各源 hits 量级完全不同（实测同一天：魔都《遮天》126159，爱奇艺《无可替代》6599），
 * 直接跨源比较会让魔都一家霸榜，其实只是两家统计口径不同，不代表真实热度差 19 倍。
 * 所以先在各源内部按 hits 排名，再按「名次」交错 —— 相当于比较
 * 「在各自平台上的热门程度」，这样既公平又能避免单源垄断。
 *
 * 没有 hits 的源会被排除在热门榜之外（它们的 hits 恒为 0，无法参与热度排序），
 * 只在数量不够时用评分/时效兜底补位。
 */
export function rankHot(vods, { limit = 12, now = Date.now() } = {}) {
  if (!Array.isArray(vods) || !vods.length) return []

  const groups = new Map()
  vods.forEach((v) => {
    const k = v.sourceKey || '__unknown'
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(v)
  })

  // 每个源内部按 hits 排序；同时判断该源是否「有热度数据」
  const rankedBySource = []
  for (const [key, list] of groups.entries()) {
    const withHits = list.filter((v) => (Number(v.hits) || 0) > 0)
    if (!withHits.length) continue // 无热度数据 → 不参与热门榜
    withHits.sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0))
    rankedBySource.push([key, withHits])
  }

  // 无任何源提供热度数据 → 退化为按评分/时效排序，至少不是随机的
  if (!rankedBySource.length) {
    return [...vods]
      .sort((a, b) => popularityScore(b, now) - popularityScore(a, now))
      .slice(0, limit)
  }

  // 先按名次交错，保证多个有热度数据的源都能出现（避免单源垄断）
  const out = []
  const maxLen = Math.max(...rankedBySource.map(([, l]) => l.length))
  for (let rank = 0; rank < maxLen && out.length < limit; rank++) {
    for (const [, list] of rankedBySource) {
      if (rank < list.length && out.length < limit) out.push(list[rank])
    }
  }

  return out.slice(0, limit)
}

/* ------------------------------------------------------------------ *
 * 搜索结果相关性排序
 * ------------------------------------------------------------------ */

/** 归一化：去掉空格与常见分隔符，便于做「连续子串」判断 */
function normForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
}

/**
 * 匹配强度分层
 *
 * 为什么必须分层而不是简单「包含即算匹配」：
 *   搜「仙逆」时，
 *     《短剧仙逆》《凡人仙逆传》  标题里真的连着出现「仙逆」→ 强匹配
 *     《九尾猫·仙逆》            也连着出现                  → 强匹配
 *     《逆仙而上》               两个字都在，但顺序反了      → 弱匹配
 *     《剑仙归来…剑仙逆世重修…》  两个字分散在不同词里        → 弱匹配
 *   采集源返回的顺序是各源结果拼接的，完全没考虑这个差别，
 *   于是「逆仙而上」会排在「凡人仙逆传」前面，用户会觉得搜得不准。
 *
 * 分层（数值越大越强）：
 *   4 标题与关键词完全一致
 *   3 标题以关键词开头
 *   2 标题包含关键词（连续子串）
 *   1 关键词的字都出现但被打散
 *   0 只出现部分字
 */
export function matchTier(title, keyword) {
  const t = normForMatch(title)
  const k = normForMatch(keyword)
  if (!t || !k) return { tier: 0, sub: 0 }

  if (t === k) return { tier: 4, sub: 0 }

  const idx = t.indexOf(k)
  if (idx === 0) {
    // 前缀匹配：标题越短，说明关键词占的比重越大，越相关
    return { tier: 3, sub: Math.max(0, 400 - t.length * 2) }
  }
  if (idx > 0) {
    // 包含：出现位置越靠前、标题越短越相关
    return { tier: 2, sub: Math.max(0, 400 - idx * 6 - t.length * 2) }
  }

  // 连续子串都没有 → 看字的覆盖度
  const chars = [...new Set(k)]
  const hit = chars.filter((c) => t.includes(c)).length
  const ratio = hit / chars.length
  if (ratio >= 1) return { tier: 1, sub: Math.max(0, 200 - t.length) }
  return { tier: 0, sub: Math.round(ratio * 200) }
}

/**
 * 搜索结果排序：强匹配优先，弱匹配靠后
 *
 * 同层内用热度做次级排序（都不相关时，热门的至少更可能有价值）。
 * 相关性权重远高于热度 —— 热度高的不相关结果排在前面才是真的搜不准。
 *
 * @param {Array} list 已合并去重的影片
 * @param {string} keyword 用户输入
 */
export function rankSearchResults(list, keyword, { now = Date.now() } = {}) {
  if (!Array.isArray(list) || !list.length) return list || []
  const kw = String(keyword || '').trim()
  if (!kw) return list

  const scored = list.map((v, i) => {
    const { tier, sub } = matchTier(v.title, kw)
    return { v, tier, sub, hot: popularityScore(v, now), i }
  })

  scored.sort((a, b) => {
    // 1. 匹配层级（决定性）
    if (b.tier !== a.tier) return b.tier - a.tier
    // 2. 层内位置/长度差异
    if (b.sub !== a.sub) return b.sub - a.sub
    // 3. 热度
    if (Math.abs(b.hot - a.hot) > 1e-9) return b.hot - a.hot
    // 4. 保持原有顺序，避免排序不稳定导致的抖动
    return a.i - b.i
  })

  return scored.map((x) => x.v)
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
