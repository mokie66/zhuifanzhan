/**
 * 生成启动闪屏所需的多密度 PNG
 * ===============================
 * 为什么需要这个脚本：
 *   Windows 的 System.Drawing 没有内置 WebP 解码器，无法直接把用户的
 *   .webp 源图转成安卓资源。Chrome 能解码 WebP，所以先用它渲染出一张
 *   高分辨率 PNG 母图，再用 System.Drawing 缩放出各密度版本。
 *
 * 输出到 tools/splash-out/，由 PowerShell 侧再分发到 android 各 drawable 目录。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'src/assets/splash-source.webp')
const outDir = resolve(root, 'tools/splash-out')

if (!existsSync(src)) {
  console.error('源图不存在:', src)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

// 母图尺寸：9:16，够覆盖 xxxhdpi（1440x2560）且不产生额外放大
const W = 1440
const H = 2560

const b64 = readFileSync(src).toString('base64')
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#eceff5;overflow:hidden}
img{display:block;width:100vw;height:100vh;object-fit:fill}
</style></head><body>
<img src="data:image/webp;base64,${b64}">
</body></html>`

const htmlPath = resolve(outDir, '_render.html')
writeFileSync(htmlPath, html)
console.log(`母图渲染页已生成（目标 ${W}x${H}）`)
console.log(htmlPath)
