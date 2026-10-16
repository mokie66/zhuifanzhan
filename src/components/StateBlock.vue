<script setup>
/**
 * 状态占位块：加载中 / 空数据 / 错误
 * 统一各处列表页的状态展示，避免每个视图各写一套
 */
import { AlertCircle, Inbox, Loader2, RefreshCw } from 'lucide-vue-next'

defineProps({
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  empty: { type: Boolean, default: false },
  loadingText: { type: String, default: '加载中…' },
  emptyText: { type: String, default: '暂无内容' },
  /** 错误时是否显示重试按钮 */
  retryable: { type: Boolean, default: true },
  /** 骨架屏高度，用于列表占位 */
  skeleton: { type: Boolean, default: false },
  skeletonCount: { type: Number, default: 6 },
})

const emit = defineEmits(['retry'])
</script>

<template>
  <!-- 骨架屏：列表首屏加载时给到更接近真实的布局，减少跳动 -->
  <div v-if="loading && skeleton" class="grid grid-cols-2 gap-3">
    <div
      v-for="i in skeletonCount"
      :key="i"
      class="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div class="poster-ratio animate-pulse bg-muted"></div>
      <div class="space-y-2 p-2.5">
        <div class="h-3 w-3/4 animate-pulse rounded bg-muted"></div>
        <div class="h-2.5 w-1/2 animate-pulse rounded bg-muted"></div>
      </div>
    </div>
  </div>

  <!-- 错误态 -->
  <div
    v-else-if="error"
    class="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center"
  >
    <AlertCircle class="h-8 w-8 text-destructive" />
    <p class="text-caption text-muted-foreground">{{ error }}</p>
    <button
      v-if="retryable"
      type="button"
      class="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-4 text-caption text-primary"
      @click="emit('retry')"
    >
      <RefreshCw class="h-4 w-4" />
      <span>重试</span>
    </button>
  </div>

  <!-- 空态 -->
  <div
    v-else-if="empty"
    class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center"
  >
    <Inbox class="h-8 w-8 text-muted-foreground/50" />
    <p class="text-caption text-muted-foreground">{{ emptyText }}</p>
  </div>

  <!-- 简单加载态 -->
  <div
    v-else-if="loading"
    class="flex items-center justify-center gap-2 px-6 py-12 text-muted-foreground"
  >
    <Loader2 class="h-5 w-5 animate-spin" />
    <span class="text-caption">{{ loadingText }}</span>
  </div>
</template>
