import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { SOURCES, COLLECT_PREFIX } from './src/api/sources.js'

/**
 * 采集源代理插件
 * ================
 * 背景：所有采集接口都不返回 Access-Control-Allow-Origin，浏览器无法直连；
 *       部分源还是 http，若页面跑在 https 下还会被混合内容策略拦掉。
 *
 * 方案：前端统一请求同源路径 `/collect/<key>/...`，由这里在服务端转发到真实源。
 *       这样 CORS、混合内容、Referer 防盗链三个问题一次性解决，
 *       浏览器侧代码完全不需要关心源站在哪。
 *
 * 生产环境需要 nginx 做同样的转发，见 deploy/nginx.conf。
 */
function collectProxyPlugin() {
  const byKey = new Map(SOURCES.map((s) => [s.key, s]))

  return {
    name: 'collect-proxy',
    configureServer(server) {
      server.middlewares.use(COLLECT_PREFIX, async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        // 形如 /collect/lzi  →  pathname = '/lzi'
        const key = decodeURIComponent(url.pathname.replace(/^\/+/, '').split('/')[0] || '')

        // 通用流代理：/collect/_stream?url=<encoded>
        // 用于兜底播放 http-only 的 m3u8（页面在 https 下的混合内容场景）
        if (key === '_stream') {
          return streamProxy(url, res)
        }

        const source = byKey.get(key)
        if (!source) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: `未配置的采集源: ${key}` }))
          return
        }

        // 目标地址 = 源接口地址 + 原样携带的查询串
        const target = new URL(source.api)
        url.searchParams.forEach((v, k) => target.searchParams.append(k, v))

        const t0 = Date.now()
        try {
          const upstream = await fetch(target.toString(), {
            headers: {
              // 伪装成普通浏览器，避免个别源对非浏览器 UA 返回空
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              Accept: 'application/json, text/plain, */*',
              'Accept-Language': 'zh-CN,zh;q=0.9',
              // 部分源校验 Referer，用源站自身域名最稳
              Referer: `${target.protocol}//${target.host}/`,
            },
            // 采集源普遍较慢，给足超时
            signal: AbortSignal.timeout(25000),
          })

          const body = Buffer.from(await upstream.arrayBuffer())
          res.statusCode = upstream.status
          res.setHeader(
            'Content-Type',
            upstream.headers.get('content-type') || 'application/json; charset=utf-8'
          )
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('X-Collect-Source', source.key)
          res.setHeader('X-Collect-Upstream-Ms', String(Date.now() - t0))
          res.end(body)
        } catch (err) {
          const msg =
            err?.name === 'TimeoutError'
              ? '上游采集源超时（25s）'
              : `上游请求失败: ${err?.message || err}`
          res.statusCode = 504
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: msg, source: source.key }))
        }
      })
    },
  }
}

/** 通用流代理：把远程 m3u8 / ts 原样取回，用于混合内容兜底 */
async function streamProxy(url, res) {
  const raw = url.searchParams.get('url')
  if (!raw) {
    res.statusCode = 400
    res.end('缺少 url 参数')
    return
  }
  let target
  try {
    target = new URL(raw)
  } catch {
    res.statusCode = 400
    res.end('url 参数非法')
    return
  }
  if (!/^https?:$/.test(target.protocol)) {
    res.statusCode = 400
    res.end('仅支持 http/https')
    return
  }
  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
          '(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        Accept: '*/*',
        Referer: `${target.protocol}//${target.host}/`,
      },
      signal: AbortSignal.timeout(20000),
    })
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.statusCode = upstream.status
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'application/octet-stream'
    )
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'no-store')
    res.end(buf)
  } catch (err) {
    res.statusCode = 502
    res.end(`流代理失败: ${err?.message || err}`)
  }
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), collectProxyPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
    watch: {
      // 忽略原子写入产生的临时目录。
      // 不忽略的话，Windows 上编辑器/工具写入文件时会产生
      // `.xxx.tmpdir/xxx.tmp` 这类路径，Vite 的 chokidar 去 watch 它们会抛
      // EBUSY: resource busy or locked 并直接让 dev server 崩溃。
      ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/*.swp', '**/.~*'],
    },
  },
})
