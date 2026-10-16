/**
 * 采集源健康度与熔断
 * ====================
 * 为什么需要
 * ----------
 * 实测首页冷启动 20 秒，罪魁不是「所有源都慢」，而是**个别源极慢**：
 *   modu  ac=list 单次 20011 ms
 *   zuida ac=list 单次 10497 ms
 * 它们反复 504 超时，却每次都被重试，把整个首屏拖住（木桶效应）。
 *
 * 做法
 * ----
 * 记录每个源的连续失败次数。连续失败达到阈值就「熔断」一段时间，
 * 期间直接跳过、不再发请求；冷却期结束后放行一次试探（半开），成功则恢复。
 *
 * 状态**持久化到 localStorage**：这点很重要 —— App 重启后立刻就知道
 * 上次哪些源是坏的，从第一次请求起就跳过，而不是又花 20 秒重新发现一遍。
 */

const KEY = 'pmv:sourceHealth:v1'

/** 连续失败多少次进入熔断 */
const FAIL_THRESHOLD = 3
/** 熔断持续多久（冷却后放行一次试探） */
const COOLDOWN_MS = 10 * 60 * 1000
/** 单次请求慢于这个值，即使成功也记为「慢」，连续慢同样降级 */
const SLOW_MS = 6000
/** 连续慢多少次进入降级 */
const SLOW_THRESHOLD = 4

function nowMs() {
  return Date.now()
}

function load() {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function save(state) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* 配额问题不影响功能 */
  }
}

let state = load()

function entry(key) {
  if (!state[key]) {
    state[key] = { fails: 0, slows: 0, openedAt: 0, lastMs: 0, ok: 0, fail: 0 }
  }
  return state[key]
}

/**
 * 该源当前是否可用
 * @returns {{usable:boolean, reason?:string, retryAfterMs?:number}}
 */
export function checkAvailable(key) {
  const e = state[key]
  if (!e) return { usable: true }
  if (e.fails < FAIL_THRESHOLD && e.slows < SLOW_THRESHOLD) return { usable: true }

  const opened = e.openedAt || 0
  const elapsed = nowMs() - opened
  if (elapsed >= COOLDOWN_MS) {
    // 半开：放行一次试探
    return { usable: true, reason: 'probing' }
  }
  return {
    usable: false,
    reason: e.fails >= FAIL_THRESHOLD ? `连续失败 ${e.fails} 次` : `连续缓慢 ${e.slows} 次`,
    retryAfterMs: COOLDOWN_MS - elapsed,
  }
}

/** 记录一次成功
 *
 * slowThreshold 用于判断「慢」：调用方按自己的预算传。
 * 这点很重要 —— 热门榜的预算本来就是 11 秒（因为魔都/爱奇艺都要 6 秒以上），
 * 若统一按 6 秒判定，每次拉热门榜都会把这两个源记成「慢」，
 * 攒够次数就被熔断，等于把自己要用的源给封了（实际踩过）。
 */
export function recordSuccess(key, ms, slowThreshold = SLOW_MS) {
  const e = entry(key)
  e.ok++
  e.lastMs = ms
  e.fails = 0
  if (ms > slowThreshold) {
    e.slows++
    // 连续慢也算一种不健康，达到阈值同样熔断
    if (e.slows >= SLOW_THRESHOLD) e.openedAt = nowMs()
  } else {
    e.slows = 0
    e.openedAt = 0
  }
  save(state)
}

/** 记录一次失败 */
export function recordFailure(key) {
  const e = entry(key)
  e.fail++
  e.fails++
  e.slows = 0
  if (e.fails >= FAIL_THRESHOLD) e.openedAt = nowMs()
  save(state)
}

/** 诊断快照 */
export function healthSnapshot() {
  return Object.entries(state).map(([key, e]) => ({
    key,
    ...e,
    available: checkAvailable(key).usable,
    reason: checkAvailable(key).reason || '',
  }))
}

/** 手动复位某个源（设置页「复检」时用） */
export function resetSource(key) {
  if (key) delete state[key]
  else state = {}
  save(state)
}

export const HEALTH_TUNING = {
  FAIL_THRESHOLD,
  COOLDOWN_MS,
  SLOW_MS,
  SLOW_THRESHOLD,
}
