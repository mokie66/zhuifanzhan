/**
 * 本地存储层：收藏 / 观看历史 / 播放进度
 *
 * 现阶段后端还没有用户体系，这些数据先落在 localStorage，
 * 接口签名与将来接后端时保持一致（都是 Promise），
 * 后续只需把内部实现换成 HTTP 调用，视图层不用改。
 */

const NS = 'pmv:' // personal-media-vue 命名空间前缀

const KEYS = {
  favorites: `${NS}favorites`,
  history: `${NS}history`,
  progress: `${NS}progress`,
}

/** 安全读取 JSON */
function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/** 安全写入 JSON（隐私模式下 localStorage 可能抛错） */
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/** 生成影片唯一键：跨源同一部片应视为同一条记录 */
export function vodKey(vod) {
  const name = String(vod?.title || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
  return name || `${vod?.sourceKey || ''}:${vod?.id || ''}`
}

/* ------------------------------------------------------------------ *
 * 收藏
 * ------------------------------------------------------------------ */

/** 取收藏列表（按收藏时间倒序） */
export async function getFavorites() {
  return read(KEYS.favorites, [])
}

/** 是否已收藏 */
export async function isFavorite(vod) {
  const list = await getFavorites()
  const k = vodKey(vod)
  return list.some((x) => vodKey(x) === k)
}

/** 加入收藏（已存在则不重复添加） */
export async function addFavorite(vod) {
  const list = await getFavorites()
  const k = vodKey(vod)
  if (list.some((x) => vodKey(x) === k)) return list
  const next = [snapshot(vod), ...list].slice(0, 500)
  write(KEYS.favorites, next)
  return next
}

/** 取消收藏；返回是否删除成功 */
export async function removeFavorite(vod) {
  const list = await getFavorites()
  const k = vodKey(vod)
  const next = list.filter((x) => vodKey(x) !== k)
  write(KEYS.favorites, next)
  return next.length !== list.length
}

/** 切换收藏状态，返回切换后的状态 */
export async function toggleFavorite(vod) {
  const fav = await isFavorite(vod)
  if (fav) {
    await removeFavorite(vod)
    return false
  }
  await addFavorite(vod)
  return true
}

/* ------------------------------------------------------------------ *
 * 观看历史
 * ------------------------------------------------------------------ */

/** 取历史（按时间倒序） */
export async function getHistory() {
  return read(KEYS.history, [])
}

/**
 * 记录一次观看
 * @param {object} vod 影片
 * @param {object} info { episodeName, episodeIndex, lineKey, percent, position, duration }
 */
export async function pushHistory(vod, info = {}) {
  const list = await getHistory()
  const k = vodKey(vod)
  const filtered = list.filter((x) => vodKey(x) !== k)
  const record = {
    ...snapshot(vod),
    ...info,
    watchedAt: Date.now(),
  }
  const next = [record, ...filtered].slice(0, 200)
  write(KEYS.history, next)
  return next
}

/** 清空历史 */
export async function clearHistory() {
  write(KEYS.history, [])
}

/* ------------------------------------------------------------------ *
 * 播放进度（按 影片+线路+集 维度记录，与历史分开）
 * ------------------------------------------------------------------ */

function progressKey(vod, lineKey, episodeIndex) {
  return `${vodKey(vod)}|${lineKey || ''}|${episodeIndex ?? 0}`
}

/** 取某集进度 */
export async function getProgress(vod, lineKey, episodeIndex) {
  const all = read(KEYS.progress, {})
  return all[progressKey(vod, lineKey, episodeIndex)] || null
}

/** 记录播放进度 */
export async function saveProgress(vod, lineKey, episodeIndex, data) {
  const all = read(KEYS.progress, {})
  const k = progressKey(vod, lineKey, episodeIndex)
  all[k] = { ...data, at: Date.now() }
  // 控制体积：只保留最近 300 条
  const entries = Object.entries(all).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
  const trimmed = Object.fromEntries(entries.slice(0, 300))
  write(KEYS.progress, trimmed)
  return trimmed[k]
}

/** 取某部片最近一次观看的集与进度（用于「继续观看」） */
export async function getLastProgress(vod) {
  const all = read(KEYS.progress, {})
  const prefix = vodKey(vod) + '|'
  const hits = Object.entries(all)
    .filter(([k]) => k.startsWith(prefix))
    .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
  if (!hits.length) return null
  const [k, v] = hits[0]
  const [, lineKey, idx] = k.split('|')
  return { lineKey, episodeIndex: Number(idx) || 0, ...v }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 只挑出需要持久化的字段，避免把整个详情塞进 localStorage */
function snapshot(vod) {
  if (!vod) return {}
  return {
    id: vod.id,
    sourceKey: vod.sourceKey,
    sourceName: vod.sourceName,
    title: vod.title,
    poster: vod.poster,
    year: vod.year,
    area: vod.area,
    categoryName: vod.categoryName,
    score: vod.score,
    remarks: vod.remarks,
    episodeCount: vod.episodeCount,
    intro: vod.intro,
  }
}

/** 导出全部数据（便于用户备份/迁移） */
export async function exportAll() {
  return {
    favorites: await getFavorites(),
    history: await getHistory(),
    progress: read(KEYS.progress, {}),
    exportedAt: new Date().toISOString(),
  }
}

/** 导入数据 */
export async function importAll(payload) {
  if (payload?.favorites) write(KEYS.favorites, payload.favorites)
  if (payload?.history) write(KEYS.history, payload.history)
  if (payload?.progress) write(KEYS.progress, payload.progress)
}
