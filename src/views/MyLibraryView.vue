<script setup>
/**
 * 我的：收藏 / 观看历史
 * 数据来自 localStorage（utils/storage.js）。
 * 后端用户体系接入后，只需把 storage.js 内部实现换成 HTTP 调用，本页无需改动。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Heart, Play, Settings, Trash2, UserRound } from 'lucide-vue-next'
import MediaCard from '@/components/MediaCard.vue'
import StateBlock from '@/components/StateBlock.vue'
import { formatRelativeTime, formatStatus } from '@/utils/format.js'
import {
  getFavorites,
  getHistory,
  clearHistory,
  removeFavorite,
} from '@/utils/storage.js'

const router = useRouter()

const TABS = [
  { key: 'favorites', label: '收藏' },
  { key: 'history', label: '观看历史' },
]

const activeTab = ref('favorites')
const favorites = ref([])
const history = ref([])
const loading = ref(true)

async function loadAll() {
  loading.value = true
  try {
    const [f, h] = await Promise.all([getFavorites(), getHistory()])
    favorites.value = f
    history.value = h
  } finally {
    loading.value = false
  }
}

onMounted(loadAll)

const currentList = computed(() =>
  activeTab.value === 'favorites' ? favorites.value : history.value
)

function openDetail(item) {
  router.push({ name: 'detail', params: { sourceKey: item.sourceKey, id: item.id } })
}

function resume(item) {
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

async function onRemoveFav(item) {
  await removeFavorite(item)
  favorites.value = await getFavorites()
}

async function onClearHistory() {
  await clearHistory()
  history.value = []
}
</script>

<template>
  <div>
    <!-- 用户信息条（本地版：提示数据存于本机） -->
    <section class="flex items-center gap-3 px-4 pt-4">
      <span class="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-muted">
        <UserRound class="h-7 w-7 text-muted-foreground" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-[15px] font-medium text-foreground">本机用户</p>
        <p class="mt-0.5 text-[11px] text-muted-foreground">
          收藏与进度保存在本机浏览器，接入账号后可跨设备同步
        </p>
      </div>
      <router-link
        to="/settings"
        class="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-border px-3 text-caption text-primary"
      >
        <Settings class="h-4 w-4" />
        <span>资源源</span>
      </router-link>
    </section>

    <!-- 分区切换 -->
    <div class="mt-4 flex gap-2 border-b border-border px-4">
      <button
        v-for="t in TABS"
        :key="t.key"
        type="button"
        class="relative h-10 px-3 text-[14px]"
        :class="activeTab === t.key ? 'font-medium text-primary' : 'text-muted-foreground'"
        @click="activeTab = t.key"
      >
        {{ t.label }}
        <span class="ml-1 text-[11px] tabular-nums">
          {{ t.key === 'favorites' ? favorites.length : history.length }}
        </span>
        <span
          v-if="activeTab === t.key"
          class="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary"
        ></span>
      </button>
      <div class="flex-1"></div>
      <button
        v-if="activeTab === 'history' && history.length"
        type="button"
        class="inline-flex h-10 items-center gap-1 text-caption text-muted-foreground"
        @click="onClearHistory"
      >
        <Trash2 class="h-3.5 w-3.5" />
        <span>清空</span>
      </button>
    </div>

    <!-- 状态 -->
    <div class="px-4 pt-4">
      <StateBlock
        :loading="loading"
        :empty="!loading && currentList.length === 0"
        :empty-text="activeTab === 'favorites' ? '还没有收藏，去详情页点个收藏吧' : '还没有观看记录'"
      />
    </div>

    <!-- 收藏：海报网格 -->
    <div v-if="activeTab === 'favorites' && favorites.length" class="mt-1 grid grid-cols-2 gap-3 px-4">
      <div v-for="item in favorites" :key="item.sourceKey + item.id" class="relative">
        <button
          type="button"
          class="block w-full text-left transition-transform active:scale-[0.98]"
          @click="openDetail(item)"
        >
          <MediaCard :vod="item" />
        </button>
        <button
          type="button"
          class="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white"
          aria-label="取消收藏"
          @click.stop="onRemoveFav(item)"
        >
          <Heart class="h-4 w-4 fill-current" />
        </button>
      </div>
    </div>

    <!-- 历史：列表 -->
    <div v-if="activeTab === 'history' && history.length" class="mt-1 space-y-3 px-4">
      <div
        v-for="item in history"
        :key="item.sourceKey + item.id"
        class="flex gap-3 rounded-lg border border-border bg-card p-2.5"
      >
        <button
          type="button"
          class="h-[72px] w-[52px] shrink-0 overflow-hidden rounded bg-muted"
          @click="openDetail(item)"
        >
          <img
            v-if="item.poster"
            :src="item.poster"
            :alt="`《${item.title}》封面`"
            class="h-full w-full object-cover"
            referrerpolicy="no-referrer"
          >
        </button>
        <div class="min-w-0 flex-1">
          <button type="button" class="block w-full text-left" @click="openDetail(item)">
            <h3 class="truncate text-[14px] font-medium text-foreground">{{ item.title }}</h3>
            <p class="mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground">
              {{ item.episodeName || `第 ${(item.episodeIndex || 0) + 1} 集` }}
              <template v-if="item.watchedAt"> · {{ formatRelativeTime(item.watchedAt) }}</template>
            </p>
          </button>
          <div class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              class="h-full rounded-full bg-primary"
              :style="{ width: `${Math.min(100, item.percent || 0)}%` }"
            ></div>
          </div>
          <button
            type="button"
            class="mt-2 inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-[12px] text-primary"
            @click="resume(item)"
          >
            <Play class="h-3.5 w-3.5" />
            <span>继续播放</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
