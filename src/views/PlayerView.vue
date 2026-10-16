<script setup>
/**
 * 播放页（全流程打通的终点）
 * ============================
 * 数据流：
 *   /player/:sourceKey/:id/:episodeIndex?line=<lineKey>
 *     → getDetail() 拿该片全部线路（含跨源换源结果）
 *     → 选定线路 + 集 → 取出该集直链
 *     → 交给 VideoPlayer（hls.js 播 m3u8）
 *     → 播放中节流写进度到 localStorage，下次进入自动续播
 *
 * 实测：采集源的直链 m3u8 其 CDN 带 ACAO:*，可跨域直连播放，
 * 无需流代理；仅 http 资源在 https 页面下会被混合内容策略拦掉，
 * 这种情况由 utils/media.js 的 resolvePlayUrl 自动兜底。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ChevronLeft,
  ChevronRight,
  Heart,
  List,
  Repeat,
  Tv,
  X,
} from 'lucide-vue-next'
import VideoPlayer from '@/components/VideoPlayer.vue'
import StateBlock from '@/components/StateBlock.vue'
import MediaCard from '@/components/MediaCard.vue'
import { getDetail, getRecommendations } from '@/api/index.js'
import { useAsync } from '@/composables/useAsync.js'
import { formatStatus } from '@/utils/format.js'
import {
  getProgress,
  saveProgress,
  pushHistory,
  isFavorite,
  toggleFavorite,
} from '@/utils/storage.js'

const route = useRoute()
const router = useRouter()

const sourceKey = computed(() => route.params.sourceKey)
const vodId = computed(() => route.params.id)
const episodeIndex = computed(() => {
  const n = Number(route.params.episodeIndex)
  return Number.isFinite(n) && n >= 0 ? n : 0
})
const queryLineKey = computed(() => route.query.line || '')

const detail = useAsync(
  () => getDetail({ sourceKey: sourceKey.value, id: vodId.value, withMirrors: true }),
  { watchSource: [sourceKey, vodId] }
)

const vod = computed(() => detail.data.value)
const lines = computed(() => vod.value?.allLines || [])

/** 当前线路：优先用 query 指定，否则第一条可播线路 */
const activeLine = computed(() => {
  const byQuery = lines.value.find((l) => l.key === queryLineKey.value)
  if (byQuery) return byQuery
  return lines.value.find((l) => l.playable) || lines.value[0] || null
})

const episodes = computed(() => activeLine.value?.episodes || [])
const currentEpisode = computed(() => episodes.value[episodeIndex.value] || null)
/** 交给播放器的真实地址 */
const playSrc = computed(() => currentEpisode.value?.url || '')

const startTime = ref(0)
const showEpisodeDrawer = ref(false)
const showLineDrawer = ref(false)
const faved = ref(false)
const recs = ref([])
const lastSaved = ref(0)

/* ------------------------------------------------------------------ *
 * 进度：进入时续播，播放中写回
 * ------------------------------------------------------------------ */

async function restoreProgress() {
  if (!vod.value || !activeLine.value || !currentEpisode.value) {
    startTime.value = 0
    return
  }
  const p = await getProgress(vod.value, activeLine.value.key, episodeIndex.value)
  // 已看完（>95%）就不续播，从头开始更符合预期
  if (p && p.duration && p.currentTime < p.duration * 0.95) {
    startTime.value = p.currentTime
  } else {
    startTime.value = 0
  }
}

/** 播放器节流上报（约每 5 秒一次） */
async function onProgress(payload) {
  if (!vod.value || !activeLine.value) return
  lastSaved.value = payload.currentTime
  await saveProgress(vod.value, activeLine.value.key, episodeIndex.value, {
    currentTime: payload.currentTime,
    duration: payload.duration,
  })
  // 历史记录同时刷新，保证「继续观看」的进度是新的
  await pushHistory(vod.value, {
    episodeIndex: episodeIndex.value,
    episodeName: currentEpisode.value?.name || '',
    lineKey: activeLine.value.key,
    percent: payload.percent,
    currentTime: payload.currentTime,
    duration: payload.duration,
  })
}

/** 暂停 / 卸载前保存 */
async function onSave(payload) {
  if (!vod.value || !activeLine.value || !payload.duration) return
  await saveProgress(vod.value, activeLine.value.key, episodeIndex.value, {
    currentTime: payload.currentTime,
    duration: payload.duration,
  })
}

/** 播完自动下一集 */
function onEnded() {
  if (hasNext.value) goEpisode(episodeIndex.value + 1)
}

/* ------------------------------------------------------------------ *
 * 集数 / 线路切换
 * ------------------------------------------------------------------ */

const hasPrev = computed(() => episodeIndex.value > 0)
const hasNext = computed(() => episodeIndex.value < episodes.value.length - 1)

function goEpisode(index) {
  if (index < 0 || index >= episodes.value.length) return
  showEpisodeDrawer.value = false
  router.replace({
    name: 'player',
    params: { sourceKey: sourceKey.value, id: vodId.value, episodeIndex: index },
    query: { line: activeLine.value?.key || '' },
  })
}

