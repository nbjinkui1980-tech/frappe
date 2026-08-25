<!--
  One group of conditions, rendering its children and itself again for a nested
  group. The root is a `<fieldset>` with a hidden `<legend>`; nested groups use
  `role="group"`, announced on entry rather than before every control inside.
  `role="list"` stays explicit: WebKit drops list semantics under
  `list-style: none`, taking the item count with it.
-->
<template>
	<component
		:is="rootTag"
		data-slot="condition-group"
		:data-depth="path.length"
		:role="rootTag === 'fieldset' ? undefined : 'group'"
		:aria-label="rootTag === 'fieldset' ? undefined : groupName"
		class="flex w-full min-w-0 flex-col gap-4"
		:class="hasCard && 'rounded-lg border border-outline-gray-2 bg-surface-white p-3'"
	>
		<legend v-if="rootTag === 'fieldset'" class="sr-only">
			{{ groupName }}
		</legend>

		<!-- Each row carries its own grid rather than sharing one with its siblings.
		A shared grid sizes each track from the widest cell in the group, so every
		field control is as wide as the longest label; per row, each control is the
		width of what it holds and the row reads as a phrase. What the rows still
		share is their end edge: the last track takes the leftover and pins the
		actions to the end of it, so they line up down the group whatever the cells
		before them hold. -->
		<Draggable
			v-if="group.conditions.length"
			:model-value="group.conditions"
			:item-key="keyOf"
			:disabled="!canReorder"
			:group="sortableGroup"
			handle=".condition-drag-handle"
			tag="ul"
			role="list"
			:data-group-path="path.join('.')"
			:data-condition-builder="context.builderId.value"
			class="flex w-full min-w-0 list-none flex-col gap-4"
			@end="onDragEnd"
		>
			<template #item="{ element: condition, index }">
				<li
					class="grid min-w-0 items-start gap-x-2"
					:style="{ gridTemplateColumns: trackListFor(condition) }"
					:data-condition-path="[...path, index].join('.')"
					:data-condition-builder="context.builderId.value"
				>
					<!-- The row owns the leading cell, not what goes in it: the band
					below is one control tall and centres its content, so the operator
					lines up with the controls beside it whether it is the built-in cell
					or a `#where` / `#conjunction` of the host's own — a bare word is
					half the height of a control and would otherwise sit above it. The
					band grows if what the host puts in it is taller.

					The bracket is drawn here too, for the same reason: it spans the
					row, which the cell inside it does not, and it is the group's mark
					rather than the cell's — replacing the cell should not erase it. -->
					<ConditionRule
						:index="index"
						:count="group.conditions.length"
						:offset="firstLineOffset(condition)"
					>
						<div
							class="flex min-h-7 items-center justify-center"
							:style="firstLineStyle(condition)"
						>
							<slot v-if="index === 0" name="where" v-bind="whereProps()">
								<ConjunctionCell v-bind="cellProps(index)" />
							</slot>
							<slot v-else name="conjunction" v-bind="conjunctionProps(index)">
								<ConjunctionCell v-bind="cellProps(index)" />
							</slot>
						</div>
					</ConditionRule>

					<!-- Pointer-only, and hidden from assistive tech: it duplicates no
					control, so there is nothing for it to name. A host that needs a
					keyboard path to the same edit builds one in `#actions`, which is
					handed `moveUp` / `moveDown` and their guards. -->
					<div
						v-if="canReorder"
						class="condition-drag-handle flex h-7 w-4 cursor-grab items-center justify-center"
						:style="firstLineStyle(condition)"
						aria-hidden="true"
					>
						<span class="lucide-grip-vertical size-4 text-ink-gray-4" />
					</div>

					<!-- A card gets a row of its own shape — one stretching track between
					the conjunction and the actions — so it runs to the end of the row
					rather than to wherever three content-sized cells happen to stop.

					`#group` wraps what goes in that cell, and is handed the default
					rendering as a component so a host can put the real group somewhere
					else — a dialog body, most of all. The fallback below renders that
					same component, so the slot wraps the component's own rendering
					rather than a second copy of it that could drift. The row around it
					is not the slot's: the operator, the handle and the menu are the
					group's place in its parent, and a host replacing them has `#where`,
					`#conjunction` and `#actions`. -->
					<template v-if="isGroup(condition)">
						<div class="min-w-0">
							<slot name="group" v-bind="groupSlotProps(condition, index)">
								<component :is="groupRenderer(index)" />
							</slot>
						</div>
					</template>

					<ConditionRow
						v-else
						:condition="condition"
						:path="[...path, index]"
						:field-label-id="rowFieldId(index)"
					>
						<template v-if="$slots.condition" #condition="slotProps">
							<slot name="condition" v-bind="slotProps" />
						</template>
						<template v-if="$slots.value" #value="valueProps">
							<slot name="value" v-bind="valueProps" />
						</template>
					</ConditionRow>

					<!-- The same first-line band as the leading cell, for the same
					reason: a host's `#actions` is level with the controls rather than
					with the top of a row that has grown. -->
					<div
						class="flex min-h-7 items-center justify-end justify-self-end"
						:style="firstLineStyle(condition)"
					>
						<slot name="actions" v-bind="actionsProps(index, isGroup(condition))">
							<ConditionActions
								:path="[...path, index]"
								:is-group="isGroup(condition)"
								:field-label-id="rowFieldId(index)"
							/>
						</slot>
					</div>

					<span :id="rowFieldId(index)" class="sr-only">
						{{ leafFieldLabel(condition, context.fields.value) }}
					</span>
				</li>
			</template>
		</Draggable>

		<div
			v-if="!context.readonly.value"
			class="flex"
			:data-add-group="path.join('.')"
			:data-condition-builder="context.builderId.value"
		>
			<slot name="addCondition" v-bind="addConditionProps()">
				<AddConditionButton :path="path" :can-add-group="canAddGroup" />
			</slot>
		</div>
	</component>
