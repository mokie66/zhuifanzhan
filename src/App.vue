<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import BottomTabNav from '@/components/BottomTabNav.vue'

// 详情 / 播放器 / 搜索 / 设置页不显示全局底部标签栏
const route = useRoute()
const showTabBar = computed(() => route.meta.tabBar === true)

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
  </div>
</template>
