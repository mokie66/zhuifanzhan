/**
 * 数据归一化：苹果CMS 原始字段 → 前端统一模型
 * =============================================
 * 采集源的字段命名遵循 MacCMS 规范（vod_name / vod_pic / vod_play_url ...），
 * 但各源并非严格遵守：有的缺 vod_actor，有的 score 是字符串带空格，
 * 有的把简介塞在 vod_blurb 而不是 vod_content。
 * 这里统一收敛成前端模型，视图层只认这个模型。
 */

import { parsePlayUrl, isDirectPlayable } from '@/api/maccms.js'
import { isNative } from '@/api/transport.js'
import { hitsToScore, scoreToScore } from '@/api/rank.js'

/** 去掉 HTML 标签、多余空白 */
export function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function toNum(v, fallback = 0) {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : fallback
}

/**
 * 归一化单条影片
 * @param {object} raw  采集源返回的原始对象
 * @param {object} source 所属源
 */
export function normalizeVod(raw, source) {
  if (!raw || typeof raw !== 'object') return null

  const title = stripHtml(raw.vod_name || raw.name || '')
  if (!title) return null // 没有片名的数据无法使用

  const lines = parsePlayUrl(raw.vod_play_from, raw.vod_play_url)
  const playableLines = lines.filter((l) => l.playable)
  const totalEpisodes = Math.max(
    toNum(raw.vod_total),
    lines.reduce((max, l) => Math.max(max, l.episodes.length), 0)
  )

  const scoreRaw = String(raw.vod_score ?? '').trim()
  const score = toNum(scoreRaw)
  const doubanScore = toNum(raw.vod_douban_score)

  return {
    // 标识
    id: String(raw.vod_id ?? raw.id ?? ''),
    sourceKey: source?.key || '',
    sourceName: source?.name || '',

    // 基本信息
    title,
    sub: stripHtml(raw.vod_sub),
    originalTitle: stripHtml(raw.vod_en),
    year: String(raw.vod_year || '').trim(),
    area: stripHtml(raw.vod_area),
    lang: stripHtml(raw.vod_lang),
    categoryName: stripHtml(raw.type_name || raw.type),
    categoryId: toNum(raw.type_id),
    categoryGroup: toNum(raw.type_id_1),

    // 图片
    poster: String(raw.vod_pic || raw.pic || '').trim(),
    slidePic: String(raw.vod_pic_slide || '').trim(),

    // 评分与状态
    score: score > 0 ? score : doubanScore > 0 ? doubanScore : 0,
    remarks: stripHtml(raw.vod_remarks || raw.note),
    isEnd: toNum(raw.vod_isend) === 1,
    totalEpisodes,
    hits: toNum(raw.vod_hits),

    // 人员与简介
    actors: stripHtml(raw.vod_actor || raw.actor),
    director: stripHtml(raw.vod_director || raw.director),
    intro: stripHtml(raw.vod_content || raw.des) || stripHtml(raw.vod_blurb),

    // 时间
    updatedAt: String(raw.vod_time || raw.last || '').trim(),

    // 播放
    lines,
    playableLines,
    episodeCount: totalEpisodes,
    playable: playableLines.length > 0,
  }
}

/** 批量归一化，自动丢弃无效项 */
export function normalizeVodList(list, source) {
  return (Array.isArray(list) ? list : [])
    .map((raw) => normalizeVod(raw, source))
    .filter(Boolean)
}

/**
 * 列表项瘦身：去掉只服务详情页的重字段
 *
 * 为什么必须做
 * ------------
 * 合并后的列表项带着 allLines / mirrors / lines / playableLines，
 * 实测这四项占单条体积的 99.4%（24 条共 1739 KB，其余字段只有约 10 KB）。
 * 把这种数据写进 localStorage 有两个后果：
 *   1. 逼近 5MB 配额，可能直接写失败（缓存就白做了）
 *   2. 每次 stringify/parse 1.7MB，耗时抵消掉缓存本该带来的收益
 *
 * 安全性
 * ------
 * 列表视图（首页/分类/搜索）只用到封面、标题、评分、简介、线路数角标；
 * 真正的线路数据由详情页通过 getDetail() 重新拉取，不依赖列表项。
 * 所以这里去掉是安全的。
 *
 * 采用「去掉已知的重字段」而不是「白名单保留」：前者在新增字段时
 * 不会因为忘记加白名单而丢数据。
 */
const HEAVY_VOD_FIELDS = ['lines', 'playableLines', 'allLines']

