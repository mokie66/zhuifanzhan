<script setup>
/**
 * 首页
 * 数据来自 getHomeFeed()：并发聚合多个采集源的电视剧/动漫/电影最新内容 + 导航分类
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, RefreshCw } from 'lucide-vue-next'
import StateBlock from '@/components/StateBlock.vue'
import MediaCard from '@/components/MediaCard.vue'
import PromoCarousel from '@/components/PromoCarousel.vue'
import { getHomeFeed, checkSourcesHealth } from '@/api/index.js'
import { useAsync } from '@/composables/useAsync.js'
import { formatRelativeTime } from '@/utils/format.js'
import { getHistory } from '@/utils/storage.js'

const router = useRouter()

/**
 * 首页数据
 *
 * onRefresh 的作用：当命中「过期但可用」的持久化缓存时，getHomeFeed 会立即
 * 返回上次的数据（秒开），同时后台刷新；刷新完成后通过这个回调把新数据推上来。
 * 这样用户既不用盯着白屏等，也不会一直看到旧内容。
 */
const feed = useAsync(
  () =>
    getHomeFeed({
      onRefresh: (fresh) => {
        if (fresh) feed.data.value = fresh
      },
    }),
  { initial: null }
)
const history = ref([])
const sourcesHealth = ref([])
const showSourcePanel = ref(false)

onMounted(async () => {
  history.value = (await getHistory()).slice(0, 6)
})

/**
 * 源健康探测改为懒加载
 *
 * 原来在 onMounted 里就跑 checkSourcesHealth()，但结果只用于「源状态」折叠面板，
 * 用户不展开就永远看不到。而它会给全部源各发一个请求（7 个并发），
 * 恰好和首屏的热门榜请求挤在一起，实测会让采集源更难在预算内返回，
 * 热门榜因此拿不到热度数据而退化成「刚入库的新番」。
 * 所以改成首次展开时才探测。
 */
const healthLoading = ref(false)

async function toggleSourcePanel() {
  showSourcePanel.value = !showSourcePanel.value
  if (!showSourcePanel.value || sourcesHealth.value.length || healthLoading.value) return
  healthLoading.value = true
  try {
    sourcesHealth.value = await checkSourcesHealth()
  } catch {
    sourcesHealth.value = []
  } finally {
    healthLoading.value = false
  }
}

const hotAnime = computed(() => feed.data.value?.hotAnime || [])
const hotTv = computed(() => feed.data.value?.hotTv || [])
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
      <!-- 主视觉：推广图轮播（图片自带排版，整张显示不裁切） -->
      <PromoCarousel />

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

      <!-- 热门国漫（放在电视剧之前） -->
      <section v-if="hotAnime.length">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-h2 text-foreground">热门国漫</h2>
          <router-link to="/anime" class="flex items-center text-caption text-primary">
            查看全部<ChevronRight class="h-3.5 w-3.5" />
          </router-link>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <button
            v-for="item in hotAnime"
            :key="`${item.sourceKey}-${item.id}`"
            type="button"
            class="block text-left transition-transform active:scale-[0.98]"
            @click="openDetail(item)"
          >
            <MediaCard :vod="item" />
          </button>
        </div>
      </section>

      <!-- 热门电视剧 -->
      <section v-if="hotTv.length">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-h2 text-foreground">热门电视剧</h2>
          <router-link to="/tv" class="flex items-center text-caption text-primary">
            查看全部<ChevronRight class="h-3.5 w-3.5" />
          </router-link>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <button
            v-for="item in hotTv"
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
          @click="toggleSourcePanel"
        >
          <span class="text-[13px] font-medium text-foreground">资源源状态</span>
          <span class="text-[11px] tabular-nums text-muted-foreground">
            <template v-if="healthLoading">检测中…</template>
            <template v-else-if="sourcesHealth.length">{{ okSourceCount }}/{{ allSourceCount }} 可用</template>
            <template v-else>点击检测</template>
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
