<script setup>
/**
 * 搜索页
 * 真实多源聚合搜索：一次输入并发查询所有启用的采集源，合并去重后展示。
 *
 * 交互细节：
 *   - 输入防抖 450ms，避免每敲一个字就打一堆源站
 *   - 联想词取自真实搜索结果片名，不是假数据
 *   - 支持按语义分组过滤（电视剧/动漫/电影），过滤在聚合层完成
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowUpLeft, CircleX, Loader2, RefreshCw, Search, Star } from 'lucide-vue-next'
import StateBlock from '@/components/StateBlock.vue'
import { searchMedia, searchSuggest } from '@/api/index.js'
import { formatMeta } from '@/utils/format.js'

const route = useRoute()
const router = useRouter()

const keyword = ref(String(route.query.q || ''))
const showSuggest = ref(false)
const suggestions = ref([])
const loadingSuggest = ref(false)

const results = ref([])
const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')
const sourceStats = ref(null)
const page = ref(1)
const hasMore = ref(false)
const searched = ref(false)

const activeGroup = ref('')

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'tv', label: '电视剧' },
  { key: 'anime', label: '动漫' },
  { key: 'movie', label: '电影' },
  { key: 'variety', label: '综艺' },
]

let searchTimer = null
let suggestTimer = null
let seq = 0

/** 执行搜索 */
async function doSearch(reset = true) {
  const kw = keyword.value.trim()
  if (!kw) {
    results.value = []
    searched.value = false
    error.value = ''
    return
  }
  if (reset) {
    page.value = 1
    results.value = []
  }
  const mySeq = ++seq
  if (reset) loading.value = true
  else loadingMore.value = true
  error.value = ''

  try {
    const res = await searchMedia({
      keyword: kw,
      page: page.value,
      group: activeGroup.value || undefined,
    })
    if (mySeq !== seq) return
    results.value = reset ? res.items : [...results.value, ...res.items]
    hasMore.value = Boolean(res.hasMore) && res.items.length > 0
    sourceStats.value = res.sourceStats
    searched.value = true
    // 同步到地址栏，便于分享与刷新
    router.replace({ name: 'search', query: { q: kw } })
  } catch (err) {
    if (mySeq !== seq) return
    error.value = err?.message || String(err)
  } finally {
    if (mySeq === seq) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

/** 输入防抖：先出联想，再执行搜索 */
watch(keyword, (kw) => {
  clearTimeout(suggestTimer)
  if (!kw.trim()) {
    suggestions.value = []
    return
  }
  suggestTimer = setTimeout(async () => {
    loadingSuggest.value = true
    try {
      suggestions.value = await searchSuggest(kw.trim(), { limit: 8 })
    } catch {
      suggestions.value = []
    } finally {
      loadingSuggest.value = false
    }
  }, 300)

  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => doSearch(true), 450)
})

// 切换筛选后重新搜索
watch(activeGroup, () => {
  if (searched.value || keyword.value.trim()) doSearch(true)
})

function chooseSuggestion(item) {
  keyword.value = item.text
  showSuggest.value = false
  doSearch(true)
}

/** 回车立即搜索（模板里不要写多行内联语句，Vue 模板表达式不支持） */
function onEnter() {
  showSuggest.value = false
  doSearch(true)
}

async function loadMore() {
  if (!hasMore.value || loadingMore.value || loading.value) return
  page.value += 1
  await doSearch(false)
}

function clearKeyword() {
  keyword.value = ''
  results.value = []
  searched.value = false
}

function openDetail(vod) {
  router.push({ name: 'detail', params: { sourceKey: vod.sourceKey, id: vod.id } })
}

const resultText = computed(() => {
  if (!searched.value) return ''
  const total = results.value.length
  const raw = sourceStats.value?.rawCount || 0
  if (!total) return '没有找到相关影片'
  return `找到 ${total} 部${raw > total ? `（原始 ${raw} 条去重后）` : ''}`
})

const sourceText = computed(() => {
  const s = sourceStats.value
  if (!s) return ''
  const failed = s.failed?.length || 0
  return failed ? `${s.ok} 源可用 / ${failed} 源失败` : `${s.ok} 个源`
})

// 首次进入若带关键词，直接搜
if (keyword.value.trim()) doSearch(true)

onBeforeUnmount(() => {
  clearTimeout(searchTimer)
  clearTimeout(suggestTimer)
})
</script>

<template>
  <div>
    <!-- 搜索输入 -->
    <section class="px-4 pt-3">
      <div class="flex items-center gap-2">
        <div class="flex h-11 flex-1 items-center gap-2 rounded-full bg-muted px-4">
          <Search class="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
          <input
            v-model="keyword"
            type="search"
            placeholder="搜索影视（多源聚合）"
            class="h-full min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
            enterkeyhint="search"
            @focus="showSuggest = true"
            @keyup.enter="onEnter"
          >
          <Loader2 v-if="loading" class="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          <button v-else-if="keyword" type="button" class="shrink-0" aria-label="清空" @click="clearKeyword">
            <CircleX class="h-[18px] w-[18px] text-muted-foreground" />
          </button>
        </div>
        <button
          type="button"
          class="inline-flex h-11 items-center px-2 text-caption text-muted-foreground active:opacity-70"
          @click="router.back()"
        >取消</button>
      </div>
    </section>

    <!-- 联想浮层 -->
    <section
      v-if="showSuggest && keyword.trim()"
      class="mx-4 mt-2 overflow-hidden rounded-lg border border-border bg-card"
    >
      <div v-if="loadingSuggest" class="flex items-center gap-2 px-3 py-3 text-caption text-muted-foreground">
        <Loader2 class="h-3.5 w-3.5 animate-spin" />
        <span>正在联想…</span>
      </div>
      <button
        v-for="s in suggestions"
        :key="s.text"
        type="button"
        class="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left last:border-b-0"
        @click="chooseSuggestion(s)"
      >
        <ArrowUpLeft class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate text-[14px] text-foreground">{{ s.text }}</span>
        <span class="shrink-0 text-[11px] text-muted-foreground">{{ s.group }}</span>
      </button>
      <p
        v-if="!loadingSuggest && !suggestions.length"
        class="px-3 py-3 text-caption text-muted-foreground"
      >暂无联想词</p>
    </section>

    <!-- 结果统计与筛选 -->
    <section v-if="searched" class="flex items-center justify-between gap-2 px-4 pt-3">
      <span class="min-w-0 flex-1 truncate text-caption tabular-nums text-muted-foreground">
        {{ resultText }}
        <span v-if="sourceText" class="text-[11px]"> · {{ sourceText }}</span>
      </span>
      <div class="flex shrink-0 gap-1.5">
        <button
          v-for="f in FILTERS"
          :key="f.key"
          type="button"
          class="h-8 shrink-0 rounded-full px-3 text-[12px] transition-colors"
          :class="
            activeGroup === f.key
              ? 'bg-primary text-primary-foreground'
              : 'border border-border bg-card text-muted-foreground'
          "
          @click="activeGroup = f.key"
        >{{ f.label }}</button>
      </div>
    </section>

    <!-- 状态块 -->
    <div class="px-4 pt-3">
      <StateBlock
        :loading="loading"
        :error="error"
        :empty="searched && !loading && !error && results.length === 0"
        skeleton
        :skeleton-count="4"
        loading-text="正在并发查询所有资源源…"
        empty-text="换个关键词试试"
        @retry="doSearch(true)"
      />
    </div>

    <!-- 结果列表 -->
    <div v-if="results.length" class="space-y-3 px-4 pt-1">
      <button
        v-for="vod in results"
        :key="`${vod.sourceKey}-${vod.id}`"
        type="button"
        class="flex w-full gap-3 rounded-lg border border-border bg-card p-2.5 text-left transition-transform active:scale-[0.99]"
        @click="openDetail(vod)"
      >
        <div class="h-[76px] w-[54px] shrink-0 overflow-hidden rounded bg-muted">
          <img
            v-if="vod.poster"
            :src="vod.poster"
            :alt="`《${vod.title}》海报`"
            class="h-full w-full object-cover"
            loading="lazy"
            referrerpolicy="no-referrer"
          >
        </div>
        <div class="min-w-0 flex-1">
          <h3 class="truncate text-[14px] font-medium text-foreground">{{ vod.title }}</h3>
          <p class="mt-0.5 truncate text-[11px] text-muted-foreground">{{ formatMeta(vod) }}</p>
          <p v-if="vod.intro" class="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
            {{ vod.intro }}
          </p>
          <div class="mt-1 flex items-center gap-2">
            <span
              v-if="vod.score > 0"
              class="flex items-center gap-0.5 text-[11px] tabular-nums text-primary"
            >
              <Star class="h-3 w-3" />{{ vod.score.toFixed(1) }}
            </span>
            <span v-if="vod.remarks" class="text-[11px] text-muted-foreground">{{ vod.remarks }}</span>
            <span class="text-[11px] text-muted-foreground">{{ vod.sourceName }}</span>
            <span
              v-if="vod.mirrors?.length"
              class="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
            >{{ vod.mirrors.length + 1 }} 源</span>
          </div>
        </div>
      </button>

      <button
        v-if="hasMore"
        type="button"
        class="flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-card text-[13px] text-muted-foreground"
        :disabled="loadingMore"
        @click="loadMore"
      >
        <RefreshCw v-if="loadingMore" class="h-4 w-4 animate-spin" />
        <span>{{ loadingMore ? '加载中…' : '加载更多' }}</span>
      </button>
    </div>

    <!-- 引导 -->
    <section v-if="!searched && !loading" class="px-4 pt-6 text-center">
      <p class="text-caption text-muted-foreground">输入片名开始搜索</p>
      <p class="mt-2 text-[11px] text-muted-foreground">同时查询多个采集源并自动去重合并</p>
    </section>
  </div>
</template>
