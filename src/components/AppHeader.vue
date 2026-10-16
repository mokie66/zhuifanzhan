<script setup>
// 全局顶部栏：品牌标识 + 搜索快捷入口（设计稿共享外壳片段）
import { Search } from 'lucide-vue-next'
</script>

<template>
  <header class="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-background px-4">
    <router-link to="/" class="flex items-center gap-2">
      <span class="h-2 w-2 rounded-full bg-primary"></span>
      <span class="text-[15px] font-semibold text-foreground">追番站</span>
    </router-link>
    <div class="flex-1"></div>
    <router-link
      to="/search"
      aria-label="搜索"
      class="inline-flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground"
    >
      <Search class="h-[18px] w-[18px]" />
    </router-link>
  </header>
</template>
