# 追番站（personal-media-vue）

多源聚合的影视播放前端。从多个苹果CMS（MacCMS）采集源并行取数据、合并去重，
用 hls.js 播放直链 m3u8，可打包成 Android APK。

---

## 快速开始

```bash
npm install
npm run dev          # http://localhost:5173
```

打开首页就能看到内容。如果页面空白或没有数据，先看 [排查：页面没数据](#排查页面没数据)。

### 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 18+ | 开发与构建 |
| **JDK 21+** | 21+ | **仅打包 APK 需要**。用 17 或更低会报 `无效的源发行版：21` |
| Android SDK | android-36 / build-tools 36.0.0 | 仅打包 APK 需要 |

---

## 这个项目在做什么

浏览器无法直接调采集接口——**采集源不返回 CORS 头**，部分源还是 http（https 页面下会被混合内容策略拦）。
所以架构上分了两条链路：

```
┌──────────────── 浏览器 ────────────────┐        ┌──────── 采集源 ────────┐
│  Vue 视图层                             │        │  量子 / 非凡 / 电影天堂 │
│    HomeView / BrowseView / SearchView   │        │  魔都 / 天涯 / 最大 ... │
│    DetailView / PlayerView / Settings   │        └───────────┬───────────┘
│              ↓ 只调 api/index.js        │                    │
│  业务层  api/index.js                   │                    │
│    多源并行聚合 · 合并去重 · 缓存 · 分页  │                    │
│         ↓                    ↓          │                    │
│  协议层 api/maccms.js    工具层 utils/   │                    │
│         ↓                               │                    │
│  传输层 api/transport.js                │                    │
│    浏览器 → /collect 代理 ──────────────┼────────────────────┘
│    App    → 原生 HTTP 直连 ─────────────┼────────────────────┘
└─────────────────────────────────────────┘
                     ↓
           视频流由 hls.js 直连 CDN
        （实测 CDN 带 ACAO:*，无需代理）
```

**两条关键实测结论**（决定了整个架构，改动前务必理解）：

| 链路 | CORS 头 | 结论 |
| --- | --- | --- |
| 采集接口（`?ac=list` / `?ac=detail`） | **无** | 浏览器必须走代理 |
| 视频 m3u8 / ts 分片 | `Access-Control-Allow-Origin: *` | 可直连播放，**不需要**流代理 |

所以服务器只转发 JSON，不承担视频带宽。

---

## 目录结构

```
src/
├── api/
│   ├── sources.js       内置默认采集源（唯一数据源，vite.config.js 与 gen-nginx.mjs 也读它）
│   ├── config.js        运行时源配置：内置 / 远程 / 手动 三层，含校验
│   ├── transport.js     传输层：按环境选「同源代理」或「原生直连」
│   ├── maccms.js        MacCMS 协议：请求、响应解析、vod_play_url 解析
│   ├── taxonomy.js      分类语义归一（解决各源 type_id 不一致）
│   ├── rank.js          热度排序与低质降权（各源 hits 填充率差异极大）
│   ├── cache.js         两级缓存：内存 + localStorage，支持 stale-while-revalidate
│   ├── health.js        源健康度与熔断（持久化，重启后即刻生效）
│   └── index.js         业务层：多源聚合、合并去重、缓存、分页策略
├── utils/
│   ├── media.js         数据归一化 + 跨源去重 + 播放地址处理
│   ├── storage.js       收藏 / 历史 / 播放进度（localStorage）
│   └── format.js        展示格式化
├── composables/
│   └── useAsync.js      异步状态封装（含分页列表，带竞态保护）
├── components/
│   ├── VideoPlayer.vue  播放器（hls.js，多线路/选集/进度记忆）
│   ├── MediaCard.vue    影片卡片
│   ├── StateBlock.vue   加载 / 空 / 错误占位
│   ├── AppHeader.vue    顶部栏
│   └── BottomTabNav.vue 底部导航
├── views/
│   ├── HomeView.vue        首页（推广图轮播 + 热门国漫 6 + 热门电视剧 6 + 电影）
│   ├── HotListView.vue     热门榜单页（/tv /anime：12 部热门 + 搜索引导）
│   ├── BrowseView.vue      通用分类浏览（/movie /variety /browse/:group 用）
│   ├── SearchView.vue      多源聚合搜索
│   ├── DetailView.vue      详情 + 选集 + 换源
│   ├── PlayerView.vue      播放 + 线路切换 + 进度记忆
│   ├── MyLibraryView.vue   收藏 / 观看历史
│   ├── SettingsView.vue    资源源设置（远程更新 / 手动导入 / 复检）
│   ├── TvLibraryView.vue   ⚠ 已被 HotListView 取代，文件保留但无引用
│   └── AnimeLibraryView.vue ⚠ 同上
├── router/index.js      路由（详情与播放页带参数，可分享可刷新）
├── styles/theme.css     设计令牌与全局样式
├── App.vue / main.js    应用外壳
└── assets/
    ├── banners/         首页推广图（promo-{1..4}-*.webp，2092x1169）
    └── *.jpg            ⚠ 早期设计稿图片，已无代码引用，可删

scripts/
├── _android-env.ps1     [共享] JDK/SDK 探测（被下面两个 ps1 引用）
├── build-apk.ps1        构建 APK（自动探测环境，支持 -Release）
├── gen-keystore.ps1     生成发布签名密钥
├── gen-nginx.mjs        从 sources.js 生成生产 nginx 配置
├── alias-loader.mjs     [共享] 让 Node 能解析 @/ 别名（验证脚本用）
├── register-loader.mjs  [共享] 注册上面的 loader
├── verify-taxonomy.mjs  验证分类翻译准确率
├── verify-strategy.mjs  验证 t= 语义与子分类轮转策略
├── verify-typeparam.mjs 验证 t= 是精确匹配还是含子分类（诊断用）
├── verify-flow.mjs      端到端全流程 + 播放可行性硬验证
├── verify-storage.mjs   验证收藏/历史/进度逻辑
└── verify-config.mjs    验证源配置校验（远程 JSON 是不可信输入）

docs/
├── 实现说明.md          架构、关键决策、部署、已知限制
├── 移动端打包.md        APK 打包、签名、远程配置下发
└── 运维手册.md          日常维护：换源、排查、发布
```

---

## 数据流

```
HomeView
  → getHomeFeed()                        api/index.js
    → getLatestMulti(['tv','anime','movie'])
      → 对每个源：读分类表 → 翻译语义分组 → 取子分类 id → 查该分类最新
      → mergeVods() 跨源按片名去重，保留线路最全的那条
      → 缓存 3 分钟

PlayerView
  → getDetail({sourceKey, id})            api/index.js
    → 拉详情 + 用片名到其他源找同名片（换源）
    → 合并所有线路到 allLines
  → 选一条 playable 线路的一集
  → VideoPlayer 用 hls.js 播放
  → 播放中节流写 localStorage（进度记忆）
```

---

## 常用命令

```bash
# 开发
npm run dev                    # 启动开发服务器
npm run build                  # 构建 web 产物

# 验证（改动涉及数据层后建议跑 verify:all；含 verify:flow，需 dev server 运行中）
npm run verify:all             # 全部验证
npm run verify:flow            # 端到端 + 播放硬验证（需 dev server 运行中）
npm run verify:rank            # 热度排序与低质降权
npm run verify:cache           # 缓存两级/TTL/熔断/瘦身
npm run verify:storage         # 本地存储逻辑
npm run verify:config          # 源配置校验
npm run verify:taxonomy        # 分类翻译准确率
npm run diagnose:sources       # 诊断各源的数据质量（换源前评估用）
npm run diagnose:home          # 诊断首页耗时（冷启动 vs 二次启动）

# 部署
npm run gen:nginx              # 生成生产 nginx 采集源代理配置

# 打包 APK
powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1            # debug
powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1 -Release   # release
```

---

## 改代码前必须知道的约束

这四条都是实测踩出来的，违反会导致功能静默失效：

### 1. 不要跨源硬编码 `type_id`

各源分类编号体系**互不相同**：

```
源 A：1=电影片   2=连续剧   3=综艺片   4=动漫片
源 C：7=电影     8=连续剧   9=综艺    40=动漫
```

硬编码 `t=1` 查电影，在源 C 上会查到不相干内容。必须走 `taxonomy.js` 按名称语义归一。

### 2. `t=` 是精确匹配，不含子分类

```
量子   t=1（电影片顶级） → total=1      只有顶级自己的占位数据
量子   t=6（动作片子类） → total=4974   正常
非凡   t=1               → total=0      空
```

所以**不能用顶级 id 查询**。当前实现是「子分类轮转」——第 P 页取 `children[(P-1)%n]`，
并让不同源取不同子分类以保证内容多样性。

### 3. `vod_play_url` 有三层分隔符

```
vod_play_from = "liangzi$$$lzm3u8"        ← 线路之间用 $$$
vod_play_url  = "第01集$url#第02集$url$$$第01集$url"
                    ↑      ↑        ↑
                集名与地址 集之间   线路之间
```

且**多数源同时提供两类线路**：解析型（`/share/<hash>`，前端播不了）与直链型（`.m3u8`）。
`parsePlayUrl()` 会给每条线路打 `playable` 标记，UI 必须如实区分，不要假装解析线路能播。

### 4. 改 `sources.js` 后要同步服务端

浏览器版的 `/collect` 代理 location 是按**内置源列表**生成的。所以：

- 改浏览器版源列表 → 必须重跑 `npm run gen:nginx` 并重载 nginx
- App 版直连源站，无此限制
- 也可在 App 内「我的 → 资源源」用远程配置更新，无需重打包

### 5. 热度数据只有部分源提供，排序必须分层

实测各源 `vod_hits` 填充率差异极大：

```
爱奇艺  40/40  ✅ 最高 8425
魔都    40/40  ✅ 最高 44029
量子     0/40  ❌ 全为 0
非凡     0/40  ❌ 全为 0
电影天堂  1/40  ❌
```

`vod_score` 填充率也只有 5~13%，且**接口不支持 `by`/`order`/`sort` 排序参数**
（加什么都没用，返回同一批数据）。所以热度排序只能客户端做。

**关键约束**：绝对不能因为 hits 为 0 就把某个源整体排到末尾——
那会让量子/非凡/电影天堂三个主力源被埋掉，既损失可播片源也破坏多源冗余。
`api/rank.js` 的做法是「各源内部先按自己的信号排序 → 跨源交错取数 →
剩余按全局热度补齐」，保证每个源都有曝光。

改动排序权重时请同步更新 `scripts/verify-rank.mjs` ——
里面有一条专门测「hits 为 0 的源不能被整体埋掉」的用例。

### 6. 首屏性能：四道机制缺一不可

首页冷启动原本要 **20 秒**。实测定位到三个叠加原因，修复后：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 冷启动（首次安装） | 20090 ms | **7089 ms** |
| 二次启动（有缓存） | 20090 ms | **19 ms** |
| 分类表请求数 | 28 次 | **7 次** |
| 缓存体积 | — | 39 KB |

四道机制都在 `api/index.js` / `api/cache.js` / `api/health.js`：

1. **持久化缓存**（`api/cache.js`）—— 原先只有内存 Map，App 一关就没了。
   现在两级缓存（内存 + localStorage），并支持 stale-while-revalidate：
   过期但可用的数据**立刻返回**，同时后台刷新。
   这是「每次进 App 都要等」的主因，也是收益最大的一环。
2. **并发去重**（`maccms.js` 的 `getClasses`）—— 首页要拿 3 个分组，
   三个调用同时发现缓存为空就会各发一次请求。实测每源发 4 次 `ac=list`
   （应为 1 次），而它恰恰是最慢的接口。现在共享同一个 Promise。
3. **首屏总预算**（`HOME_BUDGET_MS`）—— 到点就用已有数据渲染，
   不再等最慢的源。**这是解决木桶效应的关键**：用户不该为第 7 个源买单。
   超时的任务不取消，继续跑完写缓存，下次就有数据。
4. **源健康度熔断**（`api/health.js`）—— 连续失败/连续缓慢的源自动跳过，
   冷却后放行一次试探。**状态持久化**，所以 App 重启后立刻知道哪些源是坏的，
   不用再花 20 秒重新发现一遍。

**两个容易踩的坑**（都实际踩过）：

- `getNavCategories` 也必须传 `deadline`。它内部同样调 `getClasses`，
  并发去重会让它复用正在跑的慢请求；漏传 deadline 时
  `Promise.all` 会一直等到最慢的源，前面 `getLatest` 的预算就白设了。
- 列表类缓存**必须瘦身**（`media.js` 的 `slimVod`）。合并后的列表项带着
  `allLines` / `mirrors` / `lines` / `playableLines`，实测占单条体积 **99.4%**
  （24 条共 1739 KB，其余字段仅约 10 KB）。不瘦身会让 localStorage 记录
  达到 MB 级，既逼近 5MB 配额又拖慢序列化。
  详情页（`detail:*`）**不能**瘦身 —— 它正需要那些线路数据。

调参集中在：`index.js` 的 `HOME_BUDGET_MS` / `PER_SOURCE_TIMEOUT`、
`maccms.js` 的 `CLASS_TIMEOUT`、`transport.js` 的 `REQUEST_TIMEOUT`、
`health.js` 的 `HEALTH_TUNING`。

改完用 `npm run diagnose:home` 复测（先跑一次冷启动，再跑一次看是否秒开）。

### 7. 热门榜只能靠部分源，且必须「不交错」

首页的「热门国漫 / 热门电视剧」和底部导航的 `/anime` `/tv` 走 `getHotList()`，
按播放量（`vod_hits`）排序。取数有几个硬约束（实测见 `scripts/diagnose-hot.mjs`）：

```
vod_hits 填充率：魔都 40/40、爱奇艺 40/40、量子 0/40、非凡 0/40、电影天堂 2/40
接口排序参数   ：by / order / sort 全部无效，返回同一批数据
```

由此得到三条必须遵守的规则：

1. **只用有热度数据的源参与排序**（`rankHot` 会自动剔除 hits 恒为 0 的源）。
   把没有播放量的源硬排进来，只会把批量动态漫顶到榜首。
2. **不能按「源内先排序再交错」之外的任何方式混排原始 hits**。
   各源量级差太多（实测同一天：魔都《遮天》126159，爱奇艺《无可替代》6599），
   直接跨源比大小会让魔都一家霸榜。`rankHot` 的做法是「源内按 hits 排名 →
   按名次交错」，等价于比较「在各自平台上的热门程度」。
   ⚠ 注意这和 `rankVods`（最新场景）的交错目的**完全不同**，别混用。
3. **子分类要挑准**。爆款高度集中在「国产动漫 / 国产剧」，
   泛取整个动漫分组会把刚入库的批量新番带进来。见 `HOT_PREFERRED_SUB`。

**两个容易踩的坑**（都实际踩过）：

- 热门榜预算必须比首屏预算长。实测两个有热度数据的源都要 6 秒以上
  （魔都 分类表 3445ms + 数据 2756ms；爱奇艺 861ms + 5646ms），
  用首屏的 7 秒预算会刚好错过，热门榜就退化成兜底排序了。
  所以有独立的 `HOT_BUDGET_MS`，且首页在质量不足时会后台用长预算重取
  （`upgradeHotInBackground`），拿到好数据再通过 `onRefresh` 推给界面。
- `recordSuccess` 的「慢」判定要传对应预算（`slowMs`）。热门榜预算本来就是
  11 秒，若统一按 6 秒判定，每次拉热门榜都会把魔都/爱奇艺记成「慢」，
  攒够次数被熔断 —— 等于把自己要用的源给封了。

**还有一处容易忽略的启动开销**：`checkSourcesHealth()` 原来在首页 `onMounted`
里就跑，但结果只用于折叠面板，用户不展开就看不到。它会额外发 7 个并发请求，
和首屏热门榜挤在一起，实测会让采集源更难在预算内返回。现已改成首次展开时才探测。

---

## 排查：页面没数据

按顺序检查：

```bash
# 1. 代理通不通（最常出问题的地方）
node -e "fetch('http://localhost:5173/collect/lzi?ac=list').then(r=>r.text()).then(t=>console.log(t.slice(0,120)))"

# 2. 源本身通不通
npm run verify:taxonomy       # 能取到分类表说明源可达

# 3. 全链路
npm run verify:flow
```

**常见原因**：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 代理返回 404 | dev server 刚启动还在预构建依赖 | 等 2~5 秒重试 |
| 代理返回 504 | 源站超时/限流 | 正常现象，聚合层会自动跳过；可在设置页复检 |
| 页面空白 | 所有源都失败 | 检查网络；用设置页的「复检可用性」看具体错误 |
| 播放报错 | 选了「需解析」线路 | 换右上角「换线」选标着「直链」的线路 |
| 部分片子「暂不可播」 | 该片只有解析线路 | 换源（详情页「换源」）找有直链的源 |

更多排查见 [运维手册](docs/运维手册.md)。

---

## 已知限制

1. **解析线路不可播** —— 约一半线路是网页解析型，需要额外解析器组件。UI 已如实标注，不误导用户。
2. **分页是近似语义** —— 多源聚合下各源每页条数不同，当前是「子分类轮转 + 合并」。
3. **源站不稳定** —— 会限流、换域名、关站。已做多源冗余 + 单源失败不影响整体。
4. **用户体系未接入** —— 收藏/历史/进度存 localStorage。`storage.js` 接口全是 Promise，换 HTTP 调用时视图层无需改动。
5. **未做 SSR/SEO** —— 纯客户端渲染。
6. **iOS 无法构建** —— 需要 macOS + Xcode。iOS 侧只能用 PWA。

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [实现说明](docs/实现说明.md) | 架构设计、关键技术决策的来龙去脉、生产部署步骤 |
| [移动端打包](docs/移动端打包.md) | APK 构建、签名、远程配置下发、工具链搭建 |
| [运维手册](docs/运维手册.md) | 日常维护：采集源换域名、加源、排查不可用、发布流程 |

代码注释密度约 14%，关键设计决策都有注释说明「为什么这么做」，
README 与实际代码不符时以代码注释为准。

---

## 免责声明

本项目仅为技术实现，内容来自第三方采集接口，仅供学习交流，版权归原权利人所有。
