<script setup>
/**
 * 视频播放器（支持 m3u8 / mp4）
 * ==============================
 * 为什么需要 hls.js：除 Safari 外的浏览器不原生支持 HLS(m3u8)，
 * 需要 MSE 把分片喂给 <video>。
 *
 * 播放链路实测结论：
 *   采集源返回的直链 m3u8 其 CDN 带 `Access-Control-Allow-Origin: *`，
 *   因此跨域直连播放可行，不需要流代理。
 *   例外：若资源是 http 而页面在 https 下，会被混合内容策略拦掉，
 *   此时由 utils/media.js 的 resolvePlayUrl 自动套一层 /collect/_stream 代理。
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import Hls from 'hls.js'
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
} from 'lucide-vue-next'
import { formatDuration } from '@/utils/format.js'
import { resolvePlayUrl } from '@/utils/media.js'

const props = defineProps({
  src: { type: String, default: '' },
  poster: { type: String, default: '' },
  title: { type: String, default: '' },
  autoplay: { type: Boolean, default: true },
  /** 续播起点（秒） */
  startTime: { type: Number, default: 0 },
  /** 是否显示上一集/下一集 */
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
  /** 进度上报节流（毫秒） */
  progressInterval: { type: Number, default: 5000 },
})

const emit = defineEmits(['progress', 'ended', 'error', 'ready', 'prev', 'next', 'save'])

const videoRef = ref(null)
const shellRef = ref(null)
const hls = shallowRef(null)

const ready = ref(false)
const playing = ref(false)
const loading = ref(false)
const errorMsg = ref('')
const currentTime = ref(0)
const duration = ref(0)
const buffered = ref(0)
const volume = ref(1)
const muted = ref(false)
const isFullscreen = ref(false)
const controlsVisible = ref(true)
const speed = ref(1)

let hideTimer = null
let lastReport = 0

const percent = computed(() =>
  duration.value > 0 ? Math.min(100, (currentTime.value / duration.value) * 100) : 0
)
const bufferedPercent = computed(() =>
  duration.value > 0 ? Math.min(100, (buffered.value / duration.value) * 100) : 0
)

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

/* ------------------------------------------------------------------ *
 * 播放核心
 * ------------------------------------------------------------------ */

/** 销毁当前的 hls 实例，释放 MSE */
function destroyHls() {
  if (hls.value) {
    try {
      hls.value.destroy()
    } catch {
      /* 忽略销毁异常 */
    }
    hls.value = null
  }
}

/** 初始化播放源 */
function initSource() {
  const video = videoRef.value
  if (!video) return

  errorMsg.value = ''
  ready.value = false
  loading.value = true
  destroyHls()

  const rawUrl = props.src
  if (!rawUrl) {
    loading.value = false
    errorMsg.value = '没有可播放的地址'
    return
  }
  // http 资源在 https 页面下会被拦，这里自动套流代理
  const url = resolvePlayUrl(rawUrl)

  const isM3u8 = /\.m3u8(\?|#|$)/i.test(url) || url.includes('_stream')

  // Safari / iOS 原生支持 HLS，直接用原生播放，省一层 MSE
  if (isM3u8 && video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url
    video.load()
    return
  }

  if (isM3u8 && Hls.isSupported()) {
    const instance = new Hls({
      // 采集源的 m3u8 多为普通 VOD，关闭低延迟以减少抖动
      lowLatencyMode: false,
      enableWorker: true,
      // 缓冲策略：移动端内存有限，控制缓冲长度
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      maxBufferSize: 60 * 1000 * 1000,
      // 重试策略：资源站 CDN 偶发 5xx / 超时，需要一定容错
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 800,
    })
    instance.loadSource(url)
    instance.attachMedia(video)
    instance.on(Hls.Events.MANIFEST_PARSED, () => {
      loading.value = false
      if (props.autoplay) safePlay()
    })
    instance.on(Hls.Events.ERROR, (event, data) => {
      if (!data.fatal) return
      // 按 hls.js 官方建议分级恢复，而不是直接报错
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          // 网络错误：先尝试重新拉取清单
          try {
            instance.startLoad()
          } catch {
            fallbackNative(video, url)
          }
          break
        case Hls.ErrorTypes.MEDIA_ERROR:
          // 媒体错误：尝试恢复解码
          try {
            instance.recoverMediaError()
          } catch {
            errorMsg.value = '视频解码失败，请切换线路重试'
            loading.value = false
          }
          break
        default:
          errorMsg.value = '该线路播放失败，请切换其他线路'
          loading.value = false
      }
    })
    hls.value = instance
    return
  }

  // mp4 或浏览器既不支持 MSE 也不支持原生 HLS
  video.src = url
  video.load()
}

