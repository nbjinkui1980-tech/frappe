<template>
	<div class="flex items-center gap-2 rounded bg-surface-gray-2 p-3">
		<LucideChartLine class="h-4 w-4 text-ink-gray-7" />
		<span class="panel-accent text-base text-ink-gray-8">{{ title }}</span>
		<Button variant="solid" @click="count++">clicked {{ count }}</Button>
	</div>
</template>

<script setup>
import { ref } from "vue";
import { Button } from "frappe-ui";
import LucideChartLine from "~icons/lucide/chart-line";

defineProps({ title: { type: String, default: "fixture island" } });

const count = ref(0);
</script>