</template>

<script setup lang="ts">
import { computed, defineComponent, getCurrentInstance, h, useId, useSlots } from "vue";
import type { Component, Slot } from "vue";
// @ts-ignore — vuedraggable ships no bundled types
import Draggable from "vuedraggable";
import type { FilterField } from "../Filter/types";
import AddConditionButton from "./AddConditionButton.vue";
import ConditionActions from "./ConditionActions.vue";
import ConditionRow from "./ConditionRow.vue";
import ConditionRule from "./ConditionRule.vue";
import ConjunctionCell from "./ConjunctionCell.vue";
import { useConditionBuilderContext } from "./context";
import { canNest, isGroup, samePath } from "./tree";
import type {
	ActionsSlotProps,
	AddConditionSlotProps,
	ConditionGroup as ConditionGroupType,
	ConditionPath,
	ConditionSlotProps,
	ConjunctionSlotProps,
	Conjunction,
	FieldConditionValue,
	GroupSlotProps,
	ValueSlotProps,
	WhereSlotProps,
} from "./types";

defineOptions({ name: "ConditionGroup" });

const props = defineProps<{
	group: ConditionGroupType<unknown>;
	path: ConditionPath;
}>();

// Explicit slot types break the inference cycle self-recursion creates: the
// template passes this component's own slots back into itself.
interface GroupSlots {
	condition?(props: ConditionSlotProps<unknown>): any;
	group?(props: GroupSlotProps<unknown>): any;
	value?(props: ValueSlotProps): any;
	where?(props: WhereSlotProps): any;
	conjunction?(props: ConjunctionSlotProps): any;
	actions?(props: ActionsSlotProps): any;
	addCondition?(props: AddConditionSlotProps): any;
}

defineSlots<GroupSlots>();

const context = useConditionBuilderContext();
const slots = useSlots();
const rowIdPrefix = useId();

const canAddGroup = computed(() => canNest(props.path, context.maxDepth.value));

/** Whether this group's rows can be dragged. A read-only tree cannot be edited at all. */
const canReorder = computed(() => context.reorderable.value && !context.readonly.value);

/**
 * A row's key: its index, which is what keeps a row's DOM — and the focus inside
 * it — in place across the commits an edit makes. Keying by the node's identity
 * would remount every row on every keystroke, since each edit clones the tree.
 * `indexOf` is by reference, and a group holds few enough rows for the scan.
 */
function keyOf(node: unknown): number {
	return props.group.conditions.indexOf(node);
}