/** 极端情况下退回原生播放（部分 CDN 的清单无法被 MSE 解析） */
function fallbackNative(video, url) {
  destroyHls()
  video.src = url
  video.load()
}

function safePlay() {
  const video = videoRef.value
  if (!video) return
  // 浏览器自动播放策略可能拒绝，静默处理并同步 UI 状态
  const p = video.play()
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      playing.value = false
    })
  }
}

function togglePlay() {
  const video = videoRef.value
  if (!video) return
  if (video.paused) safePlay()
  else video.pause()
  showControls()
}

function toggleMute() {
  const video = videoRef.value
  if (!video) return
  video.muted = !video.muted
  muted.value = video.muted
}

function onVolumeInput(e) {
  const video = videoRef.value
  if (!video) return
  const v = Number(e.target.value)
  video.volume = v
  video.muted = v === 0
  volume.value = v
  muted.value = video.muted
}

function seekTo(ratio) {
  const video = videoRef.value
  if (!video || !duration.value) return
  const t = Math.max(0, Math.min(duration.value, ratio * duration.value))
  video.currentTime = t
  currentTime.value = t
}

function onSeekClick(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  seekTo((e.clientX - rect.left) / rect.width)
}

function skip(delta) {
  const video = videoRef.value
  if (!video) return
  video.currentTime = Math.max(0, Math.min(duration.value || 1e9, video.currentTime + delta))
}

function setSpeed(rate) {
  const video = videoRef.value
  if (!video) return
  video.playbackRate = rate
  speed.value = rate
}

async function toggleFullscreen() {
  const shell = shellRef.value
  if (!shell) return
  try {
    if (!document.fullscreenElement) {
      await shell.requestFullscreen()
    } else {
      await document.exitFullscreen()
    }
  } catch {
    /* 部分浏览器在非用户手势下会拒绝，忽略 */
  }
}

function onFullscreenChange() {
  isFullscreen.value = Boolean(document.fullscreenElement)
}

/* ------------------------------------------------------------------ *
 * 视频事件
 * ------------------------------------------------------------------ */

function onLoadedMetadata() {
  const video = videoRef.value
  if (!video) return
  loading.value = false
  ready.value = true
  duration.value = Number.isFinite(video.duration) ? video.duration : 0
  // 续播
  if (props.startTime > 0 && props.startTime < duration.value - 3) {
    video.currentTime = props.startTime
    currentTime.value = props.startTime
  }
  emit('ready', { duration: duration.value })
}

function onTimeUpdate() {
  const video = videoRef.value
  if (!video) return
  currentTime.value = video.currentTime
  if (video.buffered.length) {
    try {
      buffered.value = video.buffered.end(video.buffered.length - 1)
    } catch {
      /* buffered 边界竞争，忽略 */
    }
  }
  // 节流上报进度，避免高频写 localStorage
  const now = Date.now()
  if (now - lastReport >= props.progressInterval) {
    lastReport = now
    emit('progress', {
      currentTime: video.currentTime,
      duration: duration.value,
      percent: percent.value,
    })
  }
}

function onEnded() {
  const video = videoRef.value
  emit('save', {
    currentTime: duration.value,
    duration: duration.value,
    percent: 100,
  })
  playing.value = false
  emit('ended')
}

function onVideoError() {
  loading.value = false
  if (!errorMsg.value) errorMsg.value = '播放失败，请切换线路或重试'
  emit('error', errorMsg.value)
}

function onPlaying() {
  playing.value = true
  loading.value = false
  errorMsg.value = ''
}

function onWaiting() {
  loading.value = true
}

function onPause() {
  playing.value = false
  // 暂停时立刻存一次进度，避免用户直接关页面丢进度
  const video = videoRef.value
  if (video && duration.value) {
    emit('save', {
      currentTime: video.currentTime,
      duration: duration.value,
      percent: percent.value,
    })
  }
}

/* ------------------------------------------------------------------ *
 * 控件显隐
 * ------------------------------------------------------------------ */

function showControls() {
  controlsVisible.value = true
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (playing.value) controlsVisible.value = false
  }, 3200)
}

function retry() {
  errorMsg.value = ''
  initSource()
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

watch(
  () => props.src,
  () => {
    initSource()
  },
  { immediate: true }
)

document.addEventListener('fullscreenchange', onFullscreenChange)

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  if (hideTimer) clearTimeout(hideTimer)
  // 卸载前最后存一次进度
  const video = videoRef.value
  if (video && duration.value) {
    emit('save', {
      currentTime: video.currentTime,
      duration: duration.value,
      percent: percent.value,
    })
  }
  destroyHls()
})

defineExpose({ play: safePlay, retry })
</script>

