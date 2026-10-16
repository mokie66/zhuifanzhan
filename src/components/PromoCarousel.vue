<script setup>
/**
 * 推广图轮播（首页主视觉）
 * ========================
 * 与原 HeroCarousel 的区别
 * ------------------------
 * HeroCarousel 展示的是「内容」—— 从采集源实时取来的影片，带标题/评分/线路信息，
 * 海报是竖版（2:3），需要模糊背景来填充横幅的留白。
 * 本组件展示的是「推广图」—— 已经做好排版的横版图片（16:9），
 * 图里自带了文案和构图，所以直接整张显示即可，不该再做任何裁切或叠加。
 *
 * 尺寸取舍
 * --------
 * 图片实际是 2092x1169（宽高比 1.790），用 aspect-ratio 精确跟随，
 * 不做 object-cover 裁切 —— 这些图左右两侧都有文案和人物，
 * 一旦裁切就会切掉内容。手机上一张图约 200px 高，是比较标准的横幅比例。
 *
 * 为什么按需加载
 * --------------
 * 四张图合计约 1.1 MB。一次性全加载会显著拖慢首屏，
 * 而首页刚刚才做过「20 秒 → 秒开」的优化，不能被图片把成果吃回去。
 * 所以：只挂载当前这一张，并在显示后预加载下一张，让切换不卡顿。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import img1 from '@/assets/banners/promo-1-desk.webp'
import img2 from '@/assets/banners/promo-2-friends.webp'
import img3 from '@/assets/banners/promo-3-newanime.webp'
import img4 from '@/assets/banners/promo-4-list.webp'

const props = defineProps({
  /** 自动切换间隔（毫秒），0 表示不自动切换 */
  interval: { type: Number, default: 5000 },
})

/** 顺序：日常氛围 → 社交 → 追新 → 追番清单，由泛到具体 */
const slides = [
  { src: img1, alt: '深夜追番' },
  { src: img2, alt: '和好友一起追番' },
  { src: img3, alt: '今日新番速递' },
  { src: img4, alt: '本周追番清单' },
]

const index = ref(0)
/** 已请求过的下标：只有进入过这里（或相邻）的图片才被挂载 */
const activated = ref(new Set([0, 1]))
const paused = ref(false)
let timer = null

const total = slides.length

/**
 * 需要渲染的幻灯片
 *
 * 注意不能写在同一元素上用 v-for + v-if：
 * Vue 3 中 v-if 的优先级高于 v-for，此时循环变量 i 还未定义会直接报错。
 * 所以在这里先把「下标」和「是否已激活」算好，模板里只做 v-for。
 */
const visibleSlides = computed(() =>
  slides.map((s, i) => ({ ...s, i })).filter((s) => activated.value.has(s.i))
)

function activate(i) {
  const k = ((i % total) + total) % total
  if (!activated.value.has(k)) {
    // Set 是引用类型，替换成新实例才能触发响应式更新
    const next = new Set(activated.value)
    next.add(k)
    activated.value = next
  }
}

function goTo(i) {
  index.value = ((i % total) + total) % total
  // 提前激活相邻两张，滑动时不会看到空白
  activate(index.value + 1)
}

function startTimer() {
  stopTimer()
  if (!props.interval || total <= 1) return
  timer = setInterval(() => {
    // 页面不可见时不推进，避免后台空转
    if (!paused.value && document.visibilityState === 'visible') goTo(index.value + 1)
  }, props.interval)
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 手指滑动切换 */
let touchStartX = 0
function onTouchStart(e) {
  touchStartX = e.changedTouches[0].clientX
}
function onTouchEnd(e) {
  const dx = e.changedTouches[0].clientX - touchStartX
  if (Math.abs(dx) < 40) return
  goTo(index.value + (dx < 0 ? 1 : -1))
}

watch(index, () => startTimer())
onMounted(startTimer)
onBeforeUnmount(stopTimer)
</script>

<template>
  <section
    data-testid="promo-carousel"
    class="relative overflow-hidden rounded-lg bg-muted"
    @mouseenter="paused = true"
    @mouseleave="paused = false"
    @touchstart.passive="onTouchStart"
    @touchend.passive="onTouchEnd"
  >
    <!-- 用图片自身的宽高比，不裁切任何内容 -->
    <div data-testid="promo-frame" class="relative aspect-[2092/1169] w-full">
      <!--
        用 CSS opacity 过渡代替 <transition-group>：
        这些图是绝对定位互相叠放，opacity 过渡更简单也更稳。
      -->
      <img
        v-for="s in visibleSlides"
        :key="s.src"
        :src="s.src"
        :alt="s.alt"
        class="absolute inset-0 h-full w-full object-cover transition-opacity duration-500 motion-reduce:transition-none"
        :class="s.i === index ? 'opacity-100' : 'opacity-0'"
        :loading="s.i === 0 ? 'eager' : 'lazy'"
        decoding="async"
        draggable="false"
      >
    </div>

    <!-- 指示点：点击可跳转 -->
    <div
      v-if="total > 1"
      data-testid="promo-dots"
      class="absolute bottom-2.5 right-3 flex items-center gap-1.5"
    >
      <button
        v-for="(s, i) in slides"
        :key="`dot-${i}`"
        type="button"
        class="h-1.5 rounded-full transition-all"
        :class="i === index ? 'w-4 bg-white' : 'w-1.5 bg-white/50'"
        :aria-label="`查看第 ${i + 1} 张`"
        :aria-current="i === index ? 'true' : undefined"
        @click="goTo(i)"
      ></button>
    </div>
  </section>
</template>

<style scoped>
/* 淡入淡出切换，避免直接跳变 */
.promo-fade-enter-active,
.promo-fade-leave-active {
  transition: opacity 0.45s ease;
}
.promo-fade-enter-from,
.promo-fade-leave-to {
  opacity: 0;
}
</style>
