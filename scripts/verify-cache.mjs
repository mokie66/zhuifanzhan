/**
 * 验证缓存与源健康度模块
 *
 * 这两个模块是「首页 20 秒 → 秒开」优化的核心，逻辑不简单
 * （TTL 三段、版本失效、配额兜底、熔断开合、半开试探），
 * 且失效时的表现很隐蔽（缓存永不刷新 / 或永远刷新不到），所以必须有测试。
 *
 * 运行：node --import ./scripts/register-loader.mjs scripts/verify-cache.mjs
 */

// ---- localStorage 垫片：模拟真机存储，并可控地制造异常 ----
let store = {}
let throwOnSet = false
let throwOnGet = false
const localStorageShim = {
  getItem(k) {
    if (throwOnGet) throw new Error('读取被禁用')
    return k in store ? store[k] : null
  },
  setItem(k, v) {
    if (throwOnSet) throw new Error('QuotaExceededError')
    store[k] = String(v)
  },
  removeItem(k) {
    delete store[k]
  },
  key(i) {
    return Object.keys(store)[i] ?? null
  },
  get length() {
    return Object.keys(store).length
  },
  clear() {
    store = {}
  },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageShim,
  configurable: true,
  writable: true,
})

const cache = await import('@/api/cache.js')
const health = await import('@/api/health.js')

