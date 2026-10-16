/**
 * 苹果CMS（MacCMS v10）采集协议客户端
 * =====================================
 * 只负责「按协议发请求 + 按协议解析」，不做业务编排（那是 index.js 的事）。
 *
 * 协议要点
 * --------
 * 请求：
 *   ?ac=list            分类表 + 分页信息
 *   ?ac=detail          详情（含播放地址）
 *   &pg=1               页码
 *   &t=<type_id>        按分类
 *   &h=24               最近 N 小时更新（增量）
 *   &ids=1,2,3          指定 ID
 *   &wd=<关键词>         搜索
 *
 * 返回：
 *   { code:1, page, pagecount, limit, total, class:[...], list:[...] }
 *
 * 播放地址分隔符（最容易写错的地方）：
 *   vod_play_from = "线路A$$$线路B"              ← 线路之间用 $$$
 *   vod_play_url  = "第1集$url#第2集$url$$$第1集$url"
 *                       ↑      ↑        ↑
 *                   集名与地址  集之间   线路之间
 *
 * 重要现实：多数源同时提供两类线路
 *   1) 解析线路（如 "liangzi"）：地址形如 https://host/share/<hash>，需要网页解析才能取到流
 *   2) 直链线路（如 "lzm3u8"）：地址以 .m3u8 结尾，可直接交给播放器
 * 因此解析后必须给每条线路打上 playable 标记，播放时优先选直链线路。
 */

import {
  request as transportRequest,
  parseJson,
  TransportError,
  REQUEST_TIMEOUT,
} from './transport.js'
import { enabledSources, getSource, getActiveSources } from './config.js'
import { readCache, writeCache } from './cache.js'

/**
 * 分类表请求的独立超时
 *
 * 分类表是最慢的接口（实测最慢 20 秒），而它只是用来把语义分组翻译成
 * type_id。等超过 7 秒还不如先把这个源跳过 —— 少一个源不影响首页可用性。
 */
const CLASS_TIMEOUT = 7000

/** 分类表缓存：源站分类基本不变，缓存可显著减少请求 */
const classCache = new Map()
/** 同源分类表请求进行中的 Promise，用于并发去重（见 getClasses 说明） */
const classInflight = new Map()
const CLASS_CACHE_TTL = 30 * 60 * 1000

export class MaccmsError extends Error {
  constructor(message, { source, cause } = {}) {
    super(message)
    this.name = 'MaccmsError'
    this.source = source
    this.cause = cause
  }
}

/**
 * 请求某个采集源
 *
 * 实际传输方式由 transport.js 按运行环境决定：
 *   浏览器 → 同源代理 /collect/<key>（绕 CORS）
 *   原生 App → Capacitor 原生 HTTP 直连源站（无需服务器）
 *
 * @param {object|string} source 源对象或 key
 * @param {object} params 协议参数，如 { ac:'detail', pg:1 }
 */
export async function request(source, params, { timeout = REQUEST_TIMEOUT, signal } = {}) {
  const src = typeof source === 'string' ? getSource(source) : source
  if (!src) throw new MaccmsError(`未知的采集源: ${source}`)

  let res
  try {
    res = await transportRequest(src, params, { timeout, signal })
  } catch (err) {
    const msg = err instanceof TransportError ? err.message : `网络错误: ${err?.message || err}`
    throw new MaccmsError(msg, { source: src.key, cause: err })
  }

  let data
  try {
    data = parseJson(res.text, src.key)
  } catch (err) {
    throw new MaccmsError(err.message, { source: src.key, cause: err })
  }

  if (data.code !== 1 && data.code !== 200) {
    throw new MaccmsError(data.msg || `源返回 code=${data.code}`, { source: src.key })
  }
  return { data, source: src, upstreamMs: res.upstreamMs, via: res.via }
}

/**
 * 取分类表（带缓存 + 并发去重）
 *
 * 并发去重为什么必要：
 *   首页要拿 3 个分组（动漫/电视剧/电影），每个分组都会调 getClasses。
 *   三个调用几乎同时发生，都发现缓存为空 → 都发请求。
 *   实测每源发了 4 次 ac=list（应为 1 次），28 次请求里有 24 次是浪费的，
 *   而 ac=list 恰恰是最慢的接口（最慢单次 20 秒）。
 *   这里让并发调用共享同一个 Promise。
 *
 * @returns {Promise<Array<{type_id:number, type_pid:number, type_name:string}>>}
 */
