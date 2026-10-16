<script setup>
// 全局底部标签栏：首页 / 电视剧 / 动漫 / 我的（设计稿移动端导航契约）
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
  <nav class="fixed bottom-0 left-0 right-0 z-40 h-[56px] border-t border-border bg-card">
    <div class="mx-auto grid h-full w-full max-w-md grid-cols-4">
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
