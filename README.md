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
│   ├── HomeView.vue        首页（聚合最新电视剧/动漫/电影）
│   ├── BrowseView.vue      通用分类浏览（/tv /anime /movie /variety 共用）
│   ├── SearchView.vue      多源聚合搜索
│   ├── DetailView.vue      详情 + 选集 + 换源
│   ├── PlayerView.vue      播放 + 线路切换 + 进度记忆
│   ├── MyLibraryView.vue   收藏 / 观看历史
│   ├── SettingsView.vue    资源源设置（远程更新 / 手动导入 / 复检）
│   ├── TvLibraryView.vue   ⚠ 已被 BrowseView 取代，仅保留薄封装
│   └── AnimeLibraryView.vue ⚠ 同上
├── router/index.js      路由（详情与播放页带参数，可分享可刷新）
├── styles/theme.css     设计令牌与全局样式
├── App.vue / main.js    应用外壳
└── assets/              ⚠ 早期设计稿图片，已无代码引用，可删

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
npm run verify:storage         # 本地存储逻辑
npm run verify:config          # 源配置校验
npm run verify:taxonomy        # 分类翻译准确率

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
