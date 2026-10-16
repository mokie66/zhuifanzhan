<script setup>
/**
 * 首页
 * 数据来自 getHomeFeed()：并发聚合多个采集源的电视剧/动漫/电影最新内容 + 导航分类
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Play, RefreshCw, Star } from 'lucide-vue-next'
import StateBlock from '@/components/StateBlock.vue'
import MediaCard from '@/components/MediaCard.vue'
import { getHomeFeed, guessGroup, checkSourcesHealth } from '@/api/index.js'
import { useAsync } from '@/composables/useAsync.js'
import { formatStatus, formatMeta, formatRelativeTime } from '@/utils/format.js'
import { getHistory } from '@/utils/storage.js'

const router = useRouter()

const feed = useAsync(() => getHomeFeed(), { initial: null })
const history = ref([])
const sourcesHealth = ref([])
const showSourcePanel = ref(false)

onMounted(async () => {
  history.value = (await getHistory()).slice(0, 6)
  // 源健康检查较慢，放到后台不阻塞首屏
  checkSourcesHealth()
    .then((r) => (sourcesHealth.value = r))
    .catch(() => (sourcesHealth.value = []))
})

const hero = computed(() => feed.data.value?.hero || null)
const latestTv = computed(() => feed.data.value?.latestTv || [])
const latestAnime = computed(() => feed.data.value?.latestAnime || [])
const latestMovie = computed(() => feed.data.value?.latestMovie || [])
const categories = computed(() => feed.data.value?.categories || [])

const okSourceCount = computed(() => sourcesHealth.value.filter((s) => s.ok).length)
const allSourceCount = computed(() => sourcesHealth.value.length)

function openDetail(vod) {
  router.push({ name: 'detail', params: { sourceKey: vod.sourceKey, id: vod.id } })
}

/** 继续观看：直接跳到播放页的对应集 */
function continueWatching(item) {
  router.push({
    name: 'player',
    params: {
      sourceKey: item.sourceKey,
      id: item.id,
      episodeIndex: item.episodeIndex || 0,
    },
    query: { line: item.lineKey || '' },
  })
}

/** 主视觉的播放按钮：进详情页更稳妥（首集可能不在当前线路） */
function playHero() {
  if (!hero.value) return
  openDetail(hero.value)
}

function goGroup(group) {
  router.push({ name: 'browse', params: { group } })
}

/** 分类入口：常见分类直连路由，其余走通用 browse */
const CATEGORY_ICONS = {
  movie: '🎬',
  tv: '📺',
  anime: '✨',
  variety: '🎤',
  short: '⚡',
  doc: '📖',
  sports: '⚽',
}
</script>

