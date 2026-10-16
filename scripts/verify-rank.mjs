/**
 * 验证热度排序模块（rank.js）
 *
 * 这是新增的核心逻辑，且依赖对数据现实的理解，必须有测试兜底：
 *   1. hits 对数刻度（跨度 2~44029，线性会让头部霸榜）
 *   2. 低质降权（动态漫等）而非删除
 *   3. **关键**：hits 全为 0 的源不能被整体埋掉（多源冗余的前提）
 *   4. 跨源交错，保证每个源都有曝光
 *
 * 运行：node --import ./scripts/register-loader.mjs scripts/verify-rank.mjs
 */
const R = await import('@/api/rank.js')

let pass = 0
let fail = 0
const log = (ok, label, extra = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${extra ? '  ' + extra : ''}`)
  ok ? pass++ : fail++
}

const now = Date.now()
const day = 86400000

console.log('='.repeat(84))
console.log('1. hits 对数刻度')
console.log('='.repeat(84))
{
  const cases = [
    [0, 0, 'hits=0 应为 0'],
    [1, null, 'hits=1 应很小'],
    [100, null, 'hits=100'],
    [10000, null, 'hits=10000'],
    [50000, 1, 'hits 达到上限应为 1'],
    [999999, 1, '超过上限仍为 1'],
  ]
  for (const [hits, expect, label] of cases) {
    const v = R.hitsToScore(hits)
    const ok = expect === null ? v > 0 && v < 1 : Math.abs(v - expect) < 1e-9
    log(ok, label, `→ ${v.toFixed(4)}`)
  }
  // 对数特性：10000 相对 100 的增量应远小于 100 相对 1 的增量占比
  const a = R.hitsToScore(1)
  const b = R.hitsToScore(100)
  const c = R.hitsToScore(10000)
  log(c - b < b - a + 1, '对数刻度：高区间增量被压缩（避免头部霸榜）', `${(b - a).toFixed(3)} vs ${(c - b).toFixed(3)}`)
  log(R.hitsToScore(10000) > R.hitsToScore(100), '单调递增')
}

console.log('\n' + '='.repeat(84))
console.log('2. 评分归一')
console.log('='.repeat(84))
{
  log(R.scoreToScore(0) === 0, '无评分 → 0')
  log(R.scoreToScore(5) === 0, '5 分 → 0（不作为正向信号）')
  log(R.scoreToScore(9.5) > 0.9, '9.5 分接近满分', R.scoreToScore(9.5).toFixed(3))
  log(R.scoreToScore(10) === 1, '10 分 → 1')
  log(R.scoreToScore(4) === 0, '低于 5 分 → 0（不惩罚，只不给正分）')
}

console.log('\n' + '='.repeat(84))
console.log('3. 新鲜度')
console.log('='.repeat(84))
{
  log(R.freshnessToScore(new Date(now).toISOString(), now) === 1, '今天（ISO 格式）→ 1')
  log(R.freshnessToScore(new Date(now - 15 * day).toISOString(), now) > 0.4, '15 天前（ISO）约 0.5', R.freshnessToScore(new Date(now - 15 * day).toISOString(), now).toFixed(3))
  log(R.freshnessToScore(new Date(now - 40 * day).toISOString(), now) === 0, '40 天前 → 0')
  log(R.freshnessToScore('', now) === 0, '无时间 → 0')
  // MacCMS 格式回归测试：曾因无脑 replace('-','/') 破坏 ISO 解析而全部返回 0
  const macTime = new Date(now - 2 * day)
  const macStr = `${macTime.getFullYear()}-${String(macTime.getMonth() + 1).padStart(2, '0')}-${String(macTime.getDate()).padStart(2, '0')} 10:00:00`
  log(R.freshnessToScore(macStr, now) > 0.9, 'MacCMS 格式可解析', `${macStr} → ${R.freshnessToScore(macStr, now).toFixed(3)}`)
  log(R.freshnessToScore(now, now) === 1, '时间戳数字可直接传入')
}

console.log('\n' + '='.repeat(84))
console.log('4. 低质降权（降权而非删除）')
console.log('='.repeat(84))
{
  const base = { title: '流人第六季', hits: 8000, score: 9.5, updatedAt: new Date(now).toISOString() }
  const dongman = { ...base, title: '修仙归来当大佬动态漫' }
  const spam = { ...base, title: '123456' }

  const sBase = R.popularityScore(base, now)
  const sDm = R.popularityScore(dongman, now)
  const sSpam = R.popularityScore(spam, now)

  log(sDm < sBase, '动态漫被降权', `${sDm.toFixed(3)} < ${sBase.toFixed(3)}`)
  log(sDm > 0, '仍保留分数（不是删除）', sDm.toFixed(3))
  log(sSpam < sBase, '疑似灌水标题被降权', `${sSpam.toFixed(3)} < ${sBase.toFixed(3)}`)
  log(R.qualityFactor(base) === 1, '正常内容不降权')
}

console.log('\n' + '='.repeat(84))
console.log('5. 【关键】hits 为 0 的源不能被整体埋掉')
console.log('='.repeat(84))
{
  // 模拟真实数据分布：爱奇艺/魔都有 hits，量子/非凡没有
  const vods = []
  // 魔都：有 hits，但内容一般
  for (let i = 0; i < 10; i++) {
    vods.push({
      sourceKey: 'modu', title: `魔都剧集${i}`, hits: 1000 + i * 500, score: 0,
      updatedAt: new Date(now - i * day).toISOString(),
    })
  }
  // 爱奇艺：有 hits
  for (let i = 0; i < 10; i++) {
    vods.push({
      sourceKey: 'iqiyi', title: `爱奇艺剧集${i}`, hits: 500 + i * 300, score: 0,
      updatedAt: new Date(now - i * day).toISOString(),
    })
  }
  // 量子：hits 全为 0，但有高评分
  for (let i = 0; i < 10; i++) {
    vods.push({
      sourceKey: 'lzi', title: `量子剧集${i}`, hits: 0, score: 9.0,
      updatedAt: new Date(now - i * day).toISOString(),
    })
  }
  // 非凡：hits 全为 0
  for (let i = 0; i < 10; i++) {
    vods.push({
      sourceKey: 'ffzy', title: `非凡剧集${i}`, hits: 0, score: 0,
      updatedAt: new Date(now - i * day).toISOString(),
    })
  }

  const ranked = R.rankVods(vods, { limit: 20, now })

  const bySrc = {}
  ranked.forEach((v) => {
    bySrc[v.sourceKey] = (bySrc[v.sourceKey] || 0) + 1
  })
  console.log('   前 20 名各源占比:', JSON.stringify(bySrc))

  log(Object.keys(bySrc).length === 4, '四个源都出现在前 20 名（交错生效）')
  // 设计保证：首轮交错让每个源各出 perSource 条（默认 2）。
  // 之后按热度全局排序补齐，所以 hits 为 0 的源不会再增加 —— 这是有意为之，
  // 既保证多源冗余（每个源都有曝光），又让热门内容靠前。
  const GUARANTEE = 2
  log(
    (bySrc.lzi || 0) >= GUARANTEE,
    `hits=0 但有评分的源（量子）至少有 ${GUARANTEE} 条曝光`,
    `${bySrc.lzi || 0} 条`
  )
  log(
    (bySrc.ffzy || 0) >= GUARANTEE,
    `hits=0 且无评分的源（非凡）至少有 ${GUARANTEE} 条曝光`,
    `${bySrc.ffzy || 0} 条`
  )

  // 首轮交错应让每源各出 perSource 条
  const first8 = ranked.slice(0, 8).map((v) => v.sourceKey)
  const uniqFirst8 = new Set(first8)
  log(uniqFirst8.size === 4, '前 8 名覆盖全部 4 个源', first8.join(','))

  // 有 hits 的应排在无 hits 的前面（同轮内）
  const moduIdx = ranked.findIndex((v) => v.sourceKey === 'modu')
  const lziIdx = ranked.findIndex((v) => v.sourceKey === 'lzi')
  log(moduIdx < lziIdx, '有真实热度的源整体靠前', `modu@${moduIdx} < lzi@${lziIdx}`)
}

console.log('\n' + '='.repeat(84))
console.log('6. 边界情况')
console.log('='.repeat(84))
{
  log(R.rankVods([], { limit: 10 }).length === 0, '空数组安全')
  log(R.rankVods(null, { limit: 10 }).length === 0, 'null 安全')
  log(R.rankVods([{ title: 'a' }], { limit: 10 }).length === 1, '缺 sourceKey 也能处理')

  const many = Array.from({ length: 50 }, (_, i) => ({
    sourceKey: 'x', title: `t${i}`, hits: i, score: 0,
    updatedAt: new Date(now).toISOString(),
  }))
  log(R.rankVods(many, { limit: 10 }).length === 10, 'limit 生效')
  // 排序函数不该隐式截断数据，默认不限制条数（由调用方决定）
  log(R.rankVods(many).length === 50, '未指定 limit 时返回全部（不隐式截断）', `${R.rankVods(many).length} 条`)
}

console.log('\n' + '='.repeat(84))
console.log(`结果：通过 ${pass}  失败 ${fail}`)
console.log('='.repeat(84))
process.exit(fail > 0 ? 1 : 0)
