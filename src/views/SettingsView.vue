<script setup>
/**
 * 设置页：采集源配置管理
 * ========================
 * 这是 App 版可维护性的关键。采集源换域名极频繁，如果源列表硬编码在安装包里，
 * 换一次就得重新发版。这里提供三条更新途径：
 *   1. 远程 URL 拉取  ← 推荐，换域名只需改远端 JSON
 *   2. 手动粘贴 JSON  ← 应急
 *   3. 单个源开关    ← 临时排查
 *
 * 浏览器版注意：请求要经服务端代理，而代理的 location 是按内置源列表生成的。
 * 所以浏览器版改了源列表需要重新生成服务端配置（node scripts/gen-nginx.mjs）。
 * 原生 App 直连源站，没有这个限制 —— 页面上会明确提示当前处境。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ClipboardPaste,
  CloudDownload,
  Copy,
  Info,
  RefreshCw,
  RotateCcw,
  Server,
  Smartphone,
  Trash2,
  Wifi,
} from 'lucide-vue-next'
import StateBlock from '@/components/StateBlock.vue'
import {
  getActiveSources,
  getConfigMeta,
  refreshFromRemote,
  applyManualConfig,
  resetToBundled,
  toggleSourceEnabled,
  exportConfig,
} from '@/api/config.js'
import { isNative, runtimeKind } from '@/api/transport.js'
import { checkSourcesHealth, clearCache } from '@/api/index.js'

const router = useRouter()

const meta = ref(getConfigMeta())
const sources = ref(getActiveSources())
const health = ref([])
const checking = ref(false)

const remoteUrl = ref(meta.value.remoteUrl || '')
const busy = ref(false)
const message = ref({ type: '', text: '' })
const showManual = ref(false)
const manualText = ref('')
const showTemplate = ref(false)

function refreshState() {
  meta.value = getConfigMeta()
  sources.value = getActiveSources()
}

function setMessage(type, text) {
  message.value = { type, text }
  if (type === 'ok') setTimeout(() => (message.value = { type: '', text: '' }), 4000)
}

/** 从远程 URL 更新配置 */
async function doRemoteUpdate() {
  if (!remoteUrl.value.trim()) {
    setMessage('err', '请先填写配置地址')
    return
  }
  busy.value = true
  try {
    const list = await refreshFromRemote(remoteUrl.value)
    clearCache()
    refreshState()
    setMessage('ok', `已更新，共 ${list.length} 个源`)
  } catch (e) {
    setMessage('err', e.message)
  } finally {
    busy.value = false
  }
}

/** 手动导入 */
function doManualImport() {
  if (!manualText.value.trim()) {
    setMessage('err', '请粘贴配置 JSON')
    return
  }
  try {
    const list = applyManualConfig(manualText.value)
    clearCache()
    refreshState()
    showManual.value = false
    manualText.value = ''
    setMessage('ok', `已导入，共 ${list.length} 个源`)
  } catch (e) {
    setMessage('err', e.message)
  }
}

/** 恢复内置默认 */
function doReset() {
  clearCache()
  resetToBundled()
  remoteUrl.value = ''
  refreshState()
  setMessage('ok', '已恢复内置默认源')
}

/** 单个源开关 */
function onToggle(src) {
  toggleSourceEnabled(src.key, !src.enabled)
  clearCache()
  refreshState()
}

/** 一键复检所有源（并发探测可用性） */
async function doHealthCheck() {
  checking.value = true
  try {
    health.value = await checkSourcesHealth()
  } catch (e) {
    setMessage('err', `检测失败: ${e.message}`)
  } finally {
    checking.value = false
  }
}

function healthOf(key) {
  return health.value.find((h) => h.key === key)
}

/** 复制当前配置，方便分享或备份 */
async function doExport() {
  const text = JSON.stringify(exportConfig(), null, 2)
  try {
    await navigator.clipboard.writeText(text)
    setMessage('ok', '配置已复制到剪贴板')
  } catch {
    // 剪贴板不可用时退回展示文本
    manualText.value = text
    showManual.value = true
    setMessage('err', '剪贴板不可用，已填入下方文本框，请手动复制')
  }
}

