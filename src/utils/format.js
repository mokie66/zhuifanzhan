/**
 * 展示格式化工具
 */

/** 秒 → mm:ss 或 hh:mm:ss */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
export function formatRelativeTime(input) {
  if (!input) return ''
  let ts
  if (typeof input === 'number') ts = input
  else {
    const normalized = String(input).replace(/-/g, '/')
    ts = new Date(normalized).getTime()
  }
  if (!Number.isFinite(ts)) return String(input)

  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 更新状态文案
 * 优先用源站给的 vod_remarks（如「更新至第 18 集」「全 24 集」），
 * 没有时用集数与完结标记兜底推断。
 */
export function formatStatus(vod) {
  if (!vod) return ''
  if (vod.remarks) return vod.remarks
  if (vod.isEnd && vod.episodeCount) return `全 ${vod.episodeCount} 集`
  if (vod.episodeCount) return `共 ${vod.episodeCount} 集`
  return ''
}

/** 评论文案：8.9 分 */
export function formatScore(score) {
  const n = Number(score)
  return n > 0 ? `${n.toFixed(1)} 分` : ''
}

/** 元信息行：都市 · 悬疑 · 2024 */
export function formatMeta(vod, { sep = ' · ' } = {}) {
  if (!vod) return ''
  return [vod.categoryName, vod.area, vod.year].filter(Boolean).join(sep)
}

/** 文件体积 */
export function formatBytes(n) {
  const b = Number(n) || 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 截断文本 */
export function truncate(s, max = 60) {
  const str = String(s || '')
  return str.length > max ? str.slice(0, max - 1) + '…' : str
}
