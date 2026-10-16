<script setup>
// 全局顶部栏：品牌标识 + 搜索快捷入口
//
// 安全区处理：Android 15+ 强制边到边，内容会绘制到状态栏后面。
// 这里用 .header-safe 给顶部加 padding-top，把内容下沉到状态栏下方；
// header 自身的背景仍延伸到屏幕顶部（观感更完整）。
// 详见 styles/theme.css 中安全区一节的说明。
import { Search } from 'lucide-vue-next'
</script>

<template>
  <header
    class="header-safe sticky top-0 z-30 border-b border-border bg-background"
  >
    <div class="flex h-12 items-center gap-3 px-4">
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
    </div>
  </header>
</template>
