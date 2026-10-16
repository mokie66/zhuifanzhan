/**
 * 采集源：内置默认列表 + 纯工具函数
 * ==================================
 * 这个文件只放**打包进 App 的默认源**，以及不依赖运行环境的纯函数。
 *
 * 运行时生效的源列表由 config.js 管理（支持远程更新 / 手动覆盖），
 * 业务代码请一律通过 config.js 的 enabledSources() / getSource() 取值，
 * 不要直接 import 这里的 BUNDLED_SOURCES —— 否则远程配置会失效。
 *
 * 本文件同时被两处引用：
 *   1. vite.config.js（Node 侧）—— 用它生成开发代理
 *   2. scripts/gen-nginx.mjs  —— 用它生成生产 nginx 配置
 * 所以这里只能写纯数据，不能引入浏览器或 Node 专有 API。
 *
 * ===== 关于 CORS（重要） =====
 * 实测：所有采集接口都不返回 Access-Control-Allow-Origin，浏览器无法直连。
 * 因此浏览器版请求统一走同源路径 `/collect/<key>/...`，
 * 由开发服务器或生产 nginx 转发到真实源。
 * 原生 App 走 Capacitor 原生 HTTP，不受同源策略限制，可直接连源站
 * （详见 src/api/transport.js）。
 *
 * ===== 关于 type_id（重要） =====
 * 各源的分类编号体系互不相同（同为电影，有的源是 type_id=1，有的是 7）。
 * 因此**禁止跨源硬编码 type_id**。正确做法：运行时读取每个源自己的
 * 分类表，再按名称语义归一到统一的 group（见 taxonomy.js）。
 */

/** 采集源的请求路径前缀，与 vite.config.js / nginx 配置保持一致 */
export const COLLECT_PREFIX = '/collect'

/**
 * 内置默认采集源
 *
 * weight：聚合时的优先级。冲突去重时优先保留 weight 高的源；
 *         同时用于给搜索结果排序（高权重源的结果靠前）。
 * enabled：是否参与聚合。
 */
export const BUNDLED_SOURCES = [
  {
    key: 'lzi',
    name: '量子资源',
    api: 'http://cj.lziapi.com/api.php/provide/vod/',
    enabled: true,
    weight: 100,
    note: '延迟最低（约 0.3s），线路含直链 m3u8，实测可播',
  },
  {
    key: 'ffzy',
    name: '非凡资源',
    api: 'http://cj.ffzyapi.com/api.php/provide/vod/',
    enabled: true,
    weight: 95,
    note: '响应快，两条线路，实测可播',
  },
  {
    key: 'iqiyi',
    name: '爱奇艺资源',
    api: 'https://www.iqiyizyapi.com/api.php/provide/vod/',
    enabled: true,
    weight: 90,
    note: '字段完整度高，实测可播',
  },
  {
    key: 'dytt',
    name: '电影天堂',
    api: 'http://caiji.dyttzyapi.com/api.php/provide/vod/',
    enabled: true,
    weight: 88,
    note: '评分高、完整度好，实测可播',
  },
  {
    key: 'modu',
    name: '魔都资源',
    api: 'https://caiji.moduapi.cc/api.php/provide/vod/',
    enabled: true,
    weight: 85,
    note: '资源量约 9 万，实测可播',
  },
  {
    key: 'tyys',
    name: '天涯资源',
    api: 'http://tyyszy.com/api.php/provide/vod',
    enabled: true,
    weight: 82,
    note: '延迟低，作为量子/非凡的备份线路；不支持搜索',
  },
  {
    key: 'zuida',
    name: '最大资源',
    api: 'https://zuida.xyz/api.php/provide/vod/',
    enabled: true,
    weight: 78,
    note: '分类数多（59），资源量约 12 万',
  },
  {
    key: 'bfzy',
    name: '暴风资源',
    api: 'https://bfzyapi.com/api.php/provide/vod/',
    enabled: false,
    weight: 75,
    note: '资源量最大（16 万）但响应慢（3s+）且易超时，默认关闭',
  },
]

/**
 * 兼容别名：vite.config.js 与 gen-nginx.mjs 在构建期读取内置列表生成代理配置。
 * 业务代码请改用 config.js 的 enabledSources()。
 */
export const SOURCES = BUNDLED_SOURCES

/** 从内置列表按 key 找源（仅构建期/兜底使用） */
export function getBundledSource(key) {
  return BUNDLED_SOURCES.find((s) => s.key === key) || null
}

/**
 * 把采集源转换成同源代理路径。
 * 例：proxyUrl(src, {ac:'detail', pg:1}) → '/collect/lzi?ac=detail&pg=1'
 */
export function proxyUrl(sourceOrKey, query) {
  const key = typeof sourceOrKey === 'string' ? sourceOrKey : sourceOrKey.key
  const usp = new URLSearchParams()
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') usp.append(k, String(v))
    })
  }
  const qs = usp.toString()
  return `${COLLECT_PREFIX}/${key}${qs ? '?' + qs : ''}`
}
