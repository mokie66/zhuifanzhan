<script setup>
/**
 * 影片详情页
 * 真实数据来源：/detail/:sourceKey/:id → getDetail()（含跨源换源信息）
 *
 * 关于「换源」：getDetail 会用片名到其他源找同名片，把它们的线路一起挂到
 * vod.allLines 上。所以这里的线路列表天然包含多个源，用户可自由切换。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ChevronLeft,
  CircleCheck,
  Heart,
  Play,
  Repeat,
  Star,
  Tv,
  X,
} from 'lucide-vue-next'
import StateBlock from '@/components/StateBlock.vue'
import MediaCard from '@/components/MediaCard.vue'
import { getDetail, getRecommendations, guessGroup } from '@/api/index.js'
import { useAsync } from '@/composables/useAsync.js'
import { formatStatus, formatMeta, formatScore } from '@/utils/format.js'
import { isFavorite, toggleFavorite } from '@/utils/storage.js'

const route = useRoute()
const router = useRouter()

const sourceKey = computed(() => route.params.sourceKey)
const vodId = computed(() => route.params.id)

const detail = useAsync(
  () => getDetail({ sourceKey: sourceKey.value, id: vodId.value, withMirrors: true }),
  { watchSource: [sourceKey, vodId] }
)

const recs = ref([])
const faved = ref(false)
const showSourceSheet = ref(false)
/** 当前选中的线路 key，默认取第一条可播线路 */
const activeLineKey = ref('')

watch(detail.data, async (vod) => {
  if (!vod) return
  // 默认选中第一条可播线路，没有可播的就退回第一条
  const playable = (vod.allLines || []).find((l) => l.playable)
  activeLineKey.value = playable?.key || vod.allLines?.[0]?.key || ''
  faved.value = await isFavorite(vod)
  getRecommendations(vod, { limit: 6 })
    .then((r) => (recs.value = r))
    .catch(() => (recs.value = []))
})

const vod = computed(() => detail.data.value)
const lines = computed(() => vod.value?.allLines || [])
/** 可播线路数（用于展示「N 条线路可播」） */
const playableLineCount = computed(() => lines.value.filter((l) => l.playable).length)
const activeLine = computed(
  () => lines.value.find((l) => l.key === activeLineKey.value) || lines.value[0] || null
)
const episodes = computed(() => activeLine.value?.episodes || [])
const episodeCount = computed(() => vod.value?.episodeCount || episodes.value.length)

/** 播放第一集（或指定线路的第一集） */
function playFirst(lineKey) {
  const key = lineKey || activeLine.value?.key
  if (!key) return
  router.push({
    name: 'player',
    params: { sourceKey: sourceKey.value, id: vodId.value, episodeIndex: 0 },
    query: { line: key },
  })
}

function playEpisode(index) {
  router.push({
    name: 'player',
    params: { sourceKey: sourceKey.value, id: vodId.value, episodeIndex: index },
    query: { line: activeLine.value?.key || '' },
  })
}

async function onToggleFav() {
  if (!vod.value) return
  faved.value = await toggleFavorite(vod.value)
}

function openVod(v) {
  router.push({ name: 'detail', params: { sourceKey: v.sourceKey, id: v.id } })
}
</script>