export function slimVod(vod) {
  if (!vod || typeof vod !== 'object') return vod
  const out = { ...vod }
  for (const f of HEAVY_VOD_FIELDS) delete out[f]
  // mirrors 保留轻量摘要：MediaCard / SearchView 用 mirrors.length 显示「N 源」角标
  if (Array.isArray(vod.mirrors)) {
    out.mirrors = vod.mirrors.map((m) => ({
      sourceKey: m.sourceKey,
      sourceName: m.sourceName,
    }))
  }
  return out
}

export function slimVodList(list) {
  return Array.isArray(list) ? list.map(slimVod) : []
}

/** 片名归一：用于跨源去重比对 */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    // 去掉常见的季数/画质后缀，避免同一部片因标题差异被判为不同
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/(第[一二三四五六七八九十\d]+季|season\s*\d+|全\d+集|\d+集全?)/gi, '')
    .replace(/[·・:：\-—_.,，。!！?？"'"'`~]/g, '')
}

/**
 * 跨源合并去重
 *
 * 同一个片名可能出现在多个源。合并策略：
 *   1. 优先保留「可播放线路更多 + 集数更全 + 源权重更高」的那条作为主记录
 *   2. 把其他源的同名片记录挂到 mirrors 上，供「换源」功能使用
 *
 * @param {Array} vods 已归一化的影片数组
 * @param {Array} sources 源列表（用于取 weight）
 */
export function mergeVods(vods, sources = []) {
  const weightOf = new Map(sources.map((s) => [s.key, s.weight || 0]))
  const buckets = new Map()

  vods.forEach((v) => {
    const key = normalizeTitle(v.title)
    if (!key) return
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(v)
  })

  const merged = []
  buckets.forEach((group) => {
    group.sort((a, b) => scoreVod(b, weightOf) - scoreVod(a, weightOf))
    const primary = { ...group[0] }
    primary.mirrors = group.slice(1).map((m) => ({
      sourceKey: m.sourceKey,
      sourceName: m.sourceName,
      id: m.id,
      playable: m.playable,
      episodeCount: m.episodeCount,
      lines: m.lines,
    }))
    // 主记录与其他源线路合并，让播放器的线路列表更丰富
    const allLines = []
    group.forEach((g, gi) => {
      g.lines.forEach((l) => {
        allLines.push({ ...l, sourceKey: g.sourceKey, sourceName: g.sourceName, mirrored: gi > 0 })
      })
    })
    primary.allLines = allLines
    merged.push(primary)
  })

  // 排序：可播的优先，其次源权重、集数
  merged.sort((a, b) => {
    if (a.playable !== b.playable) return a.playable ? -1 : 1
    const wa = weightOf.get(a.sourceKey) || 0
    const wb = weightOf.get(b.sourceKey) || 0
    if (wa !== wb) return wb - wa
    return b.episodeCount - a.episodeCount
  })

  return merged
}

/** 给单条影片打分，用于去重时选主记录 */
function scoreVod(v, weightOf) {
  let s = 0
  s += (weightOf.get(v.sourceKey) || 0) * 10
  s += v.playableLines.length * 500 // 可播线路数是第一优先级
  s += Math.min(v.episodeCount, 200) * 2
  if (v.poster) s += 30
  if (v.intro) s += 20
  if (v.actors) s += 10
  // 热度：用对数刻度而非线性。
  // 实测 hits 跨度 2 ~ 44029，线性会让单条高播放量数据权重过大，
  // 且多数源 hits 为 0，线性会直接把它们压到最低，不利于多源冗余。
  s += hitsToScore(v.hits) * 300
  s += scoreToScore(v.score) * 120
  return s
}

/** 取用于列表展示的播放地址（优选直链线路的第一集） */
export function pickPlayable(vod, episodeIndex = 0) {
  const line = (vod.playableLines || [])[0]
  if (!line) return null
  const ep = line.episodes[episodeIndex] || line.episodes[0]
  if (!ep) return null
  return { line, episode: ep, index: line.episodes.indexOf(ep) }
}

/**
 * 判断地址是否需要走流代理
 *
 * 浏览器：https 页面加载 http 资源会被混合内容策略拦掉，需要套 /collect/_stream
 * 原生 App：Capacitor 允许混合内容（配置 android.allowMixedContent），
 *          且 App 里根本没有 /collect 代理，所以直接返回原地址
 */
export function needsStreamProxy(url) {
  if (typeof window === 'undefined') return false
  if (isNative()) return false
  return window.location.protocol === 'https:' && String(url).startsWith('http://')
}

/** 生成最终可播放的地址（必要时套一层流代理） */
export function resolvePlayUrl(url) {
  if (!needsStreamProxy(url)) return url
  return `/collect/_stream?url=${encodeURIComponent(url)}`
}

export { isDirectPlayable }
