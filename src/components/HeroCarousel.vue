<script setup>
/**
 * 首页主视觉轮播（内容型）—— 当前未使用
 * ==========================================
 * 首页主视觉已改用 PromoCarousel 展示推广图，本组件暂时闲置。
 * 保留原因：如果以后想换回「展示采集源实时内容」的主视觉，
 * 把 HomeView 里的 <PromoCarousel /> 换回
 *   <HeroCarousel v-if="heroItems.length" :items="heroItems" @select="..." />
 * 即可（heroItems 的构造逻辑见 git 历史 eb6f0ef 之前的 HomeView）。
 * 若确定不再需要，可以连同这段说明一起删除。
 *
 * 设计取舍说明
 * ------------
 * 采集源只提供竖版海报（vod_pic），实测 100 条样本里 vod_pic_slide（横版图）
 * 命中率 0%，所以拿不到适合横幅的横图。
 *
 * 之前曾把竖版海报用 object-cover 拉满整条横幅，结果是：
 *   - 海报被横向裁掉大半，构图完全破坏
 *   - 海报自带的电影节桂冠、水印文字被截断，看着很乱
 *
 * 本组件的做法是行业通用方案：
 *   - 背景：同一张海报放大 + 模糊 + 压暗，只作为氛围底色
 *   - 前景：海报按 2:3 原始比例完整显示，不裁切
 *   - 信息：标题/元数据/评分放在海报右侧，白字压在暗背景上
 * 这样任何比例的竖版海报都不会被破坏。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronRight, Play, Star } from 'lucide-vue-next'
import { formatMeta, formatStatus } from '@/utils/format.js'

const props = defineProps({
  /** 待轮播的影片列表（建议 3~6 条） */
  items: { type: Array, default: () => [] },
  /** 自动切换间隔（毫秒），0 表示不自动切换 */
  interval: { type: Number, default: 5000 },
})

const emit = defineEmits(['select'])

const index = ref(0)
const paused = ref(false)
let timer = null

const total = computed(() => props.items.length)
const current = computed(() => props.items[index.value] || null)

/** 指示点最多显示 5 个，超出时收敛，避免小屏挤成一排 */
const dots = computed(() => props.items.slice(0, 5))

function goTo(i) {
  if (!total.value) return
  index.value = (i + total.value) % total.value
}

function next() {
  goTo(index.value + 1)
}

function startTimer() {
  stopTimer()
  if (!props.interval || total.value <= 1) return
  timer = setInterval(() => {
    // 页面不可见时不推进，避免后台空转
    if (!paused.value && document.visibilityState === 'visible') next()
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
  if (Math.abs(dx) < 40) return // 小于阈值视为点击
  goTo(index.value + (dx < 0 ? 1 : -1))
}

function onSelect() {
  if (current.value) emit('select', current.value)
}

/** 列表变化时重置索引并重启计时器 */
watch(
  () => props.items,
  () => {
    if (index.value >= total.value) index.value = 0
    startTimer()
  }
)

onMounted(startTimer)
onBeforeUnmount(stopTimer)
</script>

<template>
  <section v-if="current" class="relative">
    <div
      class="relative overflow-hidden rounded-lg bg-black"
      @mouseenter="paused = true"
      @mouseleave="paused = false"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd"
    >
      <!-- 背景：同一张海报放大模糊，只作氛围底色，不承担信息传达 -->
      <transition name="hero-fade">
        <div :key="index" class="absolute inset-0">
          <img
            v-if="current.poster"
            :src="current.poster"
            alt=""
            aria-hidden="true"
            class="h-full w-full scale-125 object-cover blur-xl"
            referrerpolicy="no-referrer"
          >
          <!-- 压暗 + 左侧加重，保证白字可读 -->
          <div class="absolute inset-0 bg-black/45"></div>
          <div class="absolute inset-0 bg-gradient-to-r from-black/75 via-black/45 to-black/25"></div>
        </div>
      </transition>

      <!-- 前景内容 -->
      <div class="relative flex gap-3 p-3.5">
        <!-- 竖版海报：按原始比例完整显示，绝不裁切 -->
        <button
          type="button"
          class="shrink-0 overflow-hidden rounded-md shadow-lg ring-1 ring-white/15"
          :aria-label="`查看《${current.title}》`"
          @click="onSelect"
        >
          <img
            v-if="current.poster"
            :src="current.poster"
            :alt="`《${current.title}》海报`"
            class="h-[118px] w-[79px] object-cover"
            referrerpolicy="no-referrer"
          >
          <div v-else class="flex h-[118px] w-[79px] items-center justify-center bg-muted">
            <Play class="h-6 w-6 text-muted-foreground/60" />
          </div>
        </button>

        <!-- 信息区 -->
        <div class="flex min-w-0 flex-1 flex-col justify-between py-0.5">
          <div class="min-w-0">
            <h2 class="line-clamp-2 text-[17px] font-semibold leading-snug text-white">
              {{ current.title }}
            </h2>
            <p class="mt-1 truncate text-[11px] text-white/70">{{ formatMeta(current) }}</p>

            <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span
                v-if="current.score > 0"
                class="inline-flex h-5 items-center gap-0.5 rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground"
              >
                <Star class="h-3 w-3 fill-current" />{{ current.score.toFixed(1) }}
              </span>
              <span
                v-if="formatStatus(current)"
                class="inline-flex h-5 items-center rounded-full bg-white/15 px-1.5 text-[11px] text-white/90"
              >{{ formatStatus(current) }}</span>
            </div>
          </div>

          <button
            type="button"
            class="mt-2 inline-flex h-8 items-center gap-1 self-start rounded-full bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-transform active:scale-[0.97] motion-reduce:transform-none"
            @click="onSelect"
          >
            <Play class="h-3.5 w-3.5" />
            <span>查看详情</span>
            <ChevronRight class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>

    <!-- 指示点 -->
    <div v-if="total > 1" class="absolute bottom-2 right-3 flex items-center gap-1.5">
      <button
        v-for="(_, i) in dots"
        :key="i"
        type="button"
        class="h-1.5 rounded-full transition-all"
        :class="i === index ? 'w-4 bg-primary' : 'w-1.5 bg-white/45'"
        :aria-label="`切换到第 ${i + 1} 个`"
        @click="goTo(i)"
      ></button>
    </div>
  </section>
</template>

<style scoped>
/* 背景切换做淡入淡出，避免直接跳变显得生硬 */
.hero-fade-enter-active,
.hero-fade-leave-active {
  transition: opacity 0.45s ease;
}
.hero-fade-enter-from,
.hero-fade-leave-to {
  opacity: 0;
}
</style>
