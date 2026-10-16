/**
 * 采集源配置管理（支持远程更新）
 * ================================
 * 为什么必须做这个
 * ----------------
 * 采集源换域名极其频繁（实测 60 个源里 5 个已彻底失效）。
 * 如果源列表硬编码打进 APK，换一次域名就得重新发版让用户手动更新 —— 不可维护。
 *
 * 所以把源列表做成「可远程更新」的三层结构：
 *   1. 内置默认（打包进 App，保证首次可用）
 *   2. 远程配置（从 URL 拉取，换域名只需改这个 JSON）
 *   3. 用户手动覆盖（App 内粘贴，应急用）
 *
 * 生效优先级：手动覆盖 > 远程配置 > 内置默认
 *
 * 关于浏览器环境的限制
 * --------------------
 * 浏览器版的请求必须经服务端代理（CORS 限制），而代理的 location 是按内置源列表
 * 生成的。所以浏览器版改了源列表需要重新生成服务端配置：
 *     node scripts/gen-nginx.mjs
 * 原生 App 直连源站，没有这个限制。
 */

import { BUNDLED_SOURCES, COLLECT_PREFIX } from './sources.js'
import { isNative } from './transport.js'

const STORE_KEY = 'pmv:sourcesConfig'

/** 远程配置 JSON 的结构约定 */
const CONFIG_SHAPE = {
  version: 'number  配置版本，便于判断是否有更新',
  updatedAt: 'string  更新时间（展示用）',
  sources: 'array   采集源列表，字段与 sources.js 的 BUNDLED_SOURCES 一致',
}

/* ------------------------------------------------------------------ *
 * 存储读写
 * ------------------------------------------------------------------ */

function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeStore(v) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v))
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 源列表校验（远程配置不可信，必须校验后再用）
 * ------------------------------------------------------------------ */

/**
 * 校验并规范一个源对象
 * @returns {object|null} 合法则返回规范化对象，否则 null
 */
function normalizeSource(s) {
  if (!s || typeof s !== 'object') return null
  const key = String(s.key || '').trim()
  const api = String(s.api || '').trim()
  if (!key || !api) return null
  // key 会进 URL 路径与 nginx location，必须限制字符集
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(key)) return null
  if (!/^https?:\/\//i.test(api)) return null
  return {
    key,
    name: String(s.name || key).trim().slice(0, 40),
    api,
    enabled: s.enabled !== false,
    weight: Number.isFinite(Number(s.weight)) ? Number(s.weight) : 50,
    note: String(s.note || '').trim().slice(0, 200),
  }
}

/**
 * 校验整份配置
 * @returns {{ok:boolean, sources:Array, error:string}}
 */
export function validateConfig(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, sources: [], error: '配置不是对象' }
  }
  const list = Array.isArray(payload) ? payload : payload.sources
  if (!Array.isArray(list)) {
    return { ok: false, sources: [], error: '缺少 sources 数组' }
  }
  const seen = new Set()
  const sources = []
  for (const raw of list) {
    const s = normalizeSource(raw)
    if (!s) continue
    if (seen.has(s.key)) continue // key 重复会导致相互覆盖，直接丢弃后一个
    seen.add(s.key)
    sources.push(s)
  }
  if (!sources.length) {
    return { ok: false, sources: [], error: '没有任何合法的源（需含 key 与 api）' }
  }
  return { ok: true, sources, error: '' }
}

/* ------------------------------------------------------------------ *
 * 生效的源列表
 * ------------------------------------------------------------------ */

let activeCache = null

/** 计算当前生效的源列表（带缓存，配置变更时失效） */
export function getActiveSources() {
  if (activeCache) return activeCache
  const store = readStore()
  if (store?.sources?.length) {
    const v = validateConfig({ sources: store.sources })
    if (v.ok) {
      activeCache = v.sources
      return activeCache
    }
  }
  activeCache = BUNDLED_SOURCES.map(normalizeSource).filter(Boolean)
  return activeCache
}

/** 清缓存（配置变更后必须调用） */
function invalidate() {
  activeCache = null
}

/** 参与聚合的源，按 weight 降序 */
export function enabledSources() {
  return getActiveSources()
    .filter((s) => s.enabled)
    .sort((a, b) => b.weight - a.weight)
}

/** 按 key 取源 */
export function getSource(key) {
  return getActiveSources().find((s) => s.key === key) || null
}

/** 当前配置的来源与状态（供设置页展示） */
export function getConfigMeta() {
  const store = readStore()
  if (!store) {
    return {
      origin: 'bundled',
      originLabel: '内置默认',
      updatedAt: '',
      count: getActiveSources().length,
      enabled: enabledSources().length,
    }
  }
  const label =
    store.origin === 'manual' ? '手动导入' : store.origin === 'remote' ? '远程更新' : '内置默认'
  return {
    origin: store.origin || 'bundled',
    originLabel: label,
    remoteUrl: store.remoteUrl || '',
    updatedAt: store.updatedAt || '',
    count: getActiveSources().length,
    enabled: enabledSources().length,
  }
}

/* ------------------------------------------------------------------ *
 * 更新配置
 * ------------------------------------------------------------------ */

/** 当前配置是浏览器还是原生（决定改动后是否需要重生成服务端配置） */
export function requiresServerSync() {
  return !isNative()
}

/**
 * 从远程 URL 拉取配置
 * @param {string} url 配置 JSON 地址
 */
export async function refreshFromRemote(url, { timeout = 15000 } = {}) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('配置地址必须是 http/https 链接')
  }
  let text
  try {
    const resp = await fetch(target, { signal: AbortSignal.timeout(timeout) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    text = await resp.text()
  } catch (err) {
    throw new Error(`拉取配置失败: ${err?.message || err}`)
  }

  let payload
  try {
    payload = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new Error(`配置不是合法 JSON: ${err.message}`)
  }

  const v = validateConfig(payload)
  if (!v.ok) throw new Error(`配置校验失败: ${v.error}`)

  writeStore({
    origin: 'remote',
    remoteUrl: target,
    updatedAt: payload.updatedAt || new Date().toISOString(),
    version: payload.version || 0,
    sources: v.sources,
  })
  invalidate()
  return v.sources
}

/**
 * 手动导入配置（粘贴 JSON 文本）
 * @param {string} jsonText
 */
export function applyManualConfig(jsonText) {
  let payload
  try {
    payload = JSON.parse(String(jsonText || '').replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new Error(`不是合法 JSON: ${err.message}`)
  }
  const v = validateConfig(payload)
  if (!v.ok) throw new Error(`配置校验失败: ${v.error}`)
  writeStore({
    origin: 'manual',
    updatedAt: new Date().toISOString(),
    sources: v.sources,
  })
  invalidate()
  return v.sources
}

/** 恢复内置默认 */
export function resetToBundled() {
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* 忽略 */
  }
  invalidate()
  return getActiveSources()
}

/** 单个源的开/关（临时调整，不改变配置来源） */
export function toggleSourceEnabled(key, enabled) {
  const sources = getActiveSources().map((s) =>
    s.key === key ? { ...s, enabled: Boolean(enabled) } : s
  )
  const store = readStore() || {}
  writeStore({
    origin: store.origin || 'bundled',
    remoteUrl: store.remoteUrl || '',
    updatedAt: store.updatedAt || '',
    sources,
  })
  invalidate()
  return sources
}

/** 导出当前配置（便于分享给别人或备份） */
export function exportConfig() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    sources: getActiveSources(),
  }
}

/** 配置模板说明（设置页展示用） */
export const CONFIG_DOC = CONFIG_SHAPE

export { COLLECT_PREFIX }