/**
 * The Sortable group every list in this builder shares, which is what lets a row
 * be dragged into a sibling group, into a nested one, or back out to an
 * ancestor. Named after the builder, so two builders on one page are two
 * Sortable groups and cannot exchange rows.
 */
const sortableGroup = computed(() => ({
	name: `condition-builder-${context.builderId.value}`,

	// Asked of the group being dropped INTO, so `props.path` here is the
	// destination. Refusing during the drag rather than after it means a drop
	// past `maxDepth` shows no drop indicator at all, instead of landing and
	// being snapped back by a commit that declines it.
	put: (_to: unknown, _from: unknown, dragged: HTMLElement) => {
		const from = parsePath(dragged.getAttribute("data-condition-path"));
		return from !== null && context.canDrop(from, props.path);
	},
}));

/** A path as it is written on a row or a list. `""` is the root group. */
function parsePath(value: string | null): ConditionPath | null {
	if (value === null) return null;
	if (value === "") return [];
	const path = value.split(".").map(Number);
	return path.every(Number.isInteger) ? path : null;
}

interface DragEndEvent {
	from: HTMLElement;
	to: HTMLElement;
	oldIndex?: number;
	newIndex?: number;
}

/**
 * A drop, applied exactly once.
 *
 * `end` and not `change`: a cross-group drop raises `change` twice — `removed`
 * on the source list and `added` on the target — on two different components,
 * each holding the tree as it was before the drag. Applying both commits the
 * second edit on top of a tree that never had the first, so the row is either
 * duplicated or lost depending on which lands last. `end` fires once, on the
 * list the drag started in, and carries both lists and both indices, so one
 * component has the whole move and commits it as one edit.
 *
 * It also fires last, after vuedraggable has put the dragged node back where it
 * started in the DOM, so the commit below is what actually moves it.
 */
function onDragEnd(event: DragEndEvent) {
	const from = parsePath(event.from.getAttribute("data-group-path"));
	const to = parsePath(event.to.getAttribute("data-group-path"));
	const { oldIndex, newIndex } = event;

	if (from === null || to === null) return;
	if (oldIndex === undefined || newIndex === undefined) return;
	if (samePath(from, to) && oldIndex === newIndex) return;

	// `end` fires on the source list, so this group holds the row that moved —
	// but the name is only for the announcement, so a surprise is a missing word
	// rather than a dropped edit.
	const moved = samePath(from, props.path) ? props.group.conditions[oldIndex] : undefined;

	context.moveInto([...from, oldIndex], to, newIndex, {
		name: leafFieldLabel(moved, context.fields.value),
	});
}

// Only nested groups draw their own card; the root's border is the builder's.
// `bordered: 'root'` drops these, so depth reads from indentation alone.
const isNested = computed(() => props.path.length > 0);
const hasCard = computed(() => isNested.value && context.bordered.value === "all");

// A `<fieldset>` groups form controls, so a read-only tree — which has none —
// uses the same `role="group"` as the nested levels.
const rootTag = computed(() => (!isNested.value && !context.readonly.value ? "fieldset" : "div"));

/** The group's operator, which every row after the first shows. */
const conjunction = computed<Conjunction>(() => props.group.conjunction ?? "and");

// A group is described by its conjunction, which is otherwise conveyed only by a
// button between rows — reached after the first condition, not before it. One
// operator per group means these two names are the whole vocabulary: there is no
// level left that is neither.
const groupName = computed(() =>
	conjunction.value === "or" ? context.labels.value.matchAny : context.labels.value.matchAll
);

/**
 * Whether row `index`'s cell is live. Exactly one is: row 1, the first gap in
 * the group. The group holds one operator, so the words below row 1 are repeats
 * of a control that has already been offered, and a second button for the same
 * value would let two cells in one group disagree on screen for a frame and read
 * as per-gap editing to anyone who found the lower one first.
 *
 * The locked rows render as text rather than as disabled buttons, which is the
 * same rule `readonly` follows: a disabled control is skipped in a screen
 * reader's forms mode and is exempt from the contrast minimum, so a group of
 * eight would be read as one operator and seven blanks. CRM, Helpdesk and LMS
 * each write this policy by hand today through `#conjunction`; it is the
 * component's now, and the slot is left for restyling rather than for getting
 * uniform behaviour.
 */
