<script setup>
/**
 * 电视剧库
 *
 * 说明：本视图原先内含本地 mock 数据，现已由通用的 BrowseView 取代
 * （见 views/BrowseView.vue —— 它按语义分组从多个采集源聚合真实数据）。
 * 这里保留为薄封装，保证任何残留引用仍然可用，同时不再保留假数据。
 */
import BrowseView from '@/views/BrowseView.vue'

defineProps({})
</script>

<template>
  <BrowseView />
</template>