const template = computed(() =>
  JSON.stringify(
    {
      version: 1,
      updatedAt: new Date().toISOString().slice(0, 10),
      sources: [
        {
          key: 'lzi',
          name: '量子资源',
          api: 'http://cj.lziapi.com/api.php/provide/vod/',
          enabled: true,
          weight: 100,
          note: '备注（可选）',
        },
      ],
    },
    null,
    2
  )
)

const runtime = computed(() => runtimeKind())
const nativeMode = computed(() => isNative())

onMounted(() => {
  refreshState()
})
</script>

<template>
  <div class="pb-8">
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
      <span class="text-[15px] font-medium text-foreground">资源源设置</span>
    </div>

    <!-- 运行环境 -->
    <section class="px-4 pt-4">
      <div class="flex items-center gap-2 rounded-lg border border-border bg-card p-3">
        <component
          :is="nativeMode ? Smartphone : Server"
          class="h-4 w-4 shrink-0"
          :class="nativeMode ? 'text-primary' : 'text-muted-foreground'"
        />
        <div class="min-w-0 flex-1">
          <p class="text-[13px] font-medium text-foreground">
            {{ nativeMode ? 'App 版（原生直连）' : '浏览器版（服务端代理）' }}
          </p>
          <p class="mt-0.5 text-[11px] text-muted-foreground">
            {{
              nativeMode
                ? '请求由原生层发出，不受同源策略限制，可直连采集源，无需服务器'
                : '请求经服务端 /collect 代理转发；改动源列表后需重新生成服务端配置'
            }}
          </p>
        </div>
      </div>
      <p v-if="!nativeMode" class="mt-2 rounded-md bg-muted px-3 py-2 text-[11px] text-muted-foreground">
        浏览器版改了源列表后，请在服务器执行：
        <code class="text-primary">node scripts/gen-nginx.mjs</code>
        并重载 nginx
      </p>
    </section>

    <!-- 结果提示 -->
    <div
      v-if="message.text"
      class="mx-4 mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-[12px]"
      :class="message.type === 'ok' ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive'"
    >
      <component :is="message.type === 'ok' ? Check : AlertTriangle" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span class="min-w-0 flex-1 break-all">{{ message.text }}</span>
    </div>

    <!-- 当前配置状态 -->
    <section class="px-4 pt-4">
      <h2 class="text-[15px] font-medium text-foreground">当前配置</h2>
      <div class="mt-2 space-y-1.5 rounded-lg border border-border bg-card p-3 text-[12px]">
        <div class="flex justify-between">
          <span class="text-muted-foreground">来源</span>
          <span class="text-foreground">{{ meta.originLabel }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-muted-foreground">源数量</span>
          <span class="tabular-nums text-foreground">{{ meta.enabled }} 启用 / {{ meta.count }} 总计</span>
        </div>
        <div v-if="meta.updatedAt" class="flex justify-between gap-3">
          <span class="shrink-0 text-muted-foreground">更新时间</span>
          <span class="min-w-0 truncate text-right text-foreground">{{ meta.updatedAt }}</span>
        </div>
        <div v-if="meta.remoteUrl" class="flex justify-between gap-3">
          <span class="shrink-0 text-muted-foreground">远程地址</span>
          <span class="min-w-0 truncate text-right text-foreground">{{ meta.remoteUrl }}</span>
        </div>
      </div>
    </section>

    <!-- 远程更新 -->
    <section class="px-4 pt-5">
      <h2 class="text-[15px] font-medium text-foreground">从远程地址更新</h2>
      <p class="mt-1 text-[11px] text-muted-foreground">
        源站换域名时，只需更新这个 JSON，无需重新发版
      </p>
      <div class="mt-2 flex gap-2">
        <input
          v-model="remoteUrl"
          type="url"
          inputmode="url"
          placeholder="https://example.com/sources.json"
          class="h-11 min-w-0 flex-1 rounded-md border border-border bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        >
        <button
          type="button"
          class="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md bg-primary px-4 text-caption font-medium text-primary-foreground disabled:opacity-50"
          :disabled="busy"
          @click="doRemoteUpdate"
        >
          <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': busy }" />
          <span>{{ busy ? '更新中' : '更新' }}</span>
        </button>
      </div>
    </section>

    <!-- 手动导入 -->
    <section class="px-4 pt-5">
      <button
        type="button"
        class="flex w-full items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5"
        @click="showManual = !showManual"
      >
        <span class="flex items-center gap-2 text-[13px] text-foreground">
          <ClipboardPaste class="h-4 w-4 text-muted-foreground" />
          手动粘贴配置
        </span>
        <span class="text-[11px] text-muted-foreground">{{ showManual ? '收起' : '展开' }}</span>
      </button>
      <div v-if="showManual" class="mt-2">
        <textarea
          v-model="manualText"
          rows="7"
          placeholder='{"sources":[{"key":"lzi","name":"量子","api":"http://...","enabled":true,"weight":100}]}'
          class="w-full rounded-md border border-border bg-card p-3 font-mono text-[11px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        ></textarea>
        <div class="mt-2 flex gap-2">
          <button
            type="button"
            class="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary text-caption font-medium text-primary-foreground"
            @click="doManualImport"
          >
            <Check class="h-4 w-4" />
            导入
          </button>
          <button
            type="button"
            class="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 text-caption text-muted-foreground"
            @click="showTemplate = !showTemplate"
          >
            <Info class="h-4 w-4" />
            格式说明
          </button>
        </div>
        <pre
          v-if="showTemplate"
          class="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-[10px] leading-relaxed text-muted-foreground"
        >{{ template }}</pre>
      </div>
    </section>

    <!-- 源列表 -->
    <section class="px-4 pt-5">
      <div class="flex items-center justify-between">
        <h2 class="text-[15px] font-medium text-foreground">采集源</h2>
        <button
          type="button"
          class="inline-flex h-8 items-center gap-1 rounded-full border border-border px-3 text-[12px] text-primary disabled:opacity-50"
          :disabled="checking"
          @click="doHealthCheck"
        >
          <Wifi class="h-3.5 w-3.5" :class="{ 'animate-pulse': checking }" />
          {{ checking ? '检测中' : '复检可用性' }}
        </button>
      </div>

      <div class="mt-2 space-y-2">
        <div
          v-for="src in sources"
          :key="src.key"
          class="rounded-lg border border-border bg-card p-3"
        >
          <div class="flex items-start gap-2">
            <span
              class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
              :class="
                healthOf(src.key)
                  ? healthOf(src.key).ok
                    ? 'bg-primary'
                    : 'bg-destructive'
                  : src.enabled
                    ? 'bg-primary/50'
                    : 'bg-muted-foreground/40'
              "
            ></span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-[13px] font-medium text-foreground">{{ src.name }}</span>
                <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {{ src.key }}
                </span>
                <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  w{{ src.weight }}
                </span>
              </div>
              <p class="mt-0.5 break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
                {{ src.api }}
              </p>
              <p v-if="src.note" class="mt-1 text-[11px] text-muted-foreground">{{ src.note }}</p>
              <p v-if="healthOf(src.key)" class="mt-1 text-[11px] tabular-nums">
                <template v-if="healthOf(src.key).ok">
                  <span class="text-primary">可用</span>
                  <span class="text-muted-foreground">
                    · {{ (healthOf(src.key).total / 10000).toFixed(1) }} 万资源 ·
                    {{ healthOf(src.key).upstreamMs }}ms
                  </span>
                </template>
                <template v-else>
                  <span class="text-destructive">不可用</span>
                  <span class="text-muted-foreground"> · {{ healthOf(src.key).error }}</span>
                </template>
              </p>
            </div>
            <!-- 开关 -->
            <button
              type="button"
              class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
              :class="src.enabled ? 'bg-primary' : 'bg-muted'"
              :aria-label="`${src.enabled ? '关闭' : '启用'} ${src.name}`"
              @click="onToggle(src)"
            >
              <span
                class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform"
                :style="{ left: src.enabled ? '22px' : '2px' }"
              ></span>
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 操作 -->
    <section class="mt-5 space-y-2 px-4">
      <button
        type="button"
        class="flex h-11 w-full items-center justify-center gap-1.5 rounded-md border border-border bg-card text-caption text-foreground"
        @click="doExport"
      >
        <Copy class="h-4 w-4" />
        复制当前配置
      </button>
      <button
        type="button"
        class="flex h-11 w-full items-center justify-center gap-1.5 rounded-md border border-border bg-card text-caption text-muted-foreground"
        @click="doReset"
      >
        <RotateCcw class="h-4 w-4" />
        恢复内置默认
      </button>
    </section>
  </div>
</template>
