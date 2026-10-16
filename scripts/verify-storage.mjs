/**
 * 验证本地存储层（收藏 / 历史 / 播放进度）
 *
 * storage.js 依赖 localStorage，Node 下没有，这里注入一个符合规范的最小垫片，
 * 用真实模块跑一遍，确认：
 *   1. 收藏增删查、切换、去重（同一部片跨源只算一条）
 *   2. 播放进度按「影片+线路+集」维度隔离
 *   3. 续播定位（getLastProgress）取到最近一次
 *   4. 数据快照只存必要字段，不会把整个详情塞进 localStorage
 *
 * 运行：node --import ./scripts/register-loader.mjs scripts/verify-storage.mjs
 */

// ---- localStorage 垫片 ----
class MemoryStorage {
  constructor() {
    this.map = new Map()
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null
  }
  setItem(k, v) {
    this.map.set(k, String(v))
  }
  removeItem(k) {
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
  get length() {
    return this.map.size
  }
  key(i) {
    return [...this.map.keys()][i] ?? null
  }
}
globalThis.localStorage = new MemoryStorage()

const S = await import('@/utils/storage.js')

let pass = 0
let fail = 0
const log = (ok, label, extra = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${extra ? '  ' + extra : ''}`)
  ok ? pass++ : fail++
}

// 造两部片，其中一部有两个源的同名片（用于验证跨源去重）
const vodA = {
  id: '22304',
  sourceKey: 'lzi',
  sourceName: '量子资源',
  title: '神印王座',
  poster: 'https://x/p.jpg',
  year: '2022',
  categoryName: '国产动漫',
  score: 8.5,
  remarks: '更新至208集',
  episodeCount: 208,
  intro: '简介',
  // 这些字段不应该被存进 localStorage
  allLines: new Array(50).fill({ key: 'x', episodes: new Array(200).fill({ name: 'a', url: 'b' }) }),
}
const vodA_otherSource = { ...vodA, id: '99', sourceKey: 'ffzy', sourceName: '非凡资源' }
const vodB = { ...vodA, id: '1', title: '别的片', sourceKey: 'lzi' }

console.log('='.repeat(80))
console.log('1. 收藏')
console.log('='.repeat(80))

log((await getFavLen()) === 0, '初始为空', `长度 ${await getFavLen()}`)

await S.addFavorite(vodA)
log((await getFavLen()) === 1, '加入收藏', `长度 ${await getFavLen()}`)

log(await S.isFavorite(vodA), 'isFavorite 判定正确')

await S.addFavorite(vodA)
log((await getFavLen()) === 1, '重复加入不产生重复项', `长度 ${await getFavLen()}`)

await S.addFavorite(vodA_otherSource)
log(
  (await getFavLen()) === 1,
  '跨源同名片视为同一条（按片名去重）',
  `长度 ${await getFavLen()}`
)

await S.addFavorite(vodB)
log((await getFavLen()) === 2, '不同片各自独立', `长度 ${await getFavLen()}`)

const toggledOff = await S.toggleFavorite(vodB)
log(toggledOff === false && (await getFavLen()) === 1, 'toggleFavorite 取消收藏')

const toggledOn = await S.toggleFavorite(vodB)
log(toggledOn === true && (await getFavLen()) === 2, 'toggleFavorite 重新收藏')

async function getFavLen() {
  return (await S.getFavorites()).length
}

console.log('\n' + '='.repeat(80))
console.log('2. 快照瘦身（避免把整个详情塞进 localStorage）')
console.log('='.repeat(80))
const favs = await S.getFavorites()
const snap = favs.find((f) => f.title === '神印王座')
log(Boolean(snap), '收藏记录存在')
log(!('allLines' in snap), 'allLines（大数组）未被持久化')
log(Object.keys(snap).length <= 16, '字段数受限', `${Object.keys(snap).length} 个字段`)
const snapSize = JSON.stringify(favs).length
log(snapSize < 2000, '序列化体积合理', `${snapSize} 字节`)

console.log('\n' + '='.repeat(80))
console.log('3. 播放进度（按 影片+线路+集 维度隔离）')
console.log('='.repeat(80))
await S.saveProgress(vodA, 'lzm3u8', 0, { currentTime: 120, duration: 2400 })
await S.saveProgress(vodA, 'lzm3u8', 1, { currentTime: 60, duration: 2400 })
await S.saveProgress(vodA, 'liangzi', 0, { currentTime: 999, duration: 2400 })

const p1 = await S.getProgress(vodA, 'lzm3u8', 0)
const p2 = await S.getProgress(vodA, 'lzm3u8', 1)
const p3 = await S.getProgress(vodA, 'liangzi', 0)
log(p1?.currentTime === 120, '线路 lzm3u8 第0集 独立记录', `${p1?.currentTime}`)
log(p2?.currentTime === 60, '线路 lzm3u8 第1集 独立记录', `${p2?.currentTime}`)
log(p3?.currentTime === 999, '换线路后进度互不干扰', `${p3?.currentTime}`)

// 稍等确保时间戳有差异
await new Promise((r) => setTimeout(r, 12))
await S.saveProgress(vodA, 'lzm3u8', 2, { currentTime: 30, duration: 2400 })
const last = await S.getLastProgress(vodA)
log(
  last?.lineKey === 'lzm3u8' && last?.episodeIndex === 2,
  'getLastProgress 取到最近一次',
  `线路=${last?.lineKey} 集=${last?.episodeIndex}`
)

console.log('\n' + '='.repeat(80))
console.log('4. 观看历史')
console.log('='.repeat(80))
await S.pushHistory(vodA, { episodeIndex: 5, episodeName: '第06集', lineKey: 'lzm3u8', percent: 42 })
await S.pushHistory(vodA, { episodeIndex: 6, episodeName: '第07集', lineKey: 'lzm3u8', percent: 10 })
const hist = await S.getHistory()
log(hist.length === 1, '同一部片在历史中只保留最新一条（不重复堆积）', `${hist.length} 条`)
log(hist[0].episodeIndex === 6, '历史记录的是最新集', `第 ${hist[0].episodeIndex + 1} 集`)
log(hist[0].percent === 10, '含进度百分比')

await S.pushHistory(vodB, { episodeIndex: 0, episodeName: '第01集', percent: 5 })
log((await S.getHistory()).length === 2, '不同片各自入历史')

await S.clearHistory()
log((await S.getHistory()).length === 0, 'clearHistory 生效')

console.log('\n' + '='.repeat(80))
console.log('5. 导出 / 导入')
console.log('='.repeat(80))
const dump = await S.exportAll()
log(Boolean(dump.favorites && dump.history && dump.progress), 'exportAll 结构完整')
log(dump.favorites.length === 2, '导出包含收藏', `${dump.favorites.length} 条`)

globalThis.localStorage.clear()
await S.importAll(dump)
log((await S.getFavorites()).length === 2, 'importAll 恢复成功', `${(await S.getFavorites()).length} 条`)

console.log('\n' + '='.repeat(80))
console.log(`结果：通过 ${pass}  失败 ${fail}`)
console.log('='.repeat(80))
process.exit(fail > 0 ? 1 : 0)
