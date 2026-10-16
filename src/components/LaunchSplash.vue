<script setup>
/**
 * 启动闪屏覆盖层
 * ================
 * 作用：点图标进入 App 后先展示这张图，给首页取数争取时间，避免用户
 * 看到空白页或半成品内容；展示满 3 秒后淡出进入首页。
 *
 * 为什么由 Web 层来做，而不是只用原生闪屏
 * ----------------------------------------
 * 本项目 targetSdk 36，Android 12+ 会启用**系统闪屏**。系统闪屏只支持
 * 「背景色 + 居中图标」，**无法全屏显示一张图片**，且持续时间不可控。
 * 所以全屏图必须由 Web 层覆盖层来显示；原生闪屏只负责「点开瞬间」那一下，
 * 两者用同一个背景色衔接，避免闪白。
 *
 * 图片适配（关键取舍）
 * --------------------
 * 图片是竖版 9:16（宽高比 0.5625），而手机屏普遍是 20:9（约 0.45）——
 * 屏幕比图片更「瘦长」。两种铺法：
 *   cover —— 左右各裁掉约 10%，而图片左上角正好是 logo 与「开启精彩追番」
 *            文案，会被切掉，不可接受；
 *   contain —— 完整显示，但上下各留白约 87px。
 * 所以选 contain，并把留白区域填成**与图片上下边缘一致的颜色渐变**，
 * 让留白看起来像图片本身在延伸，而不是两条突兀的色带。
 * 渐变分界点按真实屏幕比例用 JS 算出来，保证接缝处颜色精确衔接。
 */
import { computed } from 'vue'

const props = defineProps({
  /** 是否可见（父组件控制，淡出期间仍为 true） */
  visible: { type: Boolean, default: true },
  /** 是否处于淡出过程 */
  leaving: { type: Boolean, default: false },
})

/** 源图宽高比（1152x2048） */
const IMG_RATIO = 1152 / 2048

/** 图片上下边缘的实测平均色（见 scripts/gen-splash-master.mjs 生成的母图） */
const EDGE_TOP = '#9098B4'
const EDGE_BOTTOM = '#7282A4'

/**
 * 计算背景渐变。
 *
 * 图片按 contain 摆放后垂直居中，占屏高 IMG_RATIO 对应的比例。
 * 渐变在「留白区」保持图片边缘色，在「图片区」从顶色过渡到底色，
 * 这样留白与图片的交界处颜色是一致的（不会出现色带接缝）。
 */
const backgroundStyle = computed(() => {
  const w = typeof window !== 'undefined' ? window.innerWidth : 390
  const h = typeof window !== 'undefined' ? window.innerHeight : 844
  if (!w || !h) return { background: EDGE_TOP }

  const screenRatio = w / h
  // 屏幕比图片更宽（如平板/横屏）时不会留白，直接铺图片边缘色
  if (screenRatio >= IMG_RATIO) {
    return { background: EDGE_TOP }
  }

  // 图片按宽度撑满后的高度占屏比
  const imgHeightPct = w / IMG_RATIO / h
  const padPct = ((1 - imgHeightPct) / 2) * 100
  const bottomStart = 100 - padPct

  return {
    background: `linear-gradient(to bottom, ${EDGE_TOP} 0%, ${EDGE_TOP} ${padPct.toFixed(2)}%, ${EDGE_BOTTOM} ${bottomStart.toFixed(2)}%, ${EDGE_BOTTOM} 100%)`,
  }
})
</script>

<template>
  <div
    v-if="visible"
    data-testid="launch-splash"
    class="fixed inset-0 z-[999] flex items-center justify-center transition-opacity duration-500 motion-reduce:transition-none"
    :class="leaving ? 'opacity-0' : 'opacity-100'"
    :style="backgroundStyle"
    aria-hidden="true"
  >
    <img
      src="@/assets/splash-source.webp"
      alt=""
      class="h-full w-full object-contain"
      draggable="false"
    >
  </div>
</template>
