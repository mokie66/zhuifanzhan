/**
 * 验证源配置管理（config.js）
 *
 * 重点测校验逻辑：远程配置是**不可信输入**，必须挡住各种畸形/恶意数据，
 * 否则会出现 key 进 URL 路径导致请求异常、或 source 覆盖等问题。
 *
 * 运行：node --import ./scripts/register-loader.mjs scripts/verify-config.mjs
 */

// ---- localStorage 垫片 ----
class MemoryStorage {
  constructor() { this.map = new Map() }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null }
  setItem(k, v) { this.map.set(k, String(v)) }
  removeItem(k) { this.map.delete(k) }
  clear() { this.map.clear() }
  get length() { return this.map.size }
  key(i) { return [...this.map.keys()][i] ?? null }
}
globalThis.localStorage = new MemoryStorage()
// transport.js 会读 window.Capacitor 判断环境，这里模拟浏览器
globalThis.window = { location: { protocol: 'http:' } }
globalThis.fetch = async () => {
  throw new Error('测试环境不应发起真实网络请求')
}

const C = await import('@/api/config.js')
const { validateConfig } = C

let pass = 0
let fail = 0
const log = (ok, label, extra = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${extra ? '  ' + extra : ''}`)
  ok ? pass++ : fail++
}

console.log('='.repeat(84))
console.log('1. 校验：合法配置')
console.log('='.repeat(84))
{
  const v = validateConfig({
    sources: [
      { key: 'a', name: 'A源', api: 'http://a.com/api.php/provide/vod/', weight: 90 },
      { key: 'b-1_c', name: 'B源', api: 'https://b.com/x', enabled: false },
    ],
  })
  log(v.ok, '接受合法配置', `${v.sources.length} 个源`)
  log(v.sources[0].enabled === true, '缺省 enabled 默认 true')
  log(v.sources[1].enabled === false, '显式 enabled:false 被保留')
  log(v.sources[0].weight === 90, 'weight 被保留')
}

console.log('\n' + '='.repeat(84))
console.log('2. 校验：畸形输入必须被拒绝')
console.log('='.repeat(84))
const BAD = [
  [null, 'null'],
  ['not-an-object', '字符串'],
  [{}, '空对象（无 sources）'],
  [{ sources: 'not-array' }, 'sources 不是数组'],
  [{ sources: [] }, '空数组'],
  [{ sources: [{ name: '缺key', api: 'http://a.com' }] }, '缺 key'],
  [{ sources: [{ key: 'x', name: '缺api' }] }, '缺 api'],
  [{ sources: [{ key: 'x', api: 'ftp://a.com' }] }, 'api 协议非 http/https'],
  [{ sources: [{ key: 'x', api: 'javascript:alert(1)' }] }, 'api 是 javascript 伪协议'],
]
for (const [input, label] of BAD) {
  const v = validateConfig(input)
  log(!v.ok, `拒绝：${label}`, v.ok ? '⚠ 未拦住！' : v.error.slice(0, 30))
}

console.log('\n' + '='.repeat(84))
console.log('3. 校验：key 字符集限制（key 会进 URL 路径与 nginx location）')
console.log('='.repeat(84))
const KEY_CASES = [
  ['正常', 'lzi', true],
  ['带连字符', 'lzi-1', true],
  ['带下划线', 'lzi_1', true],
  ['带斜杠', 'lzi/evil', false],
  ['带点号', '../etc', false],
  ['带空格', 'lzi 1', false],
  ['带中文', '量子', false],
  ['超长', 'a'.repeat(40), false],
  ['空', '', false],
]
for (const [label, key, expect] of KEY_CASES) {
  const v = validateConfig({ sources: [{ key, name: 'x', api: 'http://a.com' }] })
  const survived = v.ok && v.sources.length === 1
  log(survived === expect, `key ${label}`, `期望${expect ? '通过' : '拒绝'} 实际${survived ? '通过' : '拒绝'}`)
}

console.log('\n' + '='.repeat(84))
console.log('4. 校验：重复 key 只保留第一个（避免相互覆盖）')
console.log('='.repeat(84))
{
  const v = validateConfig({
    sources: [
      { key: 'dup', name: '第一个', api: 'http://first.com' },
      { key: 'dup', name: '第二个', api: 'http://second.com' },
    ],
  })
  log(v.ok && v.sources.length === 1, '重复 key 被去重', `${v.sources.length} 个`)
  log(v.sources[0].name === '第一个', '保留第一个', v.sources[0].name)
}

console.log('\n' + '='.repeat(84))
console.log('5. 校验：混合合法与非法（非法项被丢弃，合法项保留）')
console.log('='.repeat(84))
{
  const v = validateConfig({
    sources: [
      { key: 'good1', name: '好的', api: 'http://good1.com' },
      { key: 'bad/key', name: '坏key', api: 'http://bad.com' },
      { key: 'bad2', name: '坏api', api: 'not-a-url' },
      { key: 'good2', name: '也是好的', api: 'https://good2.com' },
    ],
  })
  log(v.ok && v.sources.length === 2, '只保留 2 个合法源', `实际 ${v.sources.length}`)
  log(
    v.sources.every((s) => ['good1', 'good2'].includes(s.key)),
    '被保留的正是合法项'
  )
}

console.log('\n' + '='.repeat(84))
console.log('6. 源列表管理')
console.log('='.repeat(84))
{
  const bundled = C.getActiveSources()
  log(bundled.length === 8, '内置默认源数量', `${bundled.length} 个`)
  log(C.getConfigMeta().origin === 'bundled', '初始来源是内置')

  const enabled = C.enabledSources()
  log(enabled.length === 7, '启用的源（暴风默认关闭）', `${enabled.length} 个`)
  log(
    enabled.every((s, i, a) => i === 0 || a[i - 1].weight >= s.weight),
    '按 weight 降序排列'
  )

  log(Boolean(C.getSource('lzi')), 'getSource 能按 key 取到')
  log(C.getSource('nosuch') === null, '不存在的 key 返回 null')
}

console.log('\n' + '='.repeat(84))
console.log('7. 手动导入 / 开关 / 恢复')
console.log('='.repeat(84))
{
  C.applyManualConfig(
    JSON.stringify({ sources: [{ key: 'only', name: '唯一源', api: 'http://only.com' }] })
  )
  log(C.getActiveSources().length === 1, '手动导入生效', `${C.getActiveSources().length} 个`)
  log(C.getConfigMeta().origin === 'manual', '来源标记为手动导入')

  // 导入非法配置应抛错且不改变现状
  let threw = false
  try {
    C.applyManualConfig('{ not valid json')
  } catch {
    threw = true
  }
  log(threw, '非法 JSON 抛错')
  log(C.getActiveSources().length === 1, '抛错后配置未被破坏', `${C.getActiveSources().length} 个`)

  // 开关
  C.toggleSourceEnabled('only', false)
  log(C.enabledSources().length === 0, '关闭后启用数为 0')
  C.toggleSourceEnabled('only', true)
  log(C.enabledSources().length === 1, '重新开启后为 1')

  // 恢复
  C.resetToBundled()
  log(C.getActiveSources().length === 8, '恢复内置默认', `${C.getActiveSources().length} 个`)
  log(C.getConfigMeta().origin === 'bundled', '来源恢复为内置')
}

console.log('\n' + '='.repeat(84))
console.log('8. 导出')
console.log('='.repeat(84))
{
  const dump = C.exportConfig()
  log(Array.isArray(dump.sources), '导出含 sources 数组')
  log(Boolean(dump.updatedAt), '导出含时间戳')
  // 导出的内容必须能再被校验通过（往返一致）
  const round = validateConfig(dump)
  log(round.ok, '导出的配置能重新校验通过（往返一致）', `${round.sources.length} 个源`)
}

console.log('\n' + '='.repeat(84))
console.log(`结果：通过 ${pass}  失败 ${fail}`)
console.log('='.repeat(84))
process.exit(fail > 0 ? 1 : 0)
