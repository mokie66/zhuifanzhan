/**
 * 传输层抽象：让同一套代码适配「浏览器」与「原生 App」两种运行环境
 * ====================================================================
 * 为什么需要这一层
 * ----------------
 * 浏览器里调采集接口有两个限制：
 *   1. CORS —— 采集源不返回 Access-Control-Allow-Origin，浏览器直连被拦
 *   2. 混合内容 —— 部分源是 http，页面在 https 下同样被拦
 * 所以浏览器必须走同源代理 /collect/<key>（开发用 vite 中间件，生产用 nginx）。
 *
 * 原生 App（Capacitor）里这两个限制都不存在：
 *   请求由原生层发出，不经过 WebView 的同源策略，可以直接连采集源。
 * 于是 App 版**不需要任何服务器**——这正好绕开了备案与部署问题。
 *
 * 本模块把这层差异收敛到一个地方，上层（maccms.js）只调 request()，
 * 不关心自己跑在浏览器还是 App 里。
 */

import { proxyUrl } from './sources.js'

/** 请求超时（毫秒）。采集源普遍慢，给足余量。 */
/**
 * 默认单次请求超时（毫秒）
 *
 * 原值 20000 太长：实测最慢的采集源正好卡在 20 秒，意味着首屏要白等 20 秒。
 * 采集源正常响应在 300ms~6s，12 秒已经足够宽容；
 * 分类表这类「等不起」的请求另有更短的独立超时（见 maccms.js 的 CLASS_TIMEOUT）。
 */
export const REQUEST_TIMEOUT = 12000

/** 是否运行在原生 App（Capacitor）中 */
export function isNative() {
  if (typeof window === 'undefined') return false
  const cap = window.Capacitor
  if (!cap) return false
  // isNativePlatform 是 Capacitor 3+ 的 API；老版本用 platform 判断
  if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform()
  return cap.platform === 'android' || cap.platform === 'ios'
}

/** 当前运行环境标识，便于界面展示与排错 */
export function runtimeKind() {
  if (isNative()) return 'native'
  if (typeof window !== 'undefined') return 'browser'
  return 'node'
}

/**
 * 取 Capacitor 的原生 HTTP 实现。
 * 包没装（比如浏览器构建）时返回 null，调用方回退到普通 fetch。
 */
function getNativeHttp() {
  try {
    const cap = typeof window !== 'undefined' ? window.Capacitor : null
    const plugin = cap?.Plugins?.CapacitorHttp
    if (plugin && typeof plugin.get === 'function') return plugin
  } catch {
    /* 取不到就走 fetch */
  }
  return null
}

/** 把查询参数对象拼成查询串 */
function toQueryString(query) {
  if (!query) return ''
  const usp = new URLSearchParams()
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') usp.append(k, String(v))
  })
  const s = usp.toString()
  return s ? '?' + s : ''
}

export class TransportError extends Error {
  constructor(message, { source, status, cause } = {}) {
    super(message)
    this.name = 'TransportError'
    this.source = source
    this.status = status
    this.cause = cause
  }
}

/**
 * 可重试的 HTTP 状态码
 *
 * 实测爱奇艺的数据接口会间歇性返回 503（5 次里 2 次），
 * 而且是**快速失败**（335ms 就返回，不是超时）。
 * 这种瞬时故障重试一两次就能过，成本极低；
 * 不重试的话，热门榜会因为拿不到爱奇艺的数据而退化成「批量新番」。
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
/** 最多重试次数（不含首次） */
const MAX_RETRY = 2
/** 退避基数（毫秒），第 n 次重试等待 RETRY_BASE_MS * n */
const RETRY_BASE_MS = 280

/**
 * 发起一次采集请求，自动选择传输方式，并对瞬时故障重试
 *
 * @param {object} source 采集源对象（来自 sources.js）
 * @param {object} query  协议参数，如 { ac:'detail', pg:1 }
 * @param {object} opts   { timeout, signal }
 * @returns {Promise<{ text:string, status:number, upstreamMs:number, via:string }>}
 */
