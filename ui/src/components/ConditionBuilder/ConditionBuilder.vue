<!--
  ConditionBuilder — a controlled editor for a nested and/or condition tree. Its
  `v-model` is the tree; it owns no data resource and never calls an app endpoint
  (FP2). The built-in leaf's fields come from the doctype's Meta (FP3) or from an
  explicit `fields` array. It also owns the two singular things: the live region,
  mounted once and unconditionally, and focus.
-->
<template>
	<div ref="rootRef" data-slot="condition-builder" class="w-full">
		<!-- `aria-live` beside the role rather than instead of it: `role="status"`
		alone is not announced by every combination of browser and screen reader,
		and the two together are what NVDA and VoiceOver both read. Nothing in the
		builder hides this region any more — the nested-group dialog that used to,
		by way of `hideOthers`, is gone. -->
		<div role="status" aria-live="polite" aria-atomic="true" class="sr-only">
			{{ announcement }}
		</div>

		<!-- Above the branch below so it shows whether or not the tree has rows: a
		failed Meta request leaves every row naming a field the builder cannot find.
		Not a live region of its own — the message goes through `announce`, which
		re-announces a second failure that a static node mutating to the same string
		would not. -->
		<div
			v-if="fieldsError"
			data-slot="condition-fields-error"
			class="mb-4 flex items-center gap-2 rounded-md bg-surface-red-2 p-2 text-p-sm text-ink-red-6"
		>
			<span :id="fieldsErrorId" class="min-w-0 flex-1">{{ labels.fieldsError }}</span>
			<Button
				:label="labels.retryFields"
				:aria-labelledby="`${retryId} ${fieldsErrorId}`"
				@click="reloadFields"
			/>
			<span :id="retryId" class="sr-only">{{ labels.retryFields }}</span>
		</div>

		<button
			v-if="isEmpty && !readonly"
			type="button"
			data-slot="condition-empty"
			class="flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-outline-gray-2 p-4 text-p-sm text-ink-gray-5"
			@click="addCondition([])"
		>
			<slot name="empty">
				<span class="lucide-plus size-4" aria-hidden="true" />
				{{ labels.empty }}
			</slot>
		</button>

		<div
			v-else-if="isEmpty"
			data-slot="condition-empty"
			tabindex="-1"
			class="flex w-full items-center justify-center gap-2 rounded-md border border-outline-gray-2 p-4 text-p-sm text-ink-gray-5"
		>
			<slot name="empty">
				<span class="lucide-plus size-4" aria-hidden="true" />
				{{ labels.empty }}
			</slot>
		</div>

		<div
			v-else
			class="flex w-full flex-col gap-4"
			:class="bordered !== 'none' && 'rounded-lg border border-outline-gray-2 p-3'"
		>
			<ConditionGroup :group="tree" :path="[]">
				<template v-if="$slots.condition" #condition="slotProps">
					<slot name="condition" v-bind="asConditionSlotProps(slotProps)" />
				</template>
				<template v-if="$slots.group" #group="groupSlot">
					<slot name="group" v-bind="asGroupSlotProps(groupSlot)" />
				</template>
				<template v-if="$slots.value" #value="valueProps">
					<slot name="value" v-bind="valueProps" />
				</template>
				<template v-if="$slots.where" #where="whereSlot">
					<slot name="where" v-bind="whereSlot" />
				</template>
				<template v-if="$slots.conjunction" #conjunction="conjSlot">
					<slot name="conjunction" v-bind="conjSlot" />
				</template>
				<template v-if="$slots.actions" #actions="actionsSlot">
					<slot name="actions" v-bind="actionsSlot" />
				</template>
				<template v-if="$slots.addCondition" #addCondition="addSlot">
					<slot name="addCondition" v-bind="addSlot" />
				</template>
			</ConditionGroup>
		</div>
	</div>
</template>

