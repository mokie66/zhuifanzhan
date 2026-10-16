<script setup>
/**
 * 影片海报卡片
 * 复用于首页 / 分类列表 / 搜索结果 / 收藏
 */
import { computed } from 'vue'
import { Play, Star } from 'lucide-vue-next'
import { formatStatus, formatMeta } from '@/utils/format.js'

const props = defineProps({
  vod: { type: Object, required: true },
  /** 徽标文案（如「24 集」「更新至 12 集」） */
  badge: { type: String, default: '' },
  /** 是否显示评分 */
  showScore: { type: Boolean, default: true },
  /** 是否显示简介（搜索结果用） */
  showIntro: { type: Boolean, default: false },
  /** 高亮的关键词片段（搜索结果用） */
  highlight: { type: String, default: '' },
})

const status = computed(() => props.badge || formatStatus(props.vod))
const meta = computed(() => formatMeta(props.vod))
const scoreText = computed(() => (props.vod.score > 0 ? props.vod.score.toFixed(1) : ''))
/** 无海报时用主色渐变占位，避免出现破图 */
const hasPoster = computed(() => Boolean(props.vod.poster))
</script>

<template>
  <article class="overflow-hidden rounded-lg border border-border bg-card">
    <div class="poster-ratio relative bg-muted">
      <img
        v-if="hasPoster"
        :src="vod.poster"
        :alt="`《${vod.title}》海报`"
        class="h-full w-full object-cover"
        loading="lazy"
        referrerpolicy="no-referrer"
        @error="(e) => (e.target.style.display = 'none')"
      >
      <div
        v-else
        class="flex h-full w-full items-center justify-center bg-gradient-to-br from-muted to-card"
      >
        <Play class="h-7 w-7 text-muted-foreground/60" />
      </div>

      <span
        v-if="status"
        class="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] tabular-nums text-white"
      >{{ status }}</span>

      <!-- 多源提示：该片在多个源有资源时给个轻量标识 -->
      <span
        v-if="vod.mirrors?.length"
        class="absolute left-2 top-2 rounded-full bg-primary/90 px-2 py-0.5 text-[10px] text-primary-foreground"
      >{{ vod.mirrors.length + 1 }} 源</span>

      <!-- 不可播提示 -->
      <span
        v-if="vod.playable === false"
        class="absolute bottom-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-white/85"
      >暂不可播</span>
    </div>

    <div class="space-y-1 p-2.5">
      <h3 class="truncate text-[13px] font-medium text-card-foreground">
        <template v-if="highlight">
          <span class="text-primary">{{ highlight }}</span><span>{{ vod.title.replace(highlight, '') }}</span>
        </template>
        <template v-else>{{ vod.title }}</template>
      </h3>

      <p v-if="meta" class="truncate text-[11px] text-muted-foreground">{{ meta }}</p>

      <p v-if="showIntro && vod.intro" class="line-clamp-2 text-[11px] text-muted-foreground">
        {{ vod.intro }}
      </p>

      <p
        v-if="showScore && scoreText"
        class="flex items-center gap-1 text-[11px] tabular-nums text-primary"
      >
        <Star class="h-3.5 w-3.5" />{{ scoreText }}
      </p>
    </div>
  </article>
</template>