export async function getClasses(source, { force = false } = {}) {
  const src = typeof source === 'string' ? getSource(source) : source
  if (!src) return []

  const persistKey = `classes:${src.key}`

  if (!force) {
    const cached = classCache.get(src.key)
    if (cached && Date.now() - cached.at < CLASS_CACHE_TTL) {
      return cached.data
    }
    // 并发去重：已有同源请求在跑就直接复用
    const inflight = classInflight.get(src.key)
    if (inflight) return inflight
    // 内存没有 → 查落盘（跨 App 启动保留）
    const stored = readCache(persistKey)
    if (stored && !stored.stale && Array.isArray(stored.value) && stored.value.length) {
      classCache.set(src.key, { at: Date.now(), data: stored.value })
      return stored.value
    }
  }

  const task = (async () => {
    try {
      // 这里显式传超时：不传就会用 transport 的默认值（12 秒），
      // 而分类表请求由多个调用方共享，一个源卡住会连累整个首屏。
      const { data } = await request(src, { ac: 'list' }, { timeout: CLASS_TIMEOUT })
      const classes = (data.class || []).map((c) => ({
        type_id: Number(c.type_id),
        type_pid: Number(c.type_pid || 0),
        type_name: String(c.type_name || '').trim(),
      }))
      // 空结果不缓存，保留重试机会（有的源偶发返回空表或 HTML 错误页）
      if (classes.length) {
        classCache.set(src.key, { at: Date.now(), data: classes })
        writeCache(persistKey, classes, CLASS_CACHE_TTL)
      }
      return classes
    } finally {
      classInflight.delete(src.key)
    }
  })()

  classInflight.set(src.key, task)
  return task
}

/**
 * 解析播放地址
 *
 * @param {string} playFrom  vod_play_from，形如 "liangzi$$$lzm3u8"
 * @param {string} playUrl   vod_play_url
 * @returns {Array<{
 *   key: string,          // 线路标识（来自 play_from）
 *   name: string,         // 展示名
 *   playable: boolean,    // 是否含直链 m3u8（false 表示需要网页解析）
 *   episodes: Array<{ name: string, url: string }>
 * }>}
 */
export function parsePlayUrl(playFrom, playUrl) {
  const fromList = String(playFrom || '').split('$$$')
  const urlBlocks = String(playUrl || '').split('$$$')
  const lines = []

  urlBlocks.forEach((block, index) => {
    if (!block.trim()) return
    const episodes = []
    block
      .split('#')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((seg) => {
        // 集名与地址以第一个 '$' 分隔；有的源没有集名，整段就是地址
        const pos = seg.indexOf('$')
        let name = ''
        let url = seg
        if (pos > -1) {
          name = seg.slice(0, pos).trim()
          url = seg.slice(pos + 1).trim()
        }
        if (!url) return
        episodes.push({ name: name || `第${episodes.length + 1}集`, url })
      })
    if (!episodes.length) return

    const rawKey = (fromList[index] || `line${index + 1}`).trim()
    // 判断是否直链可播：整条线路里出现 m3u8 即认为可播
    const playable = episodes.some((e) => isDirectPlayable(e.url))
    lines.push({
      key: rawKey || `line${index + 1}`,
      name: prettyLineName(rawKey, index, playable),
      rawName: rawKey,
      playable,
      episodes,
    })
  })

  return lines
}

/** 是否为可直连播放的地址（m3u8 / mp4） */
export function isDirectPlayable(url) {
  return /\.(m3u8|mp4)(\?|#|$)/i.test(url || '')
}

/** 把源里的线路代号美化成界面可读文本 */
function prettyLineName(rawKey, index, playable) {
  const alias = {
    lzm3u8: '量子·直链',
    liangzi: '量子·解析',
    ffm3u8: '非凡·直链',
    feifan: '非凡·解析',
    dyttm3u8: '天堂·直链',
    dytt: '天堂·解析',
    iqym3u8: '爱奇艺·直链',
    hhm3u8: '豪华·直链',
    hhyun: '豪华·云播',
    tpm3u8: '淘片·直链',
    tpiframe: '淘片·内嵌',
    modum3u8: '魔都·直链',
  }
  if (alias[rawKey]) return alias[rawKey]
  if (!rawKey) return `线路 ${index + 1}`
  return playable ? `${rawKey}（直链）` : `${rawKey}（需解析）`
}

/** 取详情列表（ac=detail） */
export async function detail(source, params = {}, opts = {}) {
  const query = { ac: 'detail', ...params }
  const { data, source: src, upstreamMs } = await request(source, query, opts)
  const lines = (data.class || []).length
    ? data.class.map((c) => ({
        type_id: Number(c.type_id),
        type_pid: Number(c.type_pid || 0),
        type_name: String(c.type_name || '').trim(),
      }))
    : []
  if (lines.length) classCache.set(src.key, { at: Date.now(), data: lines })
  return {
    list: Array.isArray(data.list) ? data.list : [],
    page: Number(data.page) || Number(params.pg) || 1,
    pageCount: Number(data.pagecount) || 1,
    total: Number(data.total) || 0,
    upstreamMs,
    source: src,
  }
}

/** 列表（按分类 / 最新） */
export function list(source, { page = 1, typeId, hours } = {}, opts = {}) {
  const params = { pg: page }
  if (typeId != null && typeId !== '') params.t = typeId
  if (hours != null) params.h = hours
  return detail(source, params, opts)
}

/** 搜索 */
export function search(source, { keyword, page = 1 }, opts = {}) {
  return detail(source, { wd: keyword, pg: page }, opts)
}

/** 按 ID 精确取（用于跨源补全同一部片子） */
export function detailByIds(source, ids, opts = {}) {
  return detail(source, { ids: [].concat(ids).join(',') }, opts)
}

/** 清空分类缓存（切源或调试用） */
export function clearClassCache() {
  classCache.clear()
}