<script setup lang="ts" generic="TLeaf = FieldConditionValue">
import { computed, nextTick, onBeforeUnmount, provide, ref, useId, watch } from "vue";
import { Button } from "frappe-ui";
import { useDoctypeMeta } from "../../composables/useDoctypeMeta";
import { getFilterableFields } from "../Filter/getFilterableFields";
import type { FilterField } from "../Filter/types";
import { toConditionExpression } from "./adapters";
import ConditionGroup from "./ConditionGroup.vue";
import {
	conditionBuilderKey,
	DEFAULT_BORDERS,
	DEFAULT_MAX_DEPTH,
	DEFAULT_REORDERABLE,
	mergeColumns,
	mergeLabels,
	uncachedLabels,
} from "./context";
import {
	addCondition as addConditionAt,
	addGroup as addGroupAt,
	canMoveInto,
	emptyTree,
	getNode,
	isGroup,
	moveNode,
	moveNodeToGroup,
	removeNode,
	samePath,
	setGroupConjunction,
	turnIntoGroup as turnIntoGroupAt,
	ungroup as ungroupAt,
	updateLeaf,
} from "./tree";
import type {
	ConditionBuilderProps,
	ConditionBuilderSlots,
	ConditionGroup as ConditionGroupType,
	ConditionPath,
	ConditionSlotProps,
	Conjunction,
	FieldConditionValue,
	GroupSlotProps,
} from "./types";

// Declared explicitly: the slots are forwarded down the tree rather than
// rendered here, so vue-component-meta cannot infer them for the docs table.
// Each is then forwarded by name below rather than through a `v-for` over
// `$slots`, because a dynamic slot name erases the payload's type at the
// boundary and re-renders the whole subtree on every parent update.
defineSlots<ConditionBuilderSlots<TLeaf>>();

// ConditionGroup is not generic over TLeaf — it types its own #condition slot as
// ConditionSlotProps<unknown> to break a self-recursive inference cycle — so
// re-forwarding that slot here needs an explicit cast back.
function asConditionSlotProps(slotProps: ConditionSlotProps<unknown>): ConditionSlotProps<TLeaf> {
	return slotProps as ConditionSlotProps<TLeaf>;
}

/** The same cast for `#group`, whose payload carries a group of the same leaf. */
function asGroupSlotProps(slotProps: GroupSlotProps<unknown>): GroupSlotProps<TLeaf> {
	return slotProps as GroupSlotProps<TLeaf>;
}

// The defaults live in `context.ts` beside the shape they belong to, so the
// prop and anything else reading one cannot drift apart.
const props = withDefaults(defineProps<ConditionBuilderProps<TLeaf>>(), {
	maxDepth: DEFAULT_MAX_DEPTH,
	bordered: DEFAULT_BORDERS,
	readonly: false,
	reorderable: DEFAULT_REORDERABLE,
});

const emit = defineEmits<{
	"update:modelValue": [value: ConditionGroupType<TLeaf>];
	"update:expression": [value: string];
}>();

const rootRef = ref<HTMLElement | null>(null);
const id = useId();
const fieldsErrorId = useId();
const retryId = useId();

// Controlled outright: the tree is the prop, and an edit is an emit the host
// writes back. Nothing is held here, so a host that drops the event renders a
// tree that does not move — which is the wiring bug, visible. `null` is the
// empty tree a nullable backend field arrives as.
const tree = computed<ConditionGroupType<TLeaf>>(() => props.modelValue ?? emptyTree<TLeaf>());

// Not a `computed`: with nothing reactive to depend on it would cache its first
// evaluation and freeze the labels in whatever language was current during the
// first render. A bare getter object is not a ref, so the template would not unwrap it.
const labels = uncachedLabels(() => mergeLabels(props.labels));
const columns = computed(() => mergeColumns(props.columns));
const isEmpty = computed(() => tree.value.conditions.length === 0);

// Meta is fetched only when the host asked for a doctype and did not supply the
// fields itself. Read once at setup: `useDoctypeMeta` starts a request, so a host
// that switches doctype remounts with `:key` rather than fetching each one.
const doctype = props.fields ? "" : props.doctype ?? "";
const meta = doctype ? useDoctypeMeta(doctype) : null;

