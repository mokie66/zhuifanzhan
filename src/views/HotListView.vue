<script setup>
/**
 * 热门榜单页（底部导航的「电视剧」「动漫」入口）
 * ================================================
 * 与 BrowseView 的区别
 * --------------------
 * BrowseView 是「按分类翻页浏览」，适合从 /browse/:group 这种带分类参数的入口进。
 * 本页面是「当前最热的 N 部」，只展示热门榜，不提供翻页 ——
 * 想看别的片子走搜索。这样首屏就是精选内容，而不是刚入库的批量新番。
 *
 * 数据来自 getHotList()：按播放量排序（取数细节见 api/index.js 的说明）。
 * 它只挑「有热度数据」的源参与排序，所以榜单里不会混进没有播放量的动态漫。
 */
import { computed } from 'vue'
import { Search, ChevronRight, Flame } from 'lucide-vue-next'
import StateBlock from '@/components/StateBlock.vue'
import MediaCard from '@/components/MediaCard.vue'
import { getHotList } from '@/api/index.js'
import { useAsync } from '@/composables/useAsync.js'

const props = defineProps({
  /** 语义分组：tv / anime / movie / variety */
  group: { type: String, required: true },
  /** 展示条数 */
  limit: { type: Number, default: 12 },
})

const LABELS = {
  anime: { title: '热门国漫', desc: '当前播放量最高的国漫' },
  tv: { title: '热门电视剧', desc: '当前播放量最高的剧集' },
  movie: { title: '热门电影', desc: '当前播放量最高的电影' },
  variety: { title: '热门综艺', desc: '当前播放量最高的综艺' },
}

const label = computed(() => LABELS[props.group] || { title: '热门', desc: '当前最热门的内容' })

const hot = useAsync(() => getHotList(props.group, { limit: props.limit }), { initial: [] })
</script>

<template>
  <div class="px-4 pt-4">
    <header class="mb-3">
      <h1 class="flex items-center gap-1.5 text-h2 text-foreground">
        <Flame class="h-4.5 w-4.5 text-primary" />
        {{ label.title }}
      </h1>
      <p class="mt-0.5 text-caption text-muted-foreground">
        {{ label.desc }} · 共 {{ hot.data.value?.length || 0 }} 部
      </p>
    </header>

    <StateBlock
      v-if="hot.loading.value && !hot.data.value?.length"
      :loading="true"
      loading-text="正在统计播放量…"
    />
    <StateBlock
      v-else-if="hot.error.value && !hot.data.value?.length"
      :error="hot.error.value"
      @retry="hot.refresh()"
    />

    <template v-else>
      <div class="grid grid-cols-2 gap-3">
        <router-link
          v-for="(item, i) in hot.data.value"
          :key="`${item.sourceKey}-${item.id}`"
          :to="{ name: 'detail', params: { sourceKey: item.sourceKey, id: item.id } }"
          class="relative block text-left transition-transform active:scale-[0.98]"
        >
          <!-- 名次角标：热门榜有排序意义，标出来比不标更有信息量 -->
          <span
            class="absolute left-1.5 top-1.5 z-10 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums"
            :class="i < 3 ? 'bg-primary text-primary-foreground' : 'bg-black/55 text-white'"
          >{{ i + 1 }}</span>
          <MediaCard :vod="item" />
        </router-link>
      </div>

      <!--
        搜索引导
        做成可点击的入口而不是一句静态提示 —— 静态文案用户不知道该点哪，
        而搜索入口在顶部栏，容易被忽略。
      -->
      <section
        class="mt-6 rounded-lg border border-dashed border-border bg-card p-4 text-center"
      >
        <p class="text-[15px] font-medium text-foreground">想看更多？</p>
        <p class="mt-1 text-caption text-muted-foreground">
          这里只列了当前最热门的 {{ hot.data.value?.length || limit }} 部。<br>
          想找特定的片子，用搜索更快。
        </p>
        <router-link
          to="/search"
          class="mt-3 inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-transform active:scale-[0.97] motion-reduce:transform-none"
        >
          <Search class="h-3.5 w-3.5" />
          <span>去搜索</span>
          <ChevronRight class="h-3.5 w-3.5" />
        </router-link>
      </section>
    </template>
  </div>
</template>