<template>
  <div class="space-y-6 px-4 pt-4">
    <!-- 首屏加载 -->
    <StateBlock
      v-if="feed.loading.value && !feed.data.value"
      :loading="true"
      loading-text="正在聚合多个资源源…"
    />
    <StateBlock
      v-else-if="feed.error.value && !feed.data.value"
      :error="feed.error.value"
      @retry="feed.refresh()"
    />

    <template v-else>
      <!-- 主视觉 -->
      <section v-if="hero">
        <div class="relative overflow-hidden rounded-lg">
          <img
            v-if="hero.poster"
            :src="hero.poster"
            :alt="`《${hero.title}》主视觉`"
            class="h-[190px] w-full object-cover"
            referrerpolicy="no-referrer"
          >
          <div v-else class="h-[190px] w-full bg-gradient-to-br from-muted to-card"></div>
          <div class="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent"></div>
          <div class="absolute inset-0 flex flex-col justify-between p-4">
            <div class="flex items-center gap-2">
              <span
                v-if="hero.score > 0"
                class="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2.5 text-[11px] font-semibold text-primary"
              >
                <Star class="h-3 w-3 fill-current" />{{ hero.score.toFixed(1) }}
              </span>
              <span
                v-if="hero.remarks"
                class="inline-flex h-6 items-center rounded-full bg-black/45 px-2.5 text-[11px] text-white/90"
              >{{ hero.remarks }}</span>
            </div>
            <div class="flex items-end justify-between gap-3">
              <div class="min-w-0">
                <h2 class="truncate text-h2 text-white">{{ hero.title }}</h2>
                <p class="mt-0.5 truncate text-[11px] text-white/75">{{ formatMeta(hero) }}</p>
              </div>
              <button
                type="button"
                class="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md bg-primary px-5 text-primary-foreground transition-transform duration-150 active:scale-[0.97] motion-reduce:transform-none"
                @click="playHero"
              >
                <Play class="h-4 w-4" />
                <span class="text-[15px] font-medium">查看详情</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 继续观看（本地历史） -->
      <section v-if="history.length">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-h2 text-foreground">继续观看</h2>
          <router-link to="/library" class="text-caption text-primary">全部</router-link>
        </div>
        <div class="no-scrollbar flex gap-3 overflow-x-auto pb-1">
          <article
            v-for="item in history"
            :key="`${item.sourceKey}-${item.id}`"
            class="w-[200px] shrink-0 overflow-hidden rounded-lg border border-border bg-card"
          >
            <button type="button" class="block w-full text-left" @click="continueWatching(item)">
              <div class="h-[112px] w-full bg-muted">
                <img
                  v-if="item.poster"
                  :src="item.poster"
                  :alt="`《${item.title}》封面`"
                  class="h-full w-full object-cover"
                  referrerpolicy="no-referrer"
                >
              </div>
              <div class="space-y-2 p-3">
                <h3 class="truncate text-[15px] font-medium text-card-foreground">
                  {{ item.title }}
                </h3>
                <p class="truncate text-caption tabular-nums text-muted-foreground">
                  {{ item.episodeName || `第 ${(item.episodeIndex || 0) + 1} 集` }}
                  <template v-if="item.watchedAt">
                    · {{ formatRelativeTime(item.watchedAt) }}
                  </template>
                </p>
                <div class="h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    class="h-full rounded-full bg-primary"
                    :style="{ width: `${Math.min(100, item.percent || 0)}%` }"
                  ></div>
                </div>
                <span
                  class="inline-flex h-9 items-center rounded-md border border-border px-3 text-caption text-primary"
                >继续播放</span>
              </div>
            </button>
          </article>
        </div>
      </section>

      <!-- 最近更新 · 电视剧 -->
      <section v-if="latestTv.length">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-h2 text-foreground">最近更新 · 电视剧</h2>
          <router-link to="/tv" class="flex items-center text-caption text-primary">
            查看全部<ChevronRight class="h-3.5 w-3.5" />
          </router-link>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <button
            v-for="item in latestTv"
            :key="`${item.sourceKey}-${item.id}`"
            type="button"
            class="block text-left transition-transform active:scale-[0.98]"
            @click="openDetail(item)"
          >
            <MediaCard :vod="item" />
          </button>
        </div>
      </section>

      <!-- 最近更新 · 动漫 -->
      <section v-if="latestAnime.length">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-h2 text-foreground">最近更新 · 动漫</h2>
          <router-link to="/anime" class="flex items-center text-caption text-primary">
            查看全部<ChevronRight class="h-3.5 w-3.5" />
          </router-link>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <button
            v-for="item in latestAnime"
            :key="`${item.sourceKey}-${item.id}`"
            type="button"
            class="block text-left transition-transform active:scale-[0.98]"
            @click="openDetail(item)"
          >
            <MediaCard :vod="item" />
          </button>
        </div>
      </section>

      <!-- 最近更新 · 电影 -->
      <section v-if="latestMovie.length">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-h2 text-foreground">最近更新 · 电影</h2>
          <router-link to="/movie" class="flex items-center text-caption text-primary">
            查看全部<ChevronRight class="h-3.5 w-3.5" />
          </router-link>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <button
            v-for="item in latestMovie.slice(0, 6)"
            :key="`${item.sourceKey}-${item.id}`"
            type="button"
            class="block text-left transition-transform active:scale-[0.98]"
            @click="openDetail(item)"
          >
            <MediaCard :vod="item" />
          </button>
        </div>
      </section>

      <!-- 分类快捷入口（来自各源分类表归并结果） -->
      <section v-if="categories.length">
        <h2 class="mb-3 text-h2 text-foreground">分类</h2>
        <div class="grid grid-cols-4 gap-3">
          <button
            v-for="cat in categories"
            :key="cat.key"
            type="button"
            class="mx-auto flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-full border border-border bg-card text-muted-foreground transition-transform duration-150 active:scale-[0.97] motion-reduce:transform-none"
            @click="goGroup(cat.key)"
          >
            <span class="text-[18px] leading-none">{{ CATEGORY_ICONS[cat.key] || '🎞' }}</span>
            <span class="text-[11px] leading-none">{{ cat.label }}</span>
          </button>
        </div>
      </section>

      <!-- 源状态（透明化聚合情况） -->
      <section class="rounded-lg border border-border bg-card p-3">
        <button
          type="button"
          class="flex w-full items-center justify-between"
          @click="showSourcePanel = !showSourcePanel"
        >
          <span class="text-[13px] font-medium text-foreground">资源源状态</span>
          <span class="text-[11px] tabular-nums text-muted-foreground">
            <template v-if="sourcesHealth.length">
              {{ okSourceCount }}/{{ allSourceCount }} 可用
            </template>
            <template v-else>检测中…</template>
          </span>
        </button>
        <div v-if="showSourcePanel" class="mt-2 space-y-1.5">
          <div
            v-for="s in sourcesHealth"
            :key="s.key"
            class="flex items-center gap-2 text-[11px]"
          >
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full"
              :class="s.ok ? 'bg-primary' : 'bg-destructive'"
            ></span>
            <span class="w-20 shrink-0 truncate text-foreground/80">{{ s.name }}</span>
            <span class="flex-1 truncate tabular-nums text-muted-foreground">
              <template v-if="s.ok">{{ (s.total / 10000).toFixed(1) }} 万 · {{ s.upstreamMs }}ms</template>
              <template v-else>{{ s.error || '不可用' }}</template>
            </span>
          </div>
        </div>
      </section>

      <!-- 刷新 -->
      <button
        type="button"
        class="mx-auto flex h-9 items-center gap-1.5 rounded-full border border-border bg-card px-4 text-caption text-muted-foreground"
        :disabled="feed.loading.value"
        @click="feed.refresh()"
      >
        <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': feed.loading.value }" />
        <span>{{ feed.loading.value ? '刷新中…' : '刷新' }}</span>
      </button>
    </template>

    <footer class="pt-2 text-center">
      <p class="text-[11px] text-muted-foreground">追番站 · 多源聚合</p>
      <p class="mt-1 text-[11px] text-muted-foreground">
        内容来自第三方采集接口 · 仅供学习交流 · 版权归原权利人所有
      </p>
    </footer>
  </div>
</template>
