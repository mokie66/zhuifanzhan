import { createRouter, createWebHistory } from 'vue-router'

/**
 * 路由设计
 * --------
 * 关键改动：详情与播放页从「无参数」改为「带参数」，这样链接可分享、刷新不丢状态。
 *   /detail/:sourceKey/:id                    详情
 *   /player/:sourceKey/:id/:episodeIndex      播放（?line=线路key 指定线路）
 *
 * 分类库统一走 BrowseView，用 meta.group 区分语义分组，
 * 新增分类只需加一条路由，不必再写一个视图。
 */
const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { title: '首页', tabBar: true, navKey: 'home' },
  },
  {
    /**
     * 底部导航的「电视剧」：展示当前最热的 12 部，不做翻页浏览
     * （想看更多走搜索，页面底部有引导入口）
     */
    path: '/tv',
    name: 'tv-library',
    component: () => import('@/views/HotListView.vue'),
    props: { group: 'tv', limit: 12 },
    meta: { title: '热门电视剧', tabBar: true, navKey: 'tv', group: 'tv' },
  },
  {
    /** 底部导航的「动漫」：同上，按播放量排序的热门国漫 */
    path: '/anime',
    name: 'anime-library',
    component: () => import('@/views/HotListView.vue'),
    props: { group: 'anime', limit: 12 },
    meta: { title: '热门国漫', tabBar: true, navKey: 'anime', group: 'anime' },
  },
  {
    path: '/movie',
    name: 'movie-library',
    component: () => import('@/views/BrowseView.vue'),
    meta: { title: '电影', tabBar: true, navKey: 'movie', group: 'movie' },
  },
  {
    path: '/variety',
    name: 'variety-library',
    component: () => import('@/views/BrowseView.vue'),
    meta: { title: '综艺', tabBar: true, navKey: 'variety', group: 'variety' },
  },
  {
    // 通用分类入口，便于后续扩展（短剧/纪录片等）
    path: '/browse/:group',
    name: 'browse',
    component: () => import('@/views/BrowseView.vue'),
    meta: { title: '分类', tabBar: true },
  },
  {
    path: '/library',
    name: 'my-library',
    component: () => import('@/views/MyLibraryView.vue'),
    meta: { title: '我的', tabBar: true, navKey: 'library' },
  },
  {
    path: '/detail/:sourceKey/:id',
    name: 'detail',
    component: () => import('@/views/DetailView.vue'),
    meta: { title: '详情', tabBar: false },
  },
  {
    path: '/player/:sourceKey/:id/:episodeIndex',
    name: 'player',
    component: () => import('@/views/PlayerView.vue'),
    meta: { title: '播放', tabBar: false },
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('@/views/SearchView.vue'),
    meta: { title: '搜索', tabBar: false },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { title: '资源源设置', tabBar: false },
  },
  {
    // 兼容旧链接 / 兜底
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    redirect: '/',
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, from, savedPosition) {
    return savedPosition || { top: 0 }
  },
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · 追番站` : '追番站'
})

export default router
