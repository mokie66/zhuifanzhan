import { ref, shallowRef, watch } from 'vue'

/**
 * 异步数据加载状态封装
 *
 * 统一处理 loading / error / data 三态，配合 StateBlock 组件使用。
 * 内置请求竞态保护：快速切换页面时，旧请求的结果不会覆盖新请求。
 *
 * @param {Function} loader 返回 Promise 的函数
 * @param {object} options
 *   immediate  是否立即执行，默认 true
 *   watchSource 需要监听并重新加载的响应式源（ref 或 getter 数组）
 *   initial    初始数据
 *   onError    错误回调
 */
export function useAsync(loader, options = {}) {
  const { immediate = true, watchSource, initial = null, onError } = options

  const data = shallowRef(initial)
  const loading = ref(false)
  const error = ref('')
  /** 是否已经完成过至少一次加载（用于区分「首次加载」与「刷新」） */
  const loaded = ref(false)

  let seq = 0

  async function run(...args) {
    const mySeq = ++seq
    loading.value = true
    error.value = ''
    try {
      const result = await loader(...args)
      // 竞态保护：只有最新一次请求可以写入结果
      if (mySeq !== seq) return data.value
      data.value = result
      loaded.value = true
      return result
    } catch (err) {
      if (mySeq !== seq) return data.value
      error.value = err?.message || String(err)
      onError?.(err)
      return null
    } finally {
      if (mySeq === seq) loading.value = false
    }
  }

  if (immediate) run()

  if (watchSource) {
    const sources = Array.isArray(watchSource) ? watchSource : [watchSource]
    watch(sources, () => run(), { deep: false })
  }

  return { data, loading, error, loaded, run, refresh: () => run() }
}

/**
 * 带分页的列表加载
 * 维护 items 累积、页码、是否还有下一页
 */
export function usePagedList(loader, options = {}) {
  const { pageSize = 24, onError } = options
  const items = ref([])
  const page = ref(1)
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref('')
  const hasMore = ref(true)
  const sourceStats = ref(null)
  let seq = 0

  async function load(reset = false) {
    if (reset) {
      seq++
      page.value = 1
      items.value = []
      hasMore.value = true
      error.value = ''
    }
    const mySeq = seq
    const isFirst = page.value === 1
    if (isFirst) loading.value = true
    else loadingMore.value = true

    try {
      const res = await loader({ page: page.value, pageSize })
      if (mySeq !== seq) return
      const list = res?.items || []
      items.value = isFirst ? list : [...items.value, ...list]
      hasMore.value = Boolean(res?.hasMore) && list.length > 0
      sourceStats.value = res?.sourceStats || null
      error.value = ''
    } catch (err) {
      if (mySeq !== seq) return
      error.value = err?.message || String(err)
      onError?.(err)
    } finally {
      if (mySeq === seq) {
        loading.value = false
        loadingMore.value = false
      }
    }
  }

  async function next() {
    if (!hasMore.value || loadingMore.value || loading.value) return
    page.value += 1
    await load(false)
  }

  return {
    items,
    page,
    loading,
    loadingMore,
    error,
    hasMore,
    sourceStats,
    load,
    next,
    reset: () => load(true),
  }
}