const fields = computed<FilterField[]>(() => {
	if (props.fields) return props.fields;
	const loaded = meta?.meta.value;
	if (!loaded) return [];
	return getFilterableFields(loaded.fields ?? [], doctype);
});

const fieldsLoading = computed(() => Boolean(meta && meta.loading.value && !meta.meta.value));

// A failed request leaves `fields` empty with nothing loading, which every row
// reads as its field having been deleted. The alert says otherwise, and offers
// the way back.
const fieldsError = computed<unknown>(() => (meta ? meta.error.value : null));

function reloadFields() {
	meta?.reload();
}

/**
 * The Python expression the tree compiles to, emitted as `update:expression` so
 * a host can bind `v-model:expression` to the Code field that runs and never
 * call the compiler itself. It goes out on every edit and again when the
 * doctype's fields arrive, since a Check and a numeric field compile from their
 * fieldtype rather than from the value.
 *
 * A tree of leaves that are not field conditions — a host that replaced the row
 * through `#condition` — has no expression, and compiles to the empty string
 * rather than to something the server would choke on.
 */
const expression = computed(() =>
	toConditionExpression(tree.value as unknown as ConditionGroupType<FieldConditionValue>, {
		// An empty list is not "this doctype has no fields" — it is Meta in flight,
		// Meta failed, or a host that named neither `doctype` nor `fields`. Passed
		// as an array it would still answer every `fieldtype` question, with
		// `undefined`, so a Check would compile to `is_open == "Yes"` and a number
		// stay quoted. Withheld, the compiler's value-reading fallback runs, which
		// is the best available answer when the fieldtypes are not knowable.
		fields: fields.value.length ? fields.value : undefined,
		fieldPrefix: props.fieldPrefix,
	})
);

// Nothing goes out while the fields are in flight: an expression compiled without
// them is provisional, and a host bound to a Code field would persist it before
// the real one arrives. `fieldsLoading` is in the watch source rather than a bare
// guard so the emission still happens when it flips, even if the text is unchanged.
//
// A failed Meta request is withheld for the same reason and more of it: there,
// the fieldtypes are not late but absent, so what would go out is the guessing
// fallback — `is_open == "Yes"` against a 0/1 Check, numerics quoted — and it
// would overwrite a correct stored expression at the moment the screen is saying
// the fields could not be loaded. Withheld, the host keeps what it had, and the
// retry that fixes the screen emits the real one.
watch(
	[expression, fieldsLoading, fieldsError],
	([value, loading, error]) => {
		if (loading || error) return;
		emit("update:expression", value);
	},
	{ immediate: true }
);

const announcement = ref("");
let pending: string[] = [];

// Cleared first so the same message twice in a row is still a change. Messages
// raised in one tick are joined rather than overwriting each other: a removal
// that prunes a group announces from two places in the same flush.
function announce(message: string) {
	pending.push(message);
	announcement.value = "";
	nextTick(() => {
		if (pending.length === 0) return;
		announcement.value = pending.join(" ");
		pending = [];
	});
}

// Announced rather than rendered live, so a second failure after a retry is
// announced too.
watch(fieldsError, (error) => {
	if (error) announce(labels.value.fieldsError);
});

function newLeaf(): TLeaf {
	if (props.newCondition) return props.newCondition();
	return { fieldname: "", operator: "equals", value: "" } as TLeaf;
}

function commit(next: ConditionGroupType<TLeaf>) {
	emit("update:modelValue", next);
}

/** How many conditions the tree holds, at any depth. Groups are not counted. */
function countConditions(group: ConditionGroupType<TLeaf>): number {
	return group.conditions.reduce<number>(
		(total, node) => total + (isGroup(node) ? countConditions(node) : 1),
		0
	);
}