<template>
  <div
    ref="shellRef"
    class="relative w-full bg-black select-none"
    :class="isFullscreen ? 'h-screen' : 'aspect-video'"
    @mousemove="showControls"
    @touchstart="showControls"
    @click="showControls"
  >
    <video
      ref="videoRef"
      class="h-full w-full bg-black object-contain"
      :poster="poster"
      playsinline
      webkit-playsinline
      preload="metadata"
      @loadedmetadata="onLoadedMetadata"
      @timeupdate="onTimeUpdate"
      @ended="onEnded"
      @error="onVideoError"
      @playing="onPlaying"
      @waiting="onWaiting"
      @pause="onPause"
      @play="playing = true"
      @click.stop="togglePlay"
    ></video>

    <!-- 居中大播放按钮（暂停时显示） -->
    <div
      v-if="!playing && !loading && !errorMsg"
      class="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <span
        class="inline-flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground"
      >
        <Play class="h-7 w-7" />
      </span>
    </div>

    <!-- 加载中 -->
    <div
      v-if="loading && !errorMsg"
      class="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <Loader2 class="h-8 w-8 animate-spin text-white/85" />
    </div>

    <!-- 错误态 -->
    <div
      v-if="errorMsg"
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center"
    >
      <p class="text-[13px] text-white/90">{{ errorMsg }}</p>
      <button
        type="button"
        class="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-caption font-medium text-primary-foreground"
        @click.stop="retry"
      >
        <RotateCcw class="h-4 w-4" />
        <span>重试</span>
      </button>
    </div>

    <!-- 控制栏 -->
    <div
      class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-6 transition-opacity duration-200"
      :class="controlsVisible || !playing ? 'opacity-100' : 'opacity-0'"
    >
      <!-- 进度条 -->
      <div
        class="group relative h-6 cursor-pointer"
        role="slider"
        :aria-valuenow="Math.round(percent)"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-label="播放进度"
        @click.stop="onSeekClick"
      >
        <div class="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/30">
          <div class="h-full rounded-full bg-white/40" :style="{ width: bufferedPercent + '%' }"></div>
        </div>
        <div
          class="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary"
          :style="{ width: percent + '%' }"
        ></div>
        <div
          class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary transition-transform group-hover:scale-125"
          :style="{ left: percent + '%' }"
        ></div>
      </div>

      <!-- 按钮行 -->
      <div class="mt-0.5 flex items-center gap-2 text-white">
        <button
          type="button"
          class="inline-flex h-8 w-8 items-center justify-center rounded"
          :aria-label="playing ? '暂停' : '播放'"
          @click.stop="togglePlay"
        >
          <Pause v-if="playing" class="h-4 w-4" />
          <Play v-else class="h-4 w-4" />
        </button>

        <button
          v-if="hasPrev"
          type="button"
          class="inline-flex h-8 w-8 items-center justify-center rounded"
          aria-label="上一集"
          @click.stop="emit('prev')"
        >
          <ChevronLeft class="h-4 w-4" />
        </button>
        <button
          v-if="hasNext"
          type="button"
          class="inline-flex h-8 w-8 items-center justify-center rounded"
          aria-label="下一集"
          @click.stop="emit('next')"
        >
          <ChevronRight class="h-4 w-4" />
        </button>

        <span class="shrink-0 text-[11px] tabular-nums">
          {{ formatDuration(currentTime) }} / {{ formatDuration(duration) }}
        </span>

        <div class="flex-1"></div>

        <!-- 倍速 -->
        <button
          type="button"
          class="hidden h-8 items-center rounded px-2 text-[11px] tabular-nums sm:inline-flex"
          @click.stop="setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])"
        >
          {{ speed }}x
        </button>

        <!-- 音量 -->
        <div class="hidden items-center gap-1 sm:flex">
          <button
            type="button"
            class="inline-flex h-8 w-8 items-center justify-center rounded"
            :aria-label="muted ? '取消静音' : '静音'"
            @click.stop="toggleMute"
          >
            <VolumeX v-if="muted || volume === 0" class="h-4 w-4" />
            <Volume2 v-else class="h-4 w-4" />
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            class="h-1 w-16 cursor-pointer accent-[var(--color-primary)]"
            :value="muted ? 0 : volume"
            aria-label="音量"
            @click.stop
            @input="onVolumeInput"
          >
        </div>

        <button
          type="button"
          class="inline-flex h-8 w-8 items-center justify-center rounded"
          :aria-label="isFullscreen ? '退出全屏' : '全屏'"
          @click.stop="toggleFullscreen"
        >
          <Minimize v-if="isFullscreen" class="h-4 w-4" />
          <Maximize v-else class="h-4 w-4" />
        </button>
      </div>
    </div>
  </div>
</template>
