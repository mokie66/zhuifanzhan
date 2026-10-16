<script setup>
/**
 * 分类浏览页
 * 支持 /tv /anime /movie /variety 以及通用的 /browse/:group
 *
 * 关于分类筛选：各源的子分类 id 互不相同（同一部片在 A 源是 type_id=6，
 * 在 B 源可能是 10），无法给出跨源统一可用的二级筛选。
 * 因此这里不做假的二级筛选，而是把「源可用性」透明地展示出来。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowUpDown, RefreshCw } from 'lucide-vue-next'
import MediaCard from '@/components/MediaCard.vue'
import StateBlock from '@/components/StateBlock.vue'
import { getCategoryList } from '@/api/index.js'
import { usePagedList } from '@/composables/useAsync.js'
import { groupLabel } from '@/api/taxonomy.js'

const route = useRoute()
const router = useRouter()

const group = computed(() => route.meta.group || route.params.group || 'tv')
const title = computed(() => groupLabel(group.value) || '分类')
const PAGE_SIZE = 24

const list = usePagedList(
  ({ page }) => getCategoryList({ group: group.value, page, pageSize: PAGE_SIZE }),
  { pageSize: PAGE_SIZE }
)

const sortHint = ref('按更新时间')

// 切换分类时重置列表
watch(group, () => {
  list.reset()
})

onMounted(() => {
  list.load(true)
})

function openDetail(vod) {
  router.push({ name: 'detail', params: { sourceKey: vod.sourceKey, id: vod.id } })
}

/** 源状态摘要：让用户知道这次聚合到几个源 */
const sourceSummary = computed(() => {
  const s = list.sourceStats.value
  if (!s) return ''
  const failed = s.failed?.length || 0
  if (!failed) return `${s.ok} 个源聚合`
  return `${s.ok} 个源可用，${failed} 个暂不可用`
})
</script>

<template>
  <div>
    <!-- 页头 -->
    <div class="flex items-center justify-between gap-3 px-4 pt-4">
      <h1 class="text-h2 text-foreground">{{ title }}</h1>
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-muted-foreground">{{ sourceSummary }}</span>
        <button
          type="button"
          class="inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-caption text-muted-foreground"
          @click="list.reset()"
        >
          <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': list.loading.value }" />
        </button>
      </div>
    </div>

    <!-- 聚合说明（多源融合后的真实条数可通过长按标题查看，这里只做轻提示） -->
    <div class="mt-3 px-4">
      <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ArrowUpDown class="h-3.5 w-3.5" />
        <span>{{ sortHint }}</span>
        <span v-if="list.sourceStats.value">
          · 原始 {{ list.sourceStats.value.rawCount }} 条聚合为 {{ list.sourceStats.value.mergedCount }} 部
        </span>
      </div>
    </div>

    <!-- 骨架屏 / 错误 / 空 -->
    <div class="mt-4 px-4">
      <StateBlock
        :loading="list.loading.value"
        :error="list.error.value"
        :empty="!list.loading.value && !list.error.value && list.items.value.length === 0"
        skeleton
        :skeleton-count="6"
        empty-text="该分类暂无内容，换个分类看看"
        @retry="list.reset()"
      />
    </div>

    <!-- 网格 -->
    <div v-if="list.items.value.length" class="mt-4 grid grid-cols-2 gap-3 px-4">
      <button
        v-for="vod in list.items.value"
        :key="`${vod.sourceKey}-${vod.id}`"
        type="button"
        class="block text-left transition-transform duration-150 active:scale-[0.98] motion-reduce:transform-none"
        @click="openDetail(vod)"
      >
        <MediaCard :vod="vod" />
      </button>
    </div>

    <!-- 加载更多 -->
    <div v-if="list.items.value.length" class="mt-4 px-4">
      <button
        v-if="list.hasMore.value"
        type="button"
        class="flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-card text-[13px] text-muted-foreground"
        :disabled="list.loadingMore.value"
        @click="list.next()"
      >
        <RefreshCw v-if="list.loadingMore.value" class="h-4 w-4 animate-spin" />
        <span>{{ list.loadingMore.value ? '加载中…' : '加载更多' }}</span>
      </button>
      <p v-else class="py-3 text-center text-[11px] text-muted-foreground">已经到底啦</p>
    </div>
  </div>
</template>