export async function request(source, query, opts = {}) {
  const { signal } = opts
  let lastErr = null

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (signal?.aborted) break
    try {
      return await requestOnce(source, query, opts)
    } catch (err) {
      lastErr = err
      // 只重试「明确的瞬时故障」；网络错误/超时不重试，避免把预算耗在死源上
      const retryable = err instanceof TransportError && RETRYABLE_STATUS.has(err.status)
      if (!retryable || attempt === MAX_RETRY) break
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * (attempt + 1)))
    }
  }

  throw lastErr || new TransportError('请求失败', { source: source?.key })
}

/** 单次请求（不做重试） */
async function requestOnce(source, query, opts = {}) {
  const { timeout = REQUEST_TIMEOUT, signal } = opts
  const qs = toQueryString(query)

  // ---- 原生 App：直接连采集源，无需代理 ----
  if (isNative()) {
    const http = getNativeHttp()
    const url = source.api.replace(/\/$/, '') + '/' + qs.replace(/^\?/, '?')
    const target = source.api + qs.replace(/^\?/, source.api.includes('?') ? '&' : '?')
    const finalUrl = source.api.includes('?')
      ? source.api + (qs ? '&' + qs.slice(1) : '')
      : source.api + qs

    if (http) {
      const t0 = Date.now()
      try {
        const res = await http.get({
          url: finalUrl,
          headers: {
            Accept: 'application/json, text/plain, */*',
            'User-Agent':
              'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          },
          connectTimeout: timeout,
          readTimeout: timeout,
        })
        return {
          text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data),
          status: res.status ?? 200,
          upstreamMs: Date.now() - t0,
          via: 'capacitor-http',
        }
      } catch (err) {
        throw new TransportError(`原生请求失败: ${err?.message || err}`, {
          source: source.key,
          cause: err,
        })
      }
    }

    // 包未装或插件不可用 —— 退回 fetch（此时仍可能被 CORS 拦，但至少能试）
    return fetchDirect(finalUrl, { timeout, signal, via: 'fetch-direct' })
  }

  // ---- 浏览器：走同源代理 ----
  const proxyPath = proxyUrl(source, query)
  return fetchDirect(proxyPath, { timeout, signal, via: 'proxy' })
}

/** 用 fetch 发请求并做超时控制 */
async function fetchDirect(url, { timeout, signal, via }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeout)
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason)
    else signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true })
  }

  const t0 = Date.now()
  let resp
  try {
    resp = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } })
  } catch (err) {
    clearTimeout(timer)
    const timedOut = ac.signal.aborted && !signal?.aborted
    throw new TransportError(timedOut ? `请求超时（${timeout}ms）` : `网络错误: ${err?.message || err}`, {
      cause: err,
    })
  }
  clearTimeout(timer)

  const text = await resp.text()
  if (!resp.ok) {
    throw new TransportError(`HTTP ${resp.status}`, { status: resp.status })
  }
  return {
    text,
    status: resp.status,
    upstreamMs: Number(resp.headers.get('X-Collect-Upstream-Ms')) || Date.now() - t0,
    via,
  }
}

/**
 * 解析响应体：容忍 BOM、尾逗号、字面控制字符等脏数据
 * （部分采集源的 JSON 并不严格合法）
 */
export function parseJson(text, sourceKey) {
  const s = (text || '').replace(/^\uFEFF/, '').trim()
  if (!s) throw new TransportError('响应为空', { source: sourceKey })
  if (s[0] !== '{' && s[0] !== '[') {
    throw new TransportError(
      `响应不是 JSON（前 60 字符: ${s.slice(0, 60)}）`,
      { source: sourceKey }
    )
  }
  try {
    return JSON.parse(s)
  } catch {
    try {
      const cleaned = s.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001F]+/g, ' ')
      return JSON.parse(cleaned)
    } catch (err) {
      throw new TransportError(`JSON 解析失败: ${err.message}`, { source: sourceKey })
    }
  }
}
