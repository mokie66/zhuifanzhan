/**
 * Node ESM 加载器：让 src 里的 `@/` 别名在 Node 下也能解析
 * 这样验证脚本可以直接 import 项目里的真实模块，而不是复制一份逻辑。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { existsSync, statSync } from 'node:fs'

const SRC = resolvePath(fileURLToPath(new URL('../src', import.meta.url)))

/** 尝试补全扩展名（Vue 项目里 import 常省略 .js） */
function resolveFile(base) {
  const candidates = [base, base + '.js', base + '.mjs', resolvePath(base, 'index.js')]
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return pathToFileURL(c).href
    } catch {
      /* 忽略 */
    }
  }
  return null
}

export function resolve(specifier, context, nextResolve) {
  // 处理 '@/xxx'
  if (specifier.startsWith('@/')) {
    const target = resolvePath(SRC, specifier.slice(2))
    const url = resolveFile(target)
    if (url) return { url, shortCircuit: true }
  }
  // 处理 './xxx.js' 形式的相对导入（já由 Node 处理，这里只兜底缺扩展名的）
  return nextResolve(specifier, context)
}