function canToggleAt(index: number): boolean {
	return index === 1 && !context.readonly.value;
}

/** The leading conjunction cell, wide enough for `Where` at any of its lengths. */
const CONJUNCTION_TRACK = "minmax(66px, max-content)";

/**
 * The trailing actions' track. It takes the row's leftover width rather than the
 * width of the buttons, and they sit at its end — so Remove lands on the
 * container's end edge in every row, with the slack the content-sized cells
 * before it did not use collecting harmlessly in between. `max-content` as the
 * floor keeps the buttons from being squeezed when a row has no slack to give.
 */
const ACTIONS_TRACK = "minmax(max-content, 1fr)";

/**
 * The handle's own track, and only where there is a handle: an empty one would
 * indent every row of a tree that cannot be rearranged. It sits after the
 * conjunction so the three content tracks stay the three a group's row spans.
 */
const handleTrack = computed(() => (canReorder.value ? ["max-content"] : []));

const trackList = computed(() =>
	[
		CONJUNCTION_TRACK,
		...handleTrack.value,
		context.columns.value.field,
		context.columns.value.operator,
		context.columns.value.value,
		ACTIONS_TRACK,
	].join(" ")
);

/**
 * A card's row, whose middle is one stretching track rather than three sized to
 * their contents: a group has no field, operator or value of its own, and a card
 * that stopped where three content-sized cells stopped would leave its end edge
 * somewhere arbitrary instead of against the actions beside it.
 */
const groupTrackList = computed(() =>
	[CONJUNCTION_TRACK, ...handleTrack.value, "minmax(0, 1fr)", "max-content"].join(" ")
);

function trackListFor(node: unknown): string {
	return isGroup(node) ? groupTrackList.value : trackList.value;
}

/**
 * The card's own chrome above the first line inside it: its `border` and its
 * `p-3`. Both are written here, on the group element, so they move together.
 */
const CARD_FIRST_LINE = 13;

/**
 * How far into a row its first line starts. Zero for a leaf, whose controls
 * begin at the row's top edge — but a nested card's first rule begins inside the
 * card's border and padding, and the operator joining that card to the rules
 * above belongs beside that rule rather than beside the card's top edge, which is
 * a corner with nothing on it.
 *
 * A card is the only thing this component puts in a row that displaces its own
 * first line. A `#condition` that does the same — labels above its controls, a
 * leading margin — is the host's to place with `#where` / `#conjunction`, since
 * nothing here can measure it.
 */
function firstLineOffset(node: unknown): number {
	const drawsCard = isGroup(node) && context.bordered.value === "all";
	return drawsCard ? CARD_FIRST_LINE : 0;
}

/** The offset as it is applied to the row's cells: the bracket takes the number. */
function firstLineStyle(node: unknown): { marginTop: string } | undefined {
	const offset = firstLineOffset(node);
	return offset ? { marginTop: `${offset}px` } : undefined;
}

/** Id of the span holding a row's field label, which names its controls. */
function rowFieldId(index: number): string {
	return `${rowIdPrefix}-${index}`;
}

/**
 * The field a leaf names, as text. Every control in a row is named after it, so
 * eight operator selects are told apart by more than the word "operator". A
 * fieldname with no Meta behind it shows as itself, since removing the row is the
 * only way to fix it; duck-typing on `fieldname` labels a custom leaf shape too.
 */
function leafFieldLabel(node: unknown, fields: FilterField[]): string {
	if (node === null || typeof node !== "object") return "";
	const fieldname = (node as Partial<FieldConditionValue>).fieldname;
	if (typeof fieldname !== "string" || fieldname === "") return "";
	return fields.find((f) => f.fieldname === fieldname)?.label ?? fieldname;
}

/** What the built-in cell needs, whichever of the two slots falls back to it. */
function cellProps(index: number) {
	return {
		index,
		conjunction: conjunction.value,
		canToggle: canToggleAt(index),
		groupPath: props.path,
	};
}

function whereProps(): WhereSlotProps {
	return { groupPath: props.path, conjunction: conjunction.value };
}

function conjunctionProps(index: number): ConjunctionSlotProps {
	return {
		conjunction: conjunction.value,
		index,
		groupPath: props.path,
		toggle: () =>
			context.setConjunction(props.path, conjunction.value === "and" ? "or" : "and"),
		canToggle: canToggleAt(index),
	};
}