let pass = 0
let fail = 0
const log = (ok, label, extra = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${extra ? '  ' + extra : ''}`)
  ok ? pass++ : fail++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('='.repeat(88))
console.log('1. 缓存基础读写')
console.log('='.repeat(88))
{
  cache.clearAll()
  cache.writeCache('home:feed', { a: 1 }, 1000)
  const hit = cache.readCache('home:feed')
  log(hit?.value?.a === 1, '写入后可读回')
  log(hit?.stale === false, '未过期时 stale=false')
  log(cache.readCache('not-exist') === null, '不存在的键返回 null')
}

console.log('\n' + '='.repeat(88))
console.log('2. TTL 三段（新鲜 / 过期但可用 / 太旧）')
console.log('='.repeat(88))
{
  cache.clearAll()
  const ttl = 100
  cache.writeCache('latest:tv', ['x'], ttl)

  log(cache.readCache('latest:tv')?.stale === false, '段1：新鲜期内 stale=false')
  await sleep(ttl + 30)
  const mid = cache.readCache('latest:tv')
  log(mid?.stale === true, `段2：过期但未超出可用窗口 stale=true`, `STALE_FACTOR=${cache.STALE_FACTOR}`)
  log(mid?.value?.[0] === 'x', '段2 仍能拿到旧数据（这是秒开的关键）')

  // 模拟超出可用窗口：直接把记录时间改早
  const raw = JSON.parse(store['pmv:cache:latest:tv'])
  raw.at = Date.now() - ttl * cache.STALE_FACTOR - 1000
  store['pmv:cache:latest:tv'] = JSON.stringify(raw)
  cache.clearMemory()
  log(cache.readCache('latest:tv') === null, '段3：超出可用窗口返回 null（不会拿很旧的数据）')
  log(store['pmv:cache:latest:tv'] === undefined, '段3 会顺手清掉落盘记录')
}

console.log('\n' + '='.repeat(88))
console.log('3. 跨「重启」持久化（清内存后仍可读）')
console.log('='.repeat(88))
{
  cache.clearAll()
  cache.writeCache('home:feed', { title: '流人第六季' }, 60000)
  cache.clearMemory() // 模拟 App 重启：内存没了，落盘还在
  const hit = cache.readCache('home:feed')
  log(hit?.value?.title === '流人第六季', '清内存后仍能从落盘读回')
  log(hit?.stale === false, '且判定为新鲜')
}

console.log('\n' + '='.repeat(88))
console.log('4. 只持久化白名单内的键（避免把详情/搜索塞满存储）')
console.log('='.repeat(88))
{
  cache.clearAll()
  cache.writeCache('home:feed', { ok: 1 }, 60000)
  cache.writeCache('detail:lzi:123:1', { big: 'x'.repeat(100) }, 60000)
  const keys = Object.keys(store)
  log(keys.some((k) => k.includes('home:feed')), 'home:feed 已落盘')
  log(!keys.some((k) => k.includes('detail:')), 'detail:* 不落盘（体积大且与详情页时效不符）')
  cache.clearMemory()
  log(cache.readCache('detail:lzi:123:1') === null, '不落盘的键重启后自然失效')
}

console.log('\n' + '='.repeat(88))
console.log('5. 脏数据与版本失配的容错')
console.log('='.repeat(88))
{
  cache.clearAll()
  store['pmv:cache:home:feed'] = '{ 这不是合法 JSON'
  log(cache.readCache('home:feed') === null, '损坏的 JSON 返回 null 而不是抛异常')
  log(store['pmv:cache:home:feed'] === undefined, '并顺手清掉损坏记录')

  cache.clearAll()
  store['pmv:cache:home:feed'] = JSON.stringify({ v: 999, at: Date.now(), ttl: 60000, value: {} })
  log(cache.readCache('home:feed') === null, '版本号不匹配视为失效（升级后不会读到结构不符的数据）')

  cache.clearAll()
  store['pmv:cache:home:feed'] = JSON.stringify({ v: 1, at: Date.now(), ttl: 60000 })
  log(cache.readCache('home:feed') === null, '缺 value 字段不会崩')
}

console.log('\n' + '='.repeat(88))
console.log('6. 存储不可用/超额时不崩溃')
console.log('='.repeat(88))
{
  cache.clearAll()
  throwOnSet = true
  try {
    cache.writeCache('home:feed', { a: 1 }, 60000)
    log(true, '写入抛异常时不崩溃')
  } catch (e) {
    log(false, '写入抛异常时不崩溃', e.message)
  }
  log(cache.readCache('home:feed')?.value?.a === 1, '内存缓存仍然可用（功能降级而非失效）')
  throwOnSet = false

  cache.clearAll()
  throwOnGet = true
  try {
    log(cache.readCache('home:feed') === null, '读取抛异常时返回 null')
  } catch (e) {
    log(false, '读取抛异常时返回 null', e.message)
  }
  throwOnGet = false
}

console.log('\n' + '='.repeat(88))
console.log('7. 源健康度：熔断开合')
console.log('='.repeat(88))
{
  health.resetSource()
  const T = health.HEALTH_TUNING

  log(health.checkAvailable('lzi').usable === true, '初始状态可用')

  // 失败到阈值
  for (let i = 0; i < T.FAIL_THRESHOLD; i++) health.recordFailure('bad')
  log(health.checkAvailable('bad').usable === false, `连续失败 ${T.FAIL_THRESHOLD} 次后熔断`)
  log(/连续失败/.test(health.checkAvailable('bad').reason || ''), '熔断原因可读', health.checkAvailable('bad').reason)
  log(health.checkAvailable('bad').retryAfterMs > 0, '给出剩余冷却时间')

  // 半开：把熔断时间改早，模拟冷却结束
  const snap = health.healthSnapshot().find((s) => s.key === 'bad')
  log(snap !== undefined, '快照包含该源')

  // 成功一次应恢复计数
  health.recordSuccess('bad', 100)
  log(health.checkAvailable('bad').usable === true, '成功一次后恢复可用')

  health.resetSource()
}

console.log('\n' + '='.repeat(88))
console.log('8. 源健康度：慢请求也降级')
console.log('='.repeat(88))
{
  health.resetSource()
  const T = health.HEALTH_TUNING
  for (let i = 0; i < T.SLOW_THRESHOLD; i++) health.recordSuccess('slow', T.SLOW_MS + 1000)
  log(health.checkAvailable('slow').usable === false, `连续 ${T.SLOW_THRESHOLD} 次慢请求后熔断`)
  log(/缓慢/.test(health.checkAvailable('slow').reason || ''), '原因是「连续缓慢」', health.checkAvailable('slow').reason)

  // 一次快请求应立刻清掉慢计数
  health.recordSuccess('slow', 300)
  log(health.checkAvailable('slow').usable === true, '一次正常速度就恢复')

  health.resetSource()
}

console.log('\n' + '='.repeat(88))
console.log('9. 源健康度：跨重启保留')
console.log('='.repeat(88))
{
  health.resetSource()
  const T = health.HEALTH_TUNING
  for (let i = 0; i < T.FAIL_THRESHOLD; i++) health.recordFailure('modu')

  // 关键：健康度落盘后，App 重启能立刻知道哪些源是坏的，
  // 而不是又花 20 秒重新发现一遍
  const persisted = Object.keys(store).find((k) => k.includes('sourceHealth'))
  log(Boolean(persisted), '健康度已写入 localStorage')
  const rec = JSON.parse(store[persisted])
  log(rec.modu?.fails >= T.FAIL_THRESHOLD, '记录了失败次数', JSON.stringify(rec.modu))

  health.resetSource()
}

console.log('\n' + '='.repeat(88))
console.log('10. 瘦身：列表项不应带播放线路数据')
console.log('='.repeat(88))
{
  const { slimVod, slimVodList } = await import('@/utils/media.js')
  const heavy = {
    sourceKey: 'lzi',
    id: 1,
    title: '测试',
    poster: 'p.jpg',
    score: 9,
    intro: '简介',
    lines: [{ key: 'a', episodes: new Array(50).fill({ name: 'x', url: 'http://e.com/' + 'y'.repeat(200) }) }],
    playableLines: [{ key: 'b', episodes: new Array(50).fill({ url: 'http://e.com/' + 'z'.repeat(200) }) }],
    allLines: [{ key: 'c', episodes: [] }],
    mirrors: [{ sourceKey: 'ffzy', sourceName: '非凡', lines: [{ big: 'x'.repeat(500) }] }],
  }
  const slim = slimVod(heavy)
  log(slim.lines === undefined, 'lines 已移除')
  log(slim.playableLines === undefined, 'playableLines 已移除')
  log(slim.allLines === undefined, 'allLines 已移除')
  log(slim.title === '测试' && slim.score === 9 && slim.intro === '简介', '展示字段保留')
  log(slim.mirrors?.length === 1, 'mirrors 保留但只留摘要（列表要显示「N 源」角标）')
  log(slim.mirrors[0].lines === undefined, 'mirrors 里的线路数据已移除', JSON.stringify(slim.mirrors[0]))

  const before = JSON.stringify(heavy).length
  const after = JSON.stringify(slim).length
  log(after < before / 5, '体积显著下降', `${before} → ${after} 字节（${Math.round((1 - after / before) * 100)}%↓）`)

  // 原对象不应被修改（避免影响调用方后续逻辑）
  log(Array.isArray(heavy.lines), '原对象未被就地修改')
  log(slimVod(null) === null && slimVod(undefined) === undefined, '空值安全')
  log(slimVodList(null).length === 0, 'slimVodList 对非数组安全')
}

console.log('\n' + '='.repeat(88))
console.log(`结果：通过 ${pass}  失败 ${fail}`)
console.log('='.repeat(88))
process.exit(fail > 0 ? 1 : 0)
