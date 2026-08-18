<!--
  What goes in a row's leading cell: "Where" on the first row of a group, and on
  every row after it the group's own operator, which joins that row to the one
  above.

  The cell around it — its width, the band that keeps it level with the controls,
  and the bracket it sits on — belongs to the row. This renders the word and
  nothing else, so a host replacing it through `#where` / `#conjunction` keeps all
  three.

  A group holds one operator, so exactly one cell in it is a control: the first
  gap, row 1. Every cell below repeats the same word as plain text, and so does
  every cell in a read-only tree. Text rather than a disabled button, in both
  cases: a disabled control is skipped in a screen reader's forms mode and is
  exempt from the contrast minimum, so a group of eight would be read as one
  operator and seven blanks. `Button` overwrites a fallthrough `aria-label` with
  its `label`, so what the control does goes on `aria-describedby`.

  Which is why the repeated word is `ink-gray-6` and not the cell's own
  `ink-gray-5`: gray-5 is #7C7C7C, 4.18:1 on white, and this text is 14px at
  weight 420, so it misses 1.4.3's 4.5:1. CRM sets gray-5 on the whole cell
  (`crm/.../ConditionsFilter/CFCondition.vue:18`) and can afford to — there the
  repeated cells are disabled Buttons with their own colour, and gray-5 only
  ever reaches the word "Where". Taking the exemption away is the point of
  rendering text, so the minimum has to be met once it is gone. gray-6 is
  #525252, 7.80:1. "Where" is left on the cell's colour: it is CRM's own
  rendering of it, unchanged by this component, and its own contrast is a wider
  question than this cell.
-->
<template>
	<div class="text-p-base text-ink-gray-5">
		<div v-if="index === 0">{{ labels.where }}</div>
		<template v-else>
			<Button
				v-if="canToggle"
				variant="subtle"
				class="w-max"
				iconRight="lucide-refresh-cw"
				:label="word"
				:aria-describedby="hintId"
				@click="context.setConjunction(groupPath, conjunction === 'and' ? 'or' : 'and')"
			/>
			<div v-else class="text-ink-gray-6">{{ word }}</div>
			<span v-if="canToggle" :id="hintId" class="sr-only">
				{{ labels.conjunctionHint }}
			</span>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, useId } from "vue";
import { Button } from "frappe-ui";
import { useConditionBuilderContext } from "./context";
import type { ConditionPath, Conjunction } from "./types";

const props = defineProps<{
	index: number;
	conjunction: Conjunction;
	groupPath: ConditionPath;

	/** Whether this cell's control is live. Decided by the group, not here. */
	canToggle?: boolean;
}>();

const context = useConditionBuilderContext();
const labels = context.labels;
const hintId = useId();

const word = computed(() => (props.conjunction === "and" ? labels.value.and : labels.value.or));
</script>