/**
 * How many groups the tree holds below the root, at any depth. Comparing the
 * count before and after tells whether a removal cascaded, where inspecting the
 * removed node's parent cannot — a sibling group can shift into the index the
 * pruned one occupied and read as if nothing was pruned.
 */
function countGroups(group: ConditionGroupType<TLeaf>): number {
	return group.conditions.reduce<number>(
		(total, node) => total + (isGroup(node) ? 1 + countGroups(node) : 0),
		0
	);
}

/**
 * Where focus should go after an edit: onto a row, or onto a group's add
 * affordance when the group it would have gone to is now empty.
 */
type FocusTarget =
	| { kind: "row"; path: ConditionPath }
	| { kind: "add"; groupPath: ConditionPath };

/**
 * Where focus goes after the node at `removed` is deleted: the row that slid
 * into its place, or the one before it for the last row. Without this the button
 * that ran the deletion goes with it and focus falls back to `<body>`. A group
 * pruned along with it asks the same question one level up.
 */
function focusAfterRemove(root: ConditionGroupType<TLeaf>, removed: ConditionPath): FocusTarget {
	let path = removed;

	while (path.length > 0) {
		const groupPath = path.slice(0, -1);
		const node = getNode(root, groupPath);

		if (node !== undefined && isGroup(node)) {
			const count = node.conditions.length;
			if (count === 0) return { kind: "add", groupPath };
			const index = Math.min(path[path.length - 1], count - 1);
			return { kind: "row", path: [...groupPath, index] };
		}

		// That group was pruned too — ask the same question about its own row.
		path = groupPath;
	}

	return { kind: "add", groupPath: [] };
}

/** The row just appended to `groupPath`, so the next thing typed goes into it. */
function focusAfterAdd(root: ConditionGroupType<TLeaf>, groupPath: ConditionPath): FocusTarget {
	const node = getNode(root, groupPath);
	if (node === undefined || !isGroup(node) || node.conditions.length === 0) {
		return { kind: "add", groupPath };
	}
	return { kind: "row", path: [...groupPath, node.conditions.length - 1] };
}

/**
 * The condition inside a freshly added group, rather than the group's own row —
 * whose first focusable is the and/or toggle, so typing would flip a conjunction
 * instead of naming a field.
 */
function focusAfterAddGroup(
	root: ConditionGroupType<TLeaf>,
	groupPath: ConditionPath
): FocusTarget {
	const target = focusAfterAdd(root, groupPath);
	if (target.kind !== "row") return target;
	const added = getNode(root, target.path);
	if (added === undefined || !isGroup(added) || added.conditions.length === 0) return target;
	return { kind: "row", path: [...target.path, 0] };
}

/**
 * Move focus onto the element the edit left behind, once it has rendered. Rows
 * are addressed by path rather than held as refs: after a cascade the target is
 * a row the group the edit started in never rendered.
 */