function actionsProps(index: number, group: boolean): ActionsSlotProps {
	const path = [...props.path, index];
	const last = props.group.conditions.length - 1;
	return {
		path,
		isGroup: group,
		readonly: context.readonly.value,
		canGroup: !group && canNest(props.path, context.maxDepth.value),
		canMoveUp: canReorder.value && index > 0,
		canMoveDown: canReorder.value && index < last,
		moveUp: () => moveRow(index, index - 1),
		moveDown: () => moveRow(index, index + 1),
		turnIntoGroup: () => context.turnIntoGroup(path),
		ungroup: () => context.ungroup(path),
		remove: () => context.remove(path),
	};
}

/** A move run from a row's menu, which keeps its focus on the way. */
function moveRow(from: number, to: number) {
	context.move(props.path, from, to, {
		name: leafFieldLabel(props.group.conditions[from], context.fields.value),
	});
}

function addConditionProps(): AddConditionSlotProps {
	return {
		groupPath: props.path,
		addCondition: () => context.addCondition(props.path),
		addGroup: () => context.addGroup(props.path),
		canAddGroup: canAddGroup.value,
	};
}

// `v-if="isGroup(...)"` does not narrow the union for vue-tsc, hence the cast.
function asGroup(node: unknown) {
	return node as ConditionGroupType<unknown>;
}

/**
 * The slots a nested group is handed. `group` is in the list: a host that wraps
 * one level expects the same treatment at every level below it, and a slot that
 * stopped one level down would wrap the outermost nested group only.
 */
const FORWARDED_SLOTS = [
	"condition",
	"value",
	"where",
	"conjunction",
	"actions",
	"addCondition",
	"group",
] as const;

/**
 * This component, for rendering itself. `getCurrentInstance().type` rather than
 * an import of this file: the template's self-reference is not in scope here,
 * and importing the SFC into itself is a cycle that only happens to work.
 */
const self = getCurrentInstance()?.type as Component;

/**
 * The default rendering of the nested group in row `index`, as a component the
 * `#group` slot hands to the host — `<component :is="Group" />` puts the real
 * recursive group wherever the host renders it, dialog body included, since
 * Vue resolves `inject` and slots up the component tree rather than the DOM.
 *
 * A component rather than a vnode. A vnode is created during one render and
 * bound to it: a host holding on to one, or rendering it in a branch that
 * mounts later, is re-mounting a node that has already been patched. A
 * component is a description, and `<component :is>` instantiates it fresh each
 * time it is rendered.
 *
 * Cached per row index, because `<component :is>` remounts on a change of
 * identity: a renderer built during render would tear the subtree down and
 * rebuild it on every keystroke, taking the focus inside it and any drag in
 * flight with it. Rows are keyed by index for the same reason, so an index is
 * what stays put across an edit. The cache holds one closure per row a group
 * has ever had; entries for rows since removed are never rendered again.
 */
const renderers = new Map<number, Component>();

function groupRenderer(index: number): Component {
	const cached = renderers.get(index);
	if (cached) return cached;

	const renderer = defineComponent({
		name: "ConditionGroupDefault",
		// The node is read from the tree at render time rather than captured, so
		// the component is the same object after an edit replaced the node.
		setup: () => () => renderNestedGroup(index),
	});

	renderers.set(index, renderer);
	return renderer;
}

/** The nested group in row `index`, with this group's slots passed down it. */
function renderNestedGroup(index: number) {
	const node = props.group.conditions[index];
	if (!isGroup(node)) return null;

	const forwarded: Record<string, Slot> = {};
	for (const name of FORWARDED_SLOTS) {
		const slot = slots[name];
		if (slot) forwarded[name] = slot;
	}

	return h(self, { group: asGroup(node), path: [...props.path, index] }, forwarded);
}

function groupSlotProps(node: unknown, index: number): GroupSlotProps<unknown> {
	return {
		group: asGroup(node),
		path: [...props.path, index],
		// The root is depth 0 and never reaches this slot, so a group here is 1 or
		// more — the number of cards a reader has to be inside to see it.
		depth: props.path.length + 1,
		readonly: context.readonly.value,
		Group: groupRenderer(index),
	};
}
</script>