function switchLine(line) {
  showLineDrawer.value = false
  // 换线路时保持当前集索引，但索引可能超出新线路集数，需要收敛
  const target = activeLine.value
  let idx = episodeIndex.value
  if (target && target.key !== line.key) idx = 0
  router.replace({
    name: 'player',
    params: { sourceKey: sourceKey.value, id: vodId.value, episodeIndex: idx },
    query: { line: line.key },
  })
}

async function onToggleFav() {
  if (!vod.value) return
  faved.value = await toggleFavorite(vod.value)
}

function openVod(v) {
  router.push({ name: 'detail', params: { sourceKey: v.sourceKey, id: v.id } })
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

// 影片/线路/集变化时重新定位进度
watch([() => vod.value?.id, () => activeLine.value?.key, episodeIndex], restoreProgress, {
  immediate: true,
})

watch(vod, async (v) => {
  if (!v) return
  faved.value = await isFavorite(v)
  // 进入播放即记一条历史（即使用户没点播放）
  if (activeLine.value && currentEpisode.value) {
    await pushHistory(v, {
      episodeIndex: episodeIndex.value,
      episodeName: currentEpisode.value.name,
      lineKey: activeLine.value.key,
      percent: 0,
    })
  }
  getRecommendations(v, { limit: 6 })
    .then((r) => (recs.value = r))
    .catch(() => (recs.value = []))
})

onMounted(() => {
  // 标题带上片名，便于多标签页区分
  if (vod.value) document.title = `${vod.value.title} · 播放 · 追番站`
})
</script>

<template>
  <div>
    <!-- 顶部栏 -->
    <div class="flex h-11 items-center gap-3 px-4">
      <button
        type="button"
        class="inline-flex h-9 items-center gap-1 rounded-md px-2 text-muted-foreground"
        @click="router.back()"
      >
        <ChevronLeft class="h-5 w-5" />
        <span class="text-[14px]">返回</span>
      </button>
      <h1 class="min-w-0 flex-1 truncate text-[15px] font-medium text-foreground">
        {{ vod ? `${vod.title}${currentEpisode ? ' · ' + currentEpisode.name : ''}` : '播放' }}
      </h1>
      <button
        v-if="lines.length > 1"
        type="button"
        class="inline-flex h-9 items-center gap-1 rounded-md border border-border px-2.5 text-caption text-primary"
        @click="showLineDrawer = true"
      >
        <Repeat class="h-4 w-4" />
        <span class="hidden sm:inline">换线</span>
      </button>
      <button
        type="button"
        class="inline-flex h-9 items-center gap-1 rounded-md border border-border px-2.5 text-caption text-primary"
        @click="showEpisodeDrawer = true"
      >
        <List class="h-4 w-4" />
        <span>选集</span>
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
      <!-- 播放器 -->
      <VideoPlayer
        v-if="playSrc"
        :src="playSrc"
        :poster="vod.poster"
        :title="currentEpisode?.name"
        :start-time="startTime"
        :has-prev="hasPrev"
        :has-next="hasNext"
        @progress="onProgress"
        @save="onSave"
        @ended="onEnded"
        @prev="goEpisode(episodeIndex - 1)"
        @next="goEpisode(episodeIndex + 1)"
      />

      <!-- 无直链线路的兜底提示 -->
      <section v-else class="mx-4 mt-3 rounded-lg border border-border bg-card p-4">
        <p class="text-caption text-foreground">该线路没有可直接播放的地址</p>
        <p class="mt-1 text-[11px] text-muted-foreground">
          采集源提供的这类线路需要网页解析才能取到视频流。
          <template v-if="lines.length > 1">请点右上角「换线」选择直链线路。</template>
        </p>
        <button
          v-if="lines.length > 1"
          type="button"
          class="mt-3 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-caption font-medium text-primary-foreground"
          @click="showLineDrawer = true"
        >
          <Repeat class="h-4 w-4" />
          <span>选择线路</span>
        </button>
      </section>

      <!-- 集数切换 -->
      <div class="flex gap-2 px-4 pt-3">
        <button
          type="button"
          class="inline-flex h-11 flex-1 items-center justify-center gap-1 rounded-md border border-border bg-card text-caption text-foreground disabled:opacity-40"
          :disabled="!hasPrev"
          @click="goEpisode(episodeIndex - 1)"
        >
          <ChevronLeft class="h-4 w-4" />
          <span>上一集</span>
        </button>
        <button
          type="button"
          class="inline-flex h-11 flex-1 items-center justify-center gap-1 rounded-md border border-border bg-card text-caption text-foreground disabled:opacity-40"
          :disabled="!hasNext"
          @click="goEpisode(episodeIndex + 1)"
        >
          <span>下一集</span>
          <ChevronRight class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="inline-flex h-11 w-11 items-center justify-center rounded-full border bg-card"
          :class="faved ? 'border-primary text-primary' : 'border-border text-muted-foreground'"
          aria-label="收藏"
          @click="onToggleFav"
        >
          <Heart class="h-5 w-5" :class="{ 'fill-current': faved }" />
        </button>
      </div>

      <!-- 剧集信息 -->
      <section class="px-4 pt-4">
        <h2 class="text-h2 text-foreground">{{ vod.title }}</h2>
        <p class="mt-1 text-caption tabular-nums text-muted-foreground">
          {{ currentEpisode ? `${currentEpisode.name} · ` : '' }}
          共 {{ episodes.length || vod.episodeCount }} 集
          <template v-if="vod.categoryName"> · {{ vod.categoryName }}</template>
        </p>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <span
            v-if="vod.remarks"
            class="inline-flex h-6 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground"
          >{{ vod.remarks }}</span>
          <span
            v-if="activeLine"
            class="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2 text-[11px] text-muted-foreground"
          >
            <Tv class="h-3 w-3" />{{ activeLine.name }}
          </span>
          <span
            v-if="activeLine?.sourceName"
            class="inline-flex h-6 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground"
          >{{ activeLine.sourceName }}</span>
        </div>
        <p v-if="vod.intro" class="mt-2 line-clamp-3 text-caption text-muted-foreground">
          {{ vod.intro }}
        </p>
      </section>

      <!-- 选集横滑带 -->
      <section v-if="episodes.length" class="px-4 pt-4">
        <div class="flex items-center justify-between">
          <h2 class="text-[15px] font-medium text-foreground">选集</h2>
          <span class="text-caption tabular-nums text-muted-foreground">
            共 {{ episodes.length }} 集
          </span>
        </div>
        <div class="no-scrollbar mt-3 flex gap-2 overflow-x-auto">
          <button
            v-for="(ep, idx) in episodes.slice(0, 30)"
            :key="idx"
            type="button"
            class="inline-flex h-11 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border px-1 text-[12px] tabular-nums"
            :class="
              idx === episodeIndex
                ? 'border-transparent bg-primary font-medium text-primary-foreground'
                : 'border-border bg-card text-muted-foreground'
            "
            @click="goEpisode(idx)"
          >
            <span class="truncate">{{ ep.name }}</span>
          </button>
        </div>
      </section>

      <!-- 相关推荐 -->
      <section v-if="recs.length" class="px-4 pt-5">
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

    <!-- 选集抽屉 -->
    <div v-if="showEpisodeDrawer" class="fixed inset-0 z-50 bg-black/45" @click="showEpisodeDrawer = false"></div>
    <section
      v-if="showEpisodeDrawer"
      class="fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto rounded-t-lg border-t border-border bg-popover pb-6"
      role="dialog"
      aria-label="选集"
    >
      <div class="flex h-12 items-center justify-between border-b border-border px-4">
        <span class="text-[15px] font-medium">
          选集
          <span class="ml-1 text-[11px] tabular-nums text-muted-foreground">
            共 {{ episodes.length }} 集
          </span>
        </span>
        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground"
          aria-label="关闭"
          @click="showEpisodeDrawer = false"
        >
          <X class="h-5 w-5" />
        </button>
      </div>
      <div class="grid grid-cols-5 gap-2 px-4 pt-3">
        <button
          v-for="(ep, idx) in episodes"
          :key="idx"
          type="button"
          class="inline-flex h-11 items-center justify-center overflow-hidden rounded-md border px-1 text-[12px] tabular-nums"
          :class="
            idx === episodeIndex
              ? 'border-transparent bg-primary font-medium text-primary-foreground'
              : 'border-border bg-card text-muted-foreground'
          "
          @click="goEpisode(idx)"
        >
          <span class="truncate">{{ ep.name }}</span>
        </button>
      </div>
    </section>

    <!-- 换线抽屉 -->
    <div v-if="showLineDrawer" class="fixed inset-0 z-50 bg-black/45" @click="showLineDrawer = false"></div>
    <section
      v-if="showLineDrawer"
      class="fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto rounded-t-lg border-t border-border bg-popover pb-6"
      role="dialog"
      aria-label="选择线路"
    >
      <div class="flex h-12 items-center justify-between border-b border-border px-4">
        <span class="text-[15px] font-medium">选择播放线路</span>
        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground"
          aria-label="关闭"
          @click="showLineDrawer = false"
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
          :class="line.key === activeLine?.key ? 'border-primary bg-muted' : 'border-border bg-card'"
          @click="switchLine(line)"
        >
          <Tv
            class="h-4 w-4 shrink-0"
            :class="line.key === activeLine?.key ? 'text-primary' : 'text-muted-foreground'"
          />
          <div class="min-w-0 flex-1">
            <div
              class="truncate text-[14px] font-medium"
              :class="line.key === activeLine?.key ? 'text-primary' : 'text-foreground'"
            >{{ line.name }}</div>
            <div class="text-[11px] text-muted-foreground">
              {{ line.sourceName || '未知源' }} · {{ line.episodes.length }} 集 ·
              {{ line.playable ? '直链可播' : '需网页解析' }}
            </div>
          </div>
        </button>
      </div>
    </section>
  </div>
</template>
