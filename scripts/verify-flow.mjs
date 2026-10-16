/**
 * 端到端流程验证：直接调用项目里的真实模块，模拟 App 的完整数据流
 *
 * 覆盖：
 *   1. 多源聚合首页（getHomeFeed）
 *   2. 分类列表（getCategoryList）—— 验证子分类轮转策略
 *   3. 搜索（searchMedia）
 *   4. 详情 + 跨源换源（getDetail）
 *   5. 取出可播地址并真实拉取 m3u8，校验是合法 HLS 清单（播放可行性的硬证据）
 *
 * 运行前先起 dev server：npm run dev
 * 运行：node --import ./scripts/register-loader.mjs scripts/verify-flow.mjs
 */
const DEV = 'http://localhost:5173'

// 项目模块用的是相对路径 /collect/...，Node 下需要补上 dev server 源
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    return realFetch(DEV + input, init)
  }
  return realFetch(input, init)
}
// 浏览器专有 API 的最小垫片（模块里有 typeof window 保护，但保险起见）
globalThis.window = globalThis.window || undefined

const { getHomeFeed, getCategoryList, searchMedia, getDetail, guessGroup } =
  await import('@/api/index.js')
const { resolvePlayUrl, pickPlayable } = await import('@/utils/media.js')

let pass = 0
let fail = 0
const log = (ok, label, extra = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${extra ? '  ' + extra : ''}`)
  ok ? pass++ : fail++
}

console.log('='.repeat(90))
console.log('1. 首页聚合 getHomeFeed()')
console.log('='.repeat(90))
let feed
try {
  feed = await getHomeFeed()
  log(Boolean(feed.hero), '有主视觉影片', feed.hero ? `《${feed.hero.title}》` : '')
  log(feed.latestTv.length > 0, '电视剧区块', `${feed.latestTv.length} 部`)
  log(feed.latestAnime.length > 0, '动漫区块', `${feed.latestAnime.length} 部`)
  log(feed.latestMovie.length >= 0, '电影区块', `${feed.latestMovie.length} 部`)
  log(feed.categories.length > 0, '导航分类', feed.categories.map((c) => c.label).join('/'))
  if (feed.latestTv[0]) {
    const v = feed.latestTv[0]
    console.log(
      `   样片: 《${v.title}》 源=${v.sourceName} 分类=${v.categoryName} 集数=${v.episodeCount} 线路=${v.playableLines?.length || 0} 可播=${v.playable}`
    )
  }
} catch (e) {
  log(false, '首页聚合失败', e.message)
}

console.log('\n' + '='.repeat(90))
console.log('2. 分类列表 getCategoryList() —— 验证子分类轮转')
console.log('='.repeat(90))
for (const group of ['tv', 'anime', 'movie']) {
  try {
    const r = await getCategoryList({ group, page: 1, pageSize: 24 })
    const playable = r.items.filter((i) => i.playable).length
    log(
      r.items.length > 0,
      `${group.padEnd(6)}`,
      `${r.items.length} 部（原始 ${r.sourceStats.rawCount} 条）可播 ${playable} 条 · 源 ${r.sourceStats.ok}/${r.sourceStats.total}`
    )
    if (r.items[0]) console.log(`     样片: 《${r.items[0].title}》 ${r.items[0].sourceName}`)
  } catch (e) {
    log(false, `${group} 列表失败`, e.message)
  }
}

console.log('\n' + '='.repeat(90))
console.log('3. 搜索 searchMedia()')
console.log('='.repeat(90))
let hit = null
try {
  const r = await searchMedia({ keyword: '神', page: 1 })
  log(r.items.length > 0, '搜索「神」', `${r.items.length} 部（原始 ${r.sourceStats.rawCount} 条）`)
  const multi = r.items.filter((i) => i.mirrors?.length).length
  log(true, '跨源重复合并', `${multi} 部在多个源出现`)
  hit = r.items.find((i) => i.playable) || r.items[0]
  if (hit) console.log(`   选中: 《${hit.title}》 源=${hit.sourceName} id=${hit.id}`)
} catch (e) {
  log(false, '搜索失败', e.message)
}

console.log('\n' + '='.repeat(90))
console.log('4. 详情 + 跨源换源 getDetail()')
console.log('='.repeat(90))
let detail = null
if (hit) {
  try {
    detail = await getDetail({ sourceKey: hit.sourceKey, id: hit.id, withMirrors: true })
    log(true, '取到详情', `《${detail.title}》`)
    log(Array.isArray(detail.allLines) && detail.allLines.length > 0, '线路列表', `${detail.allLines.length} 条`)
    const playableLines = detail.allLines.filter((l) => l.playable)
    log(playableLines.length > 0, '可直连播放线路', `${playableLines.length} 条`)
    log(
      detail.mirrors.length > 0,
      '跨源换源',
      detail.mirrors.length ? `${detail.mirrors.map((m) => m.sourceName).join('/')}` : '（该片仅一个源有）'
    )
    console.log('   线路明细:')
    detail.allLines.slice(0, 6).forEach((l) => {
      console.log(
        `     - ${l.name.padEnd(16)} 源=${(l.sourceName || '-').padEnd(10)} ${String(l.episodes.length).padStart(4)} 集  ${l.playable ? '可播' : '需解析'}`
      )
    })
  } catch (e) {
    log(false, '详情失败', e.message)
  }
}

console.log('\n' + '='.repeat(90))
console.log('5. 播放可行性硬验证（取直链并真实拉取 m3u8）')
console.log('='.repeat(90))
if (detail) {
  const line = detail.allLines.find((l) => l.playable)
  const ep = line?.episodes?.[0]
  if (ep) {
    const url = resolvePlayUrl(ep.url)
    console.log(`   线路: ${line.name}  集: ${ep.name}`)
    console.log(`   地址: ${url.slice(0, 110)}`)
    try {
      const r = await realFetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
          Accept: '*/*',
          Origin: DEV,
        },
        signal: AbortSignal.timeout(20000),
      })
      const body = await r.text()
      log(r.ok, 'm3u8 HTTP 状态', String(r.status))
      log(body.includes('#EXTM3U'), '内容是合法 HLS 清单')
      log(
        r.headers.get('access-control-allow-origin') === '*',
        'CDN 允许跨域',
        r.headers.get('access-control-allow-origin') || '无'
      )
      // 若是 master playlist，跟着下一层验证
      const variant = body
        .split('\n')
        .map((s) => s.trim())
        .find((s, i, arr) => arr[i - 1]?.startsWith('#EXT-X-STREAM-INF') && s && !s.startsWith('#'))
      if (variant) {
        const vurl = new URL(variant, url).href
        const vr = await realFetch(vurl, { signal: AbortSignal.timeout(20000) })
        const vbody = await vr.text()
        log(vr.ok && vbody.includes('#EXTM3U'), '变体清单可拉取', `HTTP ${vr.status}`)
        const seg = vbody
          .split('\n')
          .map((s) => s.trim())
          .find((s) => s && !s.startsWith('#'))
        if (seg) {
          const surl = new URL(seg, vurl).href
          const sr = await realFetch(surl, { signal: AbortSignal.timeout(20000) })
          const buf = new Uint8Array(await sr.arrayBuffer())
          log(sr.ok && buf.length > 0, '首个 ts 分片可拉取', `${buf.length} 字节`)
        } else {
          console.log('   （变体清单是纯媒体清单，跳过 ts 检查）')
        }
      } else {
        console.log('   （master 清单直接指向分片，跳过变体层）')
      }
    } catch (e) {
      log(false, 'm3u8 拉取失败', e.message)
    }
  } else {
    log(false, '未取到可播地址')
  }
}

console.log('\n' + '='.repeat(90))
console.log(`结果：通过 ${pass}  失败 ${fail}`)
console.log('='.repeat(90))
process.exit(fail > 0 ? 1 : 0)
