/**
 * 两级缓存：内存 + localStorage
 * ================================
 * 为什么需要持久化
 * ----------------
 * 原实现只有一个内存 Map，App 一关就清空。于是每次启动首页都是完整冷启动，
 * 实测要 20 秒（见 scripts/diagnose-home-perf.mjs）。用户的感受就是
 * 「每次进 App 都要等好久」。
 *
 * 持久化后：
 *   - 第二次起启动瞬间就能用上次的数据渲染（stale-while-revalidate）
 *   - 真正的请求在后台跑，用户几乎无感
 *
 * stale-while-revalidate 是什么
 * ----------------------------
 * 缓存分三段：
 *   [0, ttl)                 新鲜   → 直接用，不发请求
 *   [ttl, ttl*STALE_FACTOR)  过期但可用 → 立刻返回旧数据，同时后台刷新
 *   [ttl*STALE_FACTOR, ∞)    太旧   → 丢弃，走正常加载
 * 这样既有「秒开」，又不会让用户一直看到很旧的内容。
 */

const PREFIX = 'pmv:cache:'
/**
 * 缓存格式版本。字段结构变化时递增，旧缓存自动失效，
 * 避免升级后读到结构不匹配的数据而崩溃。
 */
const CACHE_VERSION = 1

/** 过期后仍可作为「旧数据」返回的倍数：ttl*8 */
export const STALE_FACTOR = 8

/** localStorage 配额有限（约 5MB），只持久化小体积、高价值的键 */
const PERSIST_KEYS = [
  'home:feed',
  'nav:categories',
  'latest:tv',
  'latest:anime',
  'latest:movie',
]

const memory = new Map()

function storage() {
  try {
    if (typeof localStorage === 'undefined') return null
    // 探针：隐私模式下 localStorage 可能存在但写入抛异常
    localStorage.setItem('pmv:probe', '1')
    localStorage.removeItem('pmv:probe')
    return localStorage
  } catch {
    return null
  }
}

const LS = storage()

function shouldPersist(key) {
  return PERSIST_KEYS.some((p) => key.startsWith(p))
}

/**
 * 读缓存
 * TTL 在写入时随记录一起存下来，读取时不需要再传 —— 这样调用方
 * 只要 cacheGet(key) / cacheSet(key, value, ttl) 两个动作，改动最小。
 * @returns {{value:any, stale:boolean}|null}
 *   stale=true 表示数据已过期但还能用，调用方应先渲染再后台刷新
 */
export function readCache(key) {
  const now = Date.now()

  /**
   * 校验并判定一条记录
   *
   * 注意 value 必须存在：writeCache 一定会写入 value，所以缺 value 只可能是
   * 数据损坏（写入中断、手工改动、旧版本残留）。这种情况必须当作「没有缓存」，
   * 否则 readCache 会返回 { value: undefined, stale: false } ——
   * 调用方（如 getHomeFeed）会把这个对象当成有效数据，界面直接空白。
   */
  const evaluate = (value, at, ttl) => {
    if (value === undefined) return null
    const age = now - at
    if (age < ttl) return { value, stale: false }
    if (age < ttl * STALE_FACTOR) return { value, stale: true }
    return null
  }

  // 1. 内存
  const mem = memory.get(key)
  if (mem) {
    const r = evaluate(mem.value, mem.at, mem.ttl)
    if (r) return r
    memory.delete(key)
  }

  // 2. 落盘
  if (!LS || !shouldPersist(key)) return null
  try {
    const raw = LS.getItem(PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed.v !== CACHE_VERSION || typeof parsed.ttl !== 'number') {
      LS.removeItem(PREFIX + key)
      return null
    }
    const r = evaluate(parsed.value, parsed.at, parsed.ttl)
    if (!r) {
      LS.removeItem(PREFIX + key)
      return null
    }
    // 回填内存，后续读取走快路径
    memory.set(key, { value: parsed.value, at: parsed.at, ttl: parsed.ttl })
    return r
  } catch {
    // 数据损坏：清掉，当作没有缓存
    try {
      LS.removeItem(PREFIX + key)
    } catch {
      /* 忽略 */
    }
    return null
  }
}

/** 写缓存（内存 + 落盘） */
export function writeCache(key, value, ttlMs) {
  const at = Date.now()
  memory.set(key, { value, at, ttl: ttlMs })

  // 内存上限保护
  if (memory.size > 200) {
    const firstKey = memory.keys().next().value
    memory.delete(firstKey)
  }

  if (!LS || !shouldPersist(key)) return value
  try {
    LS.setItem(PREFIX + key, JSON.stringify({ v: CACHE_VERSION, at, ttl: ttlMs, value }))
  } catch {
    // 配额满：清掉本模块所有落盘缓存后重试一次
    try {
      clearPersistent()
      LS.setItem(PREFIX + key, JSON.stringify({ v: CACHE_VERSION, at, ttl: ttlMs, value }))
    } catch {
      /* 仍然失败就放弃持久化，不影响功能 */
    }
  }
  return value
}

/** 只清内存（保留落盘，用于手动刷新后仍能秒开） */
export function clearMemory() {
  memory.clear()
}

/** 清全部（内存 + 落盘） */
export function clearAll() {
  memory.clear()
  clearPersistent()
}

function clearPersistent() {
  if (!LS) return
  const doomed = []
  for (let i = 0; i < LS.length; i++) {
    const k = LS.key(i)
    if (k && k.startsWith(PREFIX)) doomed.push(k)
  }
  doomed.forEach((k) => {
    try {
      LS.removeItem(k)
    } catch {
      /* 忽略 */
    }
  })
}

/** 诊断用：当前缓存规模 */
export function cacheStats() {
  let persisted = 0
  let bytes = 0
  if (LS) {
    for (let i = 0; i < LS.length; i++) {
      const k = LS.key(i)
      if (k && k.startsWith(PREFIX)) {
        persisted++
        bytes += (LS.getItem(k) || '').length
      }
    }
  }
  return { memory: memory.size, persisted, bytes }
}
