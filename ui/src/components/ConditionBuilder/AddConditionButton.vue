<!--
  A group's add affordance: one button that opens a menu holding both things
  there are to add. Extracted from the group so the two conjunction placements
  draw the same control — the header puts it beside the and/or, a row-placed
  group puts it under the rows, and neither owns it.

  Adding a group is dropped from the menu rather than disabled past `maxDepth`,
  since nothing the user can do from here would re-enable it.
-->
<template>
	<Dropdown v-slot="{ open }" :options="options">
		<Button
			data-slot="add-condition"
			:label="context.labels.value.addCondition"
			icon-left="lucide-plus"
			:icon-right="open ? 'lucide-chevron-up' : 'lucide-chevron-down'"
		/>
	</Dropdown>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Button, Dropdown } from "frappe-ui";
import { useConditionBuilderContext } from "./context";
import type { ConditionPath } from "./types";

const props = defineProps<{
	/** The group to add into. */
	path: ConditionPath;

	/** False when a new group here would exceed `maxDepth`. */
	canAddGroup?: boolean;
}>();

const context = useConditionBuilderContext();

interface AddItem {
	label: string;
	onClick: () => void;
}

const options = computed<AddItem[]>(() => {
	const labels = context.labels.value;

	const items: AddItem[] = [
		{
			label: labels.addCondition,
			onClick: () => context.addCondition(props.path),
		},
	];

	if (props.canAddGroup) {
		items.push({
			label: labels.addGroup,
			onClick: () => context.addGroup(props.path),
		});
	}

	return items;
});
</script>
