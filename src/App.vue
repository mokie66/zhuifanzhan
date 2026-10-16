<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import BottomTabNav from '@/components/BottomTabNav.vue'
import LaunchSplash from '@/components/LaunchSplash.vue'
import { waitHomeFeedReady } from '@/api/index.js'

// 详情 / 播放器 / 搜索 / 设置页不显示全局底部标签栏
const route = useRoute()
const showTabBar = computed(() => route.meta.tabBar === true)

/* ------------------------------------------------------------------ *
 * 启动闪屏
 *
 * 目标：点图标进入后先展示品牌图，给首页取数争取时间，
 *      避免用户看到空白页或半成品内容。
 *
 * 时长策略：**至少 3 秒，数据没好就再等，但最多约 6.6 秒**。
 *   - 只写死 3 秒的话，冷启动首页要 6~9 秒，闪屏消失后用户还得对着
 *     加载中干等；
 *   - 无限等又会让「数据源全挂」时卡在启动图上出不来。
 *   所以采用「3 秒下限 + 数据就绪提前结束 + 6.6 秒上限」。
 *
 * 注意闪屏盖住的是「首页数据」，不是整个 App —— 底部导航等外壳已经渲染好了，
 * 只是被盖住，淡出后立即可用。
 * ------------------------------------------------------------------ */
const MIN_SHOW_MS = 3000
/** 等数据的上限（相对 onMounted 计时，加上前面的小延迟，总时长约 6.6 秒） */
const MAX_WAIT_MS = 6500
const FADE_MS = 500

const splashVisible = ref(true)
const splashLeaving = ref(false)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

onMounted(async () => {
  const t0 = Date.now()

  // 路由是懒加载的，HomeView 可能比 App 稍晚挂载。
  // 稍等一下让它的请求先发出去，否则这里会立刻判定「没有请求在进行」而返回。
  await sleep(120)

  // 只等待，不触发请求 —— 避免抢占 getHomeFeed 的并发去重（详见 api/index.js）
  await waitHomeFeedReady(MAX_WAIT_MS)

  // 满足最短展示时间
  const remain = MIN_SHOW_MS - (Date.now() - t0)
  if (remain > 0) await sleep(remain)

  splashLeaving.value = true
  await sleep(FADE_MS)
  splashVisible.value = false
})

/**
 * 主内容区底部留白
 *
 * 显示底部标签栏时，需要同时避开：
 *   - 标签栏自身高度（56px）
 *   - 手势导航条安全区（--safe-bottom）
 *   - 一点视觉呼吸（16px）
 * 所以在 CSS 里用 calc 拼出来，而不是写死一个 pb-[72px]
 * （写死的话在带手势条的机型上最后一行内容会被遮住）。
 */
const mainStyle = computed(() =>
  showTabBar.value
    ? { paddingBottom: 'calc(56px + var(--safe-bottom) + 16px)' }
    : { paddingBottom: 'calc(var(--safe-bottom) + 32px)' }
)
</script>

<template>
  <div
    class="mx-auto flex min-h-screen max-w-md flex-col bg-background font-sans text-foreground antialiased"
  >
    <AppHeader />
    <main class="flex-1" :style="mainStyle">
      <router-view />
    </main>
    <BottomTabNav v-if="showTabBar" />

    <!-- 启动闪屏：盖在最上层，淡出后卸载 -->
    <LaunchSplash :visible="splashVisible" :leaving="splashLeaving" />
  </div>
</template>
