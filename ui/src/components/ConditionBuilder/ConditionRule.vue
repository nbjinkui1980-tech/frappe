<!--
  The group's bracket, as it passes one row: a rule down the leading cells, with
  the operator sitting on it. The cell itself is the default slot, so the bracket
  and the word it parts around are laid out together.

  Drawn as two lengths rather than one, so it stops short of the word instead of
  running behind it — a chip could paint over a rule it covered, a bare word
  cannot, and neither can know what surface it is on. It is measured from the
  row's first line, not from the middle of the row: a condition is free to grow
  downward, and the length below simply runs further when it does.

  The lower length is a flex item after the cell rather than a span positioned a
  control's height down, so it starts wherever the cell actually ends. A host is
  free to put something two lines tall in `#conjunction` — the band grows for it,
  and a hard-coded first line would have left the rule running behind the word,
  which is the one thing drawing it in two pieces exists to prevent.
-->
<template>
	<div class="relative flex min-w-[66px] flex-col self-stretch">
		<span
			v-if="count > 1 && index > 0"
			aria-hidden="true"
			class="absolute start-1/2 border-s border-outline-gray-2"
			:style="above"
		/>
		<slot />
		<span
			v-if="count > 1 && index < count - 1"
			aria-hidden="true"
			class="w-0 flex-1 self-center border-s border-outline-gray-2"
			:style="below"
		/>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
	defineProps<{
		/** This row's index within its group. */
		index: number;

		/** How many rows the group holds. A group of one joins nothing. */
		count: number;

		/**
		 * How far below the row's top edge its first line starts, in pixels. The row
		 * decides it — a card's first line sits inside the card's own chrome — and
		 * the length above moves with the word rather than staying on the row's edge.
		 */
		offset?: number;
	}>(),
	{ offset: 0 }
);

/** Half of the group's `gap-y-4`, which each end reaches into to meet the next. */
const HALF_GAP = 8;

// The length above bridges the row gap and then runs down to the word wherever
// the offset has put it, so an offset row is still joined to the one before it
// rather than left with a gap the width of the card's padding.
const above = computed(() => ({
	top: `-${HALF_GAP}px`,
	height: `${HALF_GAP + props.offset}px`,
}));

// Takes the rest of the column and reaches into the gap below to meet the next
// row's upper length.
const below = { marginBottom: `-${HALF_GAP}px` };
</script>
