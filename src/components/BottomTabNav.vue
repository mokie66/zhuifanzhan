<script setup>
// 全局底部标签栏：首页 / 电视剧 / 动漫 / 我的
//
// 安全区处理：手势导航条会占住屏幕最底部。这里用 .tabbar-safe 给底部加
// padding-bottom，把图标上移到手势条上方；导航栏背景仍延伸到屏幕底部。
// 详见 styles/theme.css 中安全区一节的说明。
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Heart, House, Sparkles, Tv } from 'lucide-vue-next'

const route = useRoute()

const items = [
  { key: 'home', label: '首页', icon: House, to: '/' },
  { key: 'tv', label: '电视剧', icon: Tv, to: '/tv' },
  { key: 'anime', label: '动漫', icon: Sparkles, to: '/anime' },
  { key: 'library', label: '我的', icon: Heart, to: '/library' },
]

const activeKey = computed(() => route.meta.navKey)
</script>

<template>
  <nav class="tabbar-safe fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-card">
    <div class="mx-auto grid h-[56px] w-full max-w-md grid-cols-4">
      <router-link
        v-for="item in items"
        :key="item.key"
        :to="item.to"
        :aria-current="activeKey === item.key ? 'page' : undefined"
        class="flex h-full min-w-0 flex-col items-center justify-center gap-0.5 px-1"
        :class="activeKey === item.key ? 'text-primary font-medium' : 'text-muted-foreground'"
      >
        <component :is="item.icon" class="h-5 w-5 shrink-0" />
        <span class="max-w-full truncate text-[11px] leading-none whitespace-nowrap">{{ item.label }}</span>
      </router-link>
    </div>
  </nav>
</template>