function moveFocus(target: FocusTarget, after: "add" | "remove") {
	nextTick(() => {
		const scope = `[data-condition-builder="${id}"]`;

		if (target.kind === "row") {
			const preferred = after === "remove" ? ROW_ACTIONS : ROW_ENTRY;
			const row = document.querySelector<HTMLElement>(
				`${scope}[data-condition-path="${target.path.join(".")}"]`
			);
			const element = ownElement(row, preferred) ?? ownElement(row, FOCUSABLE);
			element?.focus();
			return;
		}

		// Not path-scoped: the add cell sits outside any row, and it holds only its
		// own button — a nested group's add cell lives inside the <ul>, not here.
		const add = firstEnabled(
			document.querySelector<HTMLElement>(
				`${scope}[data-add-group="${target.groupPath.join(".")}"]`
			),
			"button"
		);
		// Nothing is left to add into: the builder is showing its empty state, whose
		// read-only branch carries tabindex="-1" so it can take the focus without
		// being a button.
		const empty = rootRef.value?.querySelector<HTMLElement>('[data-slot="condition-empty"]');
		(add ?? empty)?.focus();
	});
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Where the user was standing when a row was removed. */
const ROW_ACTIONS = '[data-slot="condition-actions"] button';

/** Where the user is going when a row is added. */
const ROW_ENTRY = '[data-slot="condition-field"] button, [data-slot="condition-field"] input';

/**
 * The first match inside `row` that belongs to `row` itself. A row holding a
 * nested group contains that whole subtree and renders it before its own actions
 * cell, so a plain `querySelector` would land a level deeper than the highlight
 * suggests. Disabled elements are skipped: `focus()` on one is a no-op.
 */
function ownElement(row: HTMLElement | null, selector: string): HTMLElement | null {
	if (!row) return null;
	for (const element of row.querySelectorAll<HTMLElement>(selector)) {
		if (element.closest("[data-condition-path]") !== row) continue;
		if (element.hasAttribute("disabled")) continue;
		return element;
	}
	return null;
}

/** The first match that can actually take focus. */
function firstEnabled(root: HTMLElement | null, selector: string): HTMLElement | null {
	if (!root) return null;
	for (const element of root.querySelectorAll<HTMLElement>(selector)) {
		if (!element.hasAttribute("disabled")) return element;
	}
	return null;
}

/**
 * How long to wait for a closing menu to return focus to its trigger before
 * giving up and placing focus anyway. Only reached when nothing takes focus at
 * all — the wait normally ends on the menu's own restore, whenever that lands.
 */
const MENU_RESTORE_TIMEOUT = 300;

/** Cancels the wait started by `focusAfterMenuCloses`, if one is in flight. */
let cancelMenuFocus: (() => void) | null = null;

/**
 * Focus the row at `path`, after the closing menu has finished returning focus
 * to its trigger. The restore lands a frame or more later — after the menu's
 * exit — so this waits for it rather than for a guessed number of frames, and
 * then places focus where the edit left the row.
 */
function focusAfterMenuCloses(path: ConditionPath) {
	// Only ever one in flight: a second menu action supersedes the first, and its
	// wait would otherwise place focus on top of this one's.
	cancelMenuFocus?.();

	let timer: ReturnType<typeof setTimeout>;

	function stop() {
		document.removeEventListener("focusin", onFocusIn);
		clearTimeout(timer);
		cancelMenuFocus = null;
	}

	function place() {
		stop();
		moveFocus({ kind: "row", path }, "remove");
	}

	// The menu returns focus to its own trigger, which is one of this builder's
	// rows. A focusin anywhere else is the user going somewhere deliberately, and
	// taking focus back off them would be a worse bug than not placing it at all.
	// Matched by builder id rather than by containment, so a second builder on the
	// page cannot answer for this one's rows.
	function onFocusIn(event: FocusEvent) {
		const target = event.target;
		if (!(target instanceof Element)) return;
		if (target.closest(`[data-condition-builder="${id}"]`)) place();
		else stop();
	}

	timer = setTimeout(place, MENU_RESTORE_TIMEOUT);
	document.addEventListener("focusin", onFocusIn);
	cancelMenuFocus = stop;
}

// The wait outlives a single tick, so an unmount inside it would otherwise leave a
// document listener that focuses a row of a builder that is gone.
onBeforeUnmount(() => cancelMenuFocus?.());

/** Append a condition to the group at `path` and put focus in it. */
function addCondition(path: ConditionPath) {
	const next = addConditionAt(tree.value, path, newLeaf());
	commit(next);
	moveFocus(focusAfterAdd(next, path), "add");
}

provide(conditionBuilderKey, {
	builderId: computed(() => id),
	fields,
	fieldsLoading,
	fieldsError,
	reloadFields,
	columns,
	labels,
	bordered: computed(() => props.bordered),
	maxDepth: computed(() => props.maxDepth),
	readonly: computed(() => props.readonly),
	reorderable: computed(() => props.reorderable),

	addCondition,
	addGroup: (path: ConditionPath) => {
		const next = addGroupAt(tree.value, path, newLeaf());
		commit(next);
		moveFocus(focusAfterAddGroup(next, path), "add");
	},
	remove: (path: ConditionPath) => {
		const removed = getNode(tree.value, path);
		const groupsBefore = countGroups(tree.value);
		const next = removeNode(tree.value, path);
		commit(next);
		// Focus movement explains the row going. It cannot explain the group going
		// with it — and only a removed *condition* counts, since removing a group is
		// meant to take one.
		const cascaded =
			removed !== undefined && !isGroup(removed) && countGroups(next) < groupsBefore;
		announce(labels.value.removed(countConditions(next), cascaded));
		moveFocus(focusAfterRemove(next, path), "remove");
	},
	update: (path: ConditionPath, leaf: unknown) =>
		commit(updateLeaf(tree.value, path, leaf as TLeaf)),
	turnIntoGroup: (path: ConditionPath) => commit(turnIntoGroupAt(tree.value, path)),
	// The group's own row goes, and with it the menu that ran this — so focus is
	// placed the same way a removal places it: on the row that took its place,
	// which here is the first child spliced into the gap.
	ungroup: (path: ConditionPath) => {
		const next = ungroupAt(tree.value, path);
		commit(next);
		moveFocus(focusAfterRemove(next, path), "remove");
	},
	// The whole group, from its one live cell. There is nothing narrower to
	// write: a group holds one operator.
	setConjunction: (path: ConditionPath, value: Conjunction) =>
		commit(setGroupConjunction(tree.value, path, value)),
	// A reorder keeps every path in the tree valid: only the two rows that
	// swapped change what they address, so nothing below has to be re-pointed.
	move: (
		path: ConditionPath,
		from: number,
		to: number,
		options?: { name?: string; focus?: boolean }
	) => {
		const group = getNode(tree.value, path);
		if (group === undefined || !isGroup(group)) return;
		const total = group.conditions.length;
		if (from === to || from < 0 || to < 0 || from >= total || to >= total) return;

		commit(moveNode(tree.value, path, from, to));
		announce(labels.value.moved(options?.name ?? "", from + 1, to + 1, total));
		// Onto the row's own menu, now at the new position, so a second Move Up moves
		// the same row again. It has to outlast the menu it was run from: that menu
		// returns focus to its own trigger as it closes, and rows are keyed by index,
		// so the trigger it returns to is the row this one displaced.
		if (options?.focus !== false) focusAfterMenuCloses([...path, to]);
	},
	canDrop: (from: ConditionPath, toGroupPath: ConditionPath) =>
		canMoveInto(tree.value, from, toGroupPath, props.maxDepth),
	// A drop, from the one component that saw the whole of it. The counts are
	// read before the edit, since the move re-points the paths it would take to
	// read them after: an emptied source group is pruned, and everything after it
	// shifts up.
	moveInto: (
		from: ConditionPath,
		toGroupPath: ConditionPath,
		toIndex: number,
		options?: { name?: string }
	) => {
		if (!canMoveInto(tree.value, from, toGroupPath, props.maxDepth)) return;

		const target = getNode(tree.value, toGroupPath);
		if (target === undefined || !isGroup(target)) return;

		const sameGroup = samePath(from.slice(0, -1), toGroupPath);
		const total = target.conditions.length + (sameGroup ? 0 : 1);
		const name = options?.name ?? "";

		commit(moveNodeToGroup(tree.value, from, toGroupPath, toIndex, props.maxDepth));

		// A reorder says where it came from; a reparent cannot, because the
		// position it left is in a group the row is no longer in and naming it
		// would read as a position in the one it landed in.
		announce(
			sameGroup
				? labels.value.moved(name, from[from.length - 1] + 1, toIndex + 1, total)
				: labels.value.movedToGroup(name, toIndex + 1, total)
		);
		// No focus is placed: the pointer took none, and a focus ring left where a
		// drop happened lands somewhere the user never typed.
	},
	announce,
});
</script>
