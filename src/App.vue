<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import BottomTabNav from '@/components/BottomTabNav.vue'

// 详情 / 播放器 / 搜索页不显示全局底部标签栏（与设计稿一致）
const route = useRoute()
const showTabBar = computed(() => route.meta.tabBar === true)
</script>

<template>
  <div class="mx-auto flex min-h-screen max-w-md flex-col bg-background font-sans text-foreground antialiased">
    <AppHeader />
    <main class="flex-1" :class="showTabBar ? 'pb-[72px]' : 'pb-8'">
      <router-view />
    </main>
    <BottomTabNav v-if="showTabBar" />
  </div>
</template>