<template>
  <div>
    <!-- 返回栏 -->
    <div class="flex h-11 items-center gap-3 border-b border-border px-4">
      <button
        type="button"
        class="inline-flex h-9 items-center gap-1 rounded-md px-2 text-muted-foreground"
        @click="router.back()"
      >
        <ChevronLeft class="h-5 w-5" />
        <span class="text-[14px]">返回</span>
      </button>
      <span class="text-[15px] font-medium text-foreground">影片详情</span>
      <div class="flex-1"></div>
      <button
        v-if="lines.length > 1"
        type="button"
        class="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-caption text-primary"
        @click="showSourceSheet = true"
      >
        <Repeat class="h-4 w-4" />
        <span>换源</span>
      </button>
    </div>

    <StateBlock
      :loading="detail.loading.value"
      :error="detail.error.value"
      :empty="!detail.loading.value && !detail.error.value && !vod"
      empty-text="未找到该影片"
      @retry="detail.refresh()"
    />

    <template v-if="vod">
      <!-- 海报 + 信息头 -->
      <div class="flex gap-3 px-4 pt-3">
        <div class="w-[116px] shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
          <div class="poster-ratio">
            <img
              v-if="vod.poster"
              :src="vod.poster"
              :alt="`《${vod.title}》海报`"
              class="h-full w-full object-cover"
              referrerpolicy="no-referrer"
            >
            <div v-else class="flex h-full w-full items-center justify-center">
              <Tv class="h-7 w-7 text-muted-foreground/50" />
            </div>
          </div>
        </div>

        <div class="min-w-0 flex-1">
          <h1 class="text-h2 text-foreground">{{ vod.title }}</h1>
          <p v-if="vod.sub" class="mt-0.5 truncate text-[11px] text-muted-foreground">
            {{ vod.sub }}
          </p>
          <p class="mt-1 text-caption text-muted-foreground">{{ formatMeta(vod) }}</p>

          <p
            v-if="vod.score > 0"
            class="mt-1.5 flex items-center gap-1 font-medium tabular-nums text-primary"
          >
            <Star class="h-4 w-4" />
            <span class="text-[14px]">{{ formatScore(vod.score) }}</span>
          </p>

          <div class="mt-2 flex flex-wrap gap-1">
            <span
              v-if="episodeCount"
              class="inline-flex h-6 items-center rounded-full bg-muted px-2 text-[11px] tabular-nums text-muted-foreground"
            >共 {{ episodeCount }} 集</span>
            <span
              v-if="vod.remarks"
              class="inline-flex h-6 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground"
            >{{ vod.remarks }}</span>
            <span
              v-if="playableLineCount"
              class="inline-flex h-6 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground"
            >{{ playableLineCount }} 条线路可播</span>
          </div>

          <p v-if="vod.intro" class="mt-2 line-clamp-3 text-caption text-muted-foreground">
            {{ vod.intro }}
          </p>
        </div>
      </div>

      <!-- 演职员 -->
      <div v-if="vod.actors || vod.director" class="mt-3 space-y-1 px-4 text-[11px] text-muted-foreground">
        <p v-if="vod.director"><span class="text-foreground/70">导演：</span>{{ vod.director }}</p>
        <p v-if="vod.actors"><span class="text-foreground/70">主演：</span>{{ vod.actors }}</p>
      </div>

      <!-- 主 CTA -->
      <div class="mt-4 px-4">
        <button
          type="button"
          class="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-50"
          :disabled="!playableLineCount && !episodes.length"
          @click="playFirst()"
        >
          <Play class="h-5 w-5" />
          <span class="text-[15px]">
            {{ playableLineCount ? '立即播放' : episodes.length ? '播放（需解析）' : '暂无可播线路' }}
          </span>
        </button>
        <div class="mt-3 flex gap-3">
          <button
            type="button"
            class="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md border bg-card text-caption"
            :class="faved ? 'border-primary text-primary' : 'border-border text-foreground'"
            @click="onToggleFav"
          >
            <Heart class="h-4 w-4" :class="{ 'fill-current': faved }" />
            <span>{{ faved ? '已收藏' : '加入收藏' }}</span>
          </button>
          <button
            type="button"
            class="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-card text-caption text-muted-foreground"
            @click="showSourceSheet = true"
          >
            <Repeat class="h-4 w-4" />
            <span>{{ lines.length }} 条线路</span>
          </button>
        </div>
      </div>

      <!-- 选集网格（来自当前线路） -->
      <section v-if="episodes.length" class="mt-5 px-4">
        <div class="flex items-center justify-between">
          <h2 class="text-[15px] font-medium text-foreground">选集</h2>
          <span class="text-caption tabular-nums text-muted-foreground">
            共 {{ episodes.length }} 集
          </span>
        </div>
        <p v-if="activeLine" class="mt-1 text-[11px] text-muted-foreground">
          当前线路：{{ activeLine.name }}
          <span v-if="activeLine.sourceName">（{{ activeLine.sourceName }}）</span>
        </p>
        <div class="mt-3 grid grid-cols-5 gap-2">
          <button
            v-for="(ep, idx) in episodes.slice(0, 60)"
            :key="idx"
            type="button"
            class="inline-flex h-10 items-center justify-center overflow-hidden rounded-md border border-border bg-card px-1 text-[13px] tabular-nums text-muted-foreground"
            @click="playEpisode(idx)"
          >
            <span class="truncate">{{ ep.name }}</span>
          </button>
        </div>
        <p v-if="episodes.length > 60" class="mt-2 text-[11px] text-muted-foreground">
          仅展示前 60 集，其余请在播放页选集
        </p>
      </section>

      <section v-else class="mt-5 px-4">
        <div class="rounded-md border border-border bg-card p-3 text-caption text-muted-foreground">
          该源未提供可用播放线路
        </div>
      </section>

      <!-- 相关推荐 -->
      <section v-if="recs.length" class="mt-6 px-4">
        <h2 class="text-[15px] font-medium text-foreground">相关推荐</h2>
        <div class="mt-3 grid grid-cols-2 gap-3">
          <button
            v-for="r in recs"
            :key="`${r.sourceKey}-${r.id}`"
            type="button"
            class="block text-left transition-transform active:scale-[0.98]"
            @click="openVod(r)"
          >
            <MediaCard :vod="r" :show-score="false" />
          </button>
        </div>
      </section>
    </template>

    <!-- 换源弹层 -->
    <div v-if="showSourceSheet" class="fixed inset-0 z-50 bg-black/45" @click="showSourceSheet = false"></div>
    <section
      v-if="showSourceSheet"
      class="fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto rounded-t-lg border-t border-border bg-popover pb-6"
      role="dialog"
      aria-label="选择播放线路"
    >
      <div class="flex h-12 items-center justify-between border-b border-border px-4">
        <span class="text-[15px] font-medium">选择播放线路</span>
        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground"
          aria-label="关闭"
          @click="showSourceSheet = false"
        >
          <X class="h-5 w-5" />
        </button>
      </div>
      <div class="space-y-2 px-4 pt-3">
        <button
          v-for="line in lines"
          :key="line.key + line.sourceKey"
          type="button"
          class="flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left"
          :class="line.key === activeLineKey ? 'border-primary bg-muted' : 'border-border bg-card'"
          @click="activeLineKey = line.key; showSourceSheet = false"
        >
          <Tv
            class="h-4 w-4 shrink-0"
            :class="line.key === activeLineKey ? 'text-primary' : 'text-muted-foreground'"
          />
          <div class="min-w-0 flex-1">
            <div
              class="truncate text-[14px] font-medium"
              :class="line.key === activeLineKey ? 'text-primary' : 'text-foreground'"
            >
              {{ line.name }}
            </div>
            <div class="text-[11px] text-muted-foreground">
              {{ line.sourceName || '未知源' }} · {{ line.episodes.length }} 集 ·
              {{ line.playable ? '直链可播' : '需网页解析' }}
            </div>
          </div>
          <CircleCheck v-if="line.key === activeLineKey" class="h-5 w-5 shrink-0 text-primary" />
        </button>
      </div>
    </section>
  </div>
</template>
