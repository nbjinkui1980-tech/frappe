<!--
  The per-row overflow menu: Turn into a Group / Ungroup / Remove. Turning a leaf
  into a group nests it a level deeper, so it is dropped past `maxDepth`; Ungroup
  and Remove act on rows that already exist. `Button` overwrites `aria-label`
  from its `label` prop, so the icon-only trigger is named through
  `aria-labelledby` — including the row's field, so the Status row's menu is not
  one of eight identical ones.

  Reordering is not in here: the handle is the way a row moves. That leaves it
  pointer-only — a host that needs a keyboard path can put one in `#actions`,
  where `moveUp` / `moveDown` and their guards are handed to the slot.
-->
<template>
	<!-- The row's last track takes every pixel the cells before it did not use and
	holds this against its end edge, so the menu lands on the container's edge in
	every row rather than wherever the value control happened to stop. -->
	<div v-if="!context.readonly.value" data-slot="condition-actions" class="w-max">
		<Dropdown placement="right" :options="options">
			<Button variant="ghost" icon="lucide-more-horizontal" :aria-labelledby="nameIds" />
		</Dropdown>
		<span :id="nameId" class="sr-only">{{ name }}</span>
	</div>
</template>

<script setup lang="ts">
import { computed, useId } from "vue";
import { Button, Dropdown } from "frappe-ui";
import { useConditionBuilderContext } from "./context";
import { canNest } from "./tree";
import type { ConditionPath } from "./types";

const props = defineProps<{
	path: ConditionPath;
	isGroup: boolean;

	/** Id of the element holding this row's field label, rendered by the row. */
	fieldLabelId?: string;
}>();

const context = useConditionBuilderContext();
const nameId = useId();

const nameIds = computed(() => (props.fieldLabelId ? `${props.fieldLabelId} ${nameId}` : nameId));

interface ActionItem {
	label: string;
	icon?: string;
	theme?: "red";
	onClick: () => void;
}

const name = computed(() =>
	props.isGroup ? context.labels.value.groupActions : context.labels.value.rowActions
);

const options = computed<ActionItem[]>(() => {
	const labels = context.labels.value;
	const items: ActionItem[] = [];

	// Wrapping a leaf puts a group where the leaf sits, which is the same reach as
	// adding a group to its parent — hence the parent's path here.
	const parentPath = props.path.slice(0, -1);

	if (!props.isGroup && canNest(parentPath, context.maxDepth.value)) {
		items.push({
			label: labels.turnIntoGroup,
			icon: "lucide-group",
			onClick: () => context.turnIntoGroup(props.path),
		});
	}

	if (props.isGroup) {
		items.push({
			label: labels.ungroup,
			icon: "lucide-ungroup",
			onClick: () => context.ungroup(props.path),
		});
	}

	items.push({
		label: props.isGroup ? labels.removeGroup : labels.remove,
		icon: "lucide-trash-2",
		theme: "red",
		onClick: () => context.remove(props.path),
	});

	return items;
});
</script>
