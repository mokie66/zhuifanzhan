/**
 * 从 src/api/sources.js 生成生产环境 nginx 配置片段
 *
 * 为什么需要：开发环境的代理是 vite.config.js 里的 Node 中间件实现的，
 * 生产环境必须由 nginx 承担同样的转发（否则 CORS / 混合内容问题会重现）。
 * 手写 nginx 配置容易和 sources.js 脱节，所以这里自动生成，保证单一数据源。
 *
 * 运行：node scripts/gen-nginx.mjs
 * 输出：deploy/nginx-collect.conf
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const { SOURCES, COLLECT_PREFIX } = await import('../src/api/sources.js')

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'deploy')

/** nginx 里 location 名称不能带特殊字符，key 已是纯字母，直接用 */
const lines = []
const A = (s = '') => lines.push(s)

A('# ==========================================================================')
A('# /collect 采集源反向代理配置（由 scripts/gen-nginx.mjs 自动生成，勿手改）')
A('#')
A('# 作用：把浏览器发往 /collect/<key> 的请求转发到真实采集源。')
A('#')
A('# 为什么必须代理：')
A('#   1) 所有采集接口都不返回 Access-Control-Allow-Origin，浏览器直连被 CORS 拦')
A('#   2) 部分源是 http，页面若在 https 下会被混合内容策略拦')
A('#   3) 部分源校验 Referer，需要在服务端补上')
A('#')
A('# 注意：视频 CDN（m3u8/ts）已带 ACAO:*，无需代理，播放由前端 hls.js 直连。')
A('# ==========================================================================')
A()

for (const s of SOURCES) {
  const target = new URL(s.api)
  const origin = `${target.protocol}//${target.host}`
  const basePath = target.pathname.replace(/\/$/, '')

  A(`# ${s.name}（${s.enabled ? '启用' : '默认关闭'}，权重 ${s.weight}）`)
  if (s.note) A(`# ${s.note}`)
  A(`location = ${COLLECT_PREFIX}/${s.key} {`)
  A(`    # 保留原始查询串（ac/pg/t/wd 等），追加到上游采集路径后面`)
  A(`    proxy_pass ${origin}${basePath}/$is_args$args;`)
  A()
  A(`    proxy_http_version 1.1;`)
  A(`    proxy_set_header Host ${target.host};`)
  A(`    proxy_set_header Connection "";`)
  A(`    # 部分采集源会校验 Referer，补成源站自身域名最稳妥`)
  A(`    proxy_set_header Referer ${origin}/;`)
  A(`    proxy_set_header User-Agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";`)
  A()
  A(`    # 采集源普遍较慢，超时给足；并发限制避免打爆上游`)
  A(`    proxy_connect_timeout 10s;`)
  A(`    proxy_send_timeout    30s;`)
  A(`    proxy_read_timeout    30s;`)
  A()
  A(`    # 采集结果不缓存，保证看到最新资源`)
  A(`    proxy_buffering on;`)
  A(`    proxy_buffers 8 32k;`)
  A(`}`)
  A()
  A(`# 兼容带路径的调用形式：/collect/${s.key}/...`)
  A(`location ${COLLECT_PREFIX}/${s.key}/ {`)
  A(`    proxy_pass ${origin}${basePath}/;`)
  A(`    proxy_http_version 1.1;`)
  A(`    proxy_set_header Host ${target.host};`)
  A(`    proxy_set_header Referer ${origin}/;`)
  A(`    proxy_read_timeout 30s;`)
  A(`}`)
  A()
}

// 通用流代理（兜底 http-only 资源在 https 页面下的混合内容问题）
A('# --------------------------------------------------------------------------')
A('# 通用流代理：兜底 http-only 的 m3u8 / ts（页面在 https 下的混合内容场景）')
A('# 前端在 utils/media.js 里按需使用 /collect/_stream?url=<encoded>')
A('# --------------------------------------------------------------------------')
A(`location = ${COLLECT_PREFIX}/_stream {`)
A('    # 用 resolver 动态解析目标域名（不能用 proxy_pass 变量时的静态写法）')
A('    resolver 223.5.5.5 119.29.29.29 valid=300s;')
A('    resolver_timeout 5s;')
A('    set $stream_url $arg_url;')
A('    if ($stream_url = "") { return 400 "missing url param"; }')
A('    proxy_pass $stream_url;')
A('    proxy_http_version 1.1;')
A('    proxy_set_header Host $proxy_host;')
A('    proxy_set_header Connection "";')
A('    proxy_ssl_server_name on;')
A('    proxy_ssl_protocols TLSv1.2 TLSv1.3;')
A('    proxy_connect_timeout 10s;')
A('    proxy_read_timeout 60s;')
A('    add_header Access-Control-Allow-Origin "*" always;')
A('}')
A()
A('# 未配置的 key 直接 404，便于排查前端写错源标识')
A(`location ${COLLECT_PREFIX}/ {`)
A('    return 404 \'{"error":"unknown collect source"}\';')
A('    add_header Content-Type "application/json; charset=utf-8";')
A('}')

mkdirSync(OUT_DIR, { recursive: true })
const outFile = resolve(OUT_DIR, 'nginx-collect.conf')
writeFileSync(outFile, lines.join('\n') + '\n', 'utf-8')

console.log(`已生成 ${outFile}`)
console.log(`包含 ${SOURCES.length} 个采集源，其中启用 ${SOURCES.filter((s) => s.enabled).length} 个`)
