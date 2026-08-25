<!--
  The built-in leaf editor: field picker, operator select, value control. Every
  rule it applies comes from the `Filter` modules rather than a second copy
  here (FP1).

  Controls are named by reference with `aria-labelledby`, the one attribute that
  survives every atom: the field's own text plus a hidden word for the cell. The
  controls that drop attrs get a named `role="group"` wrapper instead.

  Read-only rows render as text, not disabled controls: a disabled control is
  exempt from the contrast minimum and cannot be selected or copied.
-->
<template>
	<div
		data-slot="condition-leaf"
		class="grid items-center gap-2"
		style="grid-template-columns: subgrid; grid-column: span 3"
	>
		<div data-slot="condition-field" class="min-w-0">
			<span v-if="isReadonly" class="truncate text-p-base text-ink-gray-8">
				{{ fieldText }}
			</span>
			<TextInput
				v-else-if="isFieldsUnavailable"
				class="w-full"
				readonly
				:modelValue="fieldText"
				:aria-labelledby="`${fieldTextId} ${fieldWordId}`"
			/>
			<Combobox
				v-else
				class="w-full"
				trigger="button"
				variant="subtle"
				:options="fieldOptions"
				:modelValue="condition.fieldname"
				:placeholder="labels.field"
				@update:selectedOption="onFieldChange"
			>
				<template #trigger="{ open }">
					<Button
						class="w-max max-w-full"
						variant="subtle"
						:label="fieldText || labels.field"
						:iconRight="open ? 'lucide-chevron-up' : 'lucide-chevron-down'"
						:aria-labelledby="`${fieldTextId} ${fieldWordId}`"
						:aria-expanded="open"
						aria-haspopup="listbox"
					/>
				</template>
			</Combobox>
		</div>

		<div data-slot="condition-operator" class="min-w-0">
			<span v-if="isReadonly" class="truncate text-p-base text-ink-gray-8">
				{{ operatorText }}
			</span>
			<TextInput
				v-else-if="!isEditable"
				class="w-full"
				readonly
				:modelValue="operatorText"
				:aria-labelledby="operatorNameIds"
			/>
			<Select
				v-else
				class="w-full"
				:options="operators"
				:modelValue="condition.operator"
				:placeholder="labels.operator"
				:aria-labelledby="operatorNameIds"
				@update:modelValue="onOperatorChange"
			/>
		</div>

		<div
			data-slot="condition-value"
			class="min-w-0"
			:role="valueNeedsGroup ? 'group' : undefined"
			:aria-labelledby="valueNeedsGroup ? valueNameIds : undefined"
		>
			<!-- The slot wraps all three states rather than sitting in the editable
			one: a host that replaces the value cell owns how its own value reads when
			it cannot be edited, and `readonly` is what tells it which that is. -->
			<slot
				name="value"
				:field="field"
				:operator="condition.operator"
				:modelValue="condition.value"
				:readonly="!isEditable"
				:update="onValueChange"
			>
				<span v-if="isReadonly" class="truncate text-p-base text-ink-gray-8">
					{{ valueText }}
				</span>
				<TextInput
					v-else-if="!isEditable"
					class="w-full"
					readonly
					:modelValue="valueText"
					:aria-labelledby="valueNameIds"
				/>
				<component
					v-else
					:is="VALUE_CONTROLS[control.control]"
					v-bind="control.props"
					class="w-full"
					:modelValue="controlValue"
					:aria-labelledby="valueNameIds"
					@update:modelValue="onValueChange"
				/>
			</slot>
		</div>

		<span :id="fieldWordId" class="sr-only">{{ labels.field }}</span>
		<span :id="operatorWordId" class="sr-only">{{ labels.operator }}</span>
		<span :id="valueWordId" class="sr-only">{{ labels.value }}</span>
		<span v-if="!fieldLabelId" :id="fieldTextId" class="sr-only">
			{{ fieldText }}
		</span>
	</div>
</template>

<script setup lang="ts">
import { computed, useId } from "vue";
import { Button, Combobox, Select, TextInput } from "frappe-ui";
import { carryOver, defaultValueFor } from "../Filter/operators";
import type { Filter, FilterField, FilterOperator } from "../Filter/types";
import { valueControl } from "../Filter/valueControl";
import { VALUE_CONTROLS } from "../Filter/valueControlComponents";
import { conditionOperators } from "./adapters";
import { useConditionBuilderContext } from "./context";
import type { ConditionValue, FieldConditionValue } from "./types";

const props = defineProps<{
	condition: FieldConditionValue;

	/**
	 * Id of the element holding this row's field label, so the overflow menu can
	 * be named after the same field. Omitted for a standalone leaf.
	 */
	fieldLabelId?: string;

	readonly?: boolean;
}>();

const emit = defineEmits<{ update: [value: FieldConditionValue] }>();

const context = useConditionBuilderContext();
const labels = context.labels;

const fieldWordId = useId();
const operatorWordId = useId();
const valueWordId = useId();
const localFieldTextId = useId();
const fieldTextId = computed(() => props.fieldLabelId ?? localFieldTextId);

const operatorNameIds = computed(() => `${fieldTextId.value} ${operatorWordId}`);
const valueNameIds = computed(() => `${fieldTextId.value} ${valueWordId}`);

const fields = computed(() => context.fields.value);
const field = computed(() => fields.value.find((f) => f.fieldname === props.condition.fieldname));

const isReadonly = computed(() => Boolean(props.readonly || context.readonly.value));
// An unmatched fieldname means two different things. While the field list is in
// flight, or failed to load, it is unknowable and the row must not claim the
// field is gone; once loaded, an unmatched name is a deleted field. Neither
// drops the condition: the row stays readable and its field picker stays live.
const isFieldsUnavailable = computed(
	() => (context.fieldsLoading.value || Boolean(context.fieldsError.value)) && !field.value
);
const isUnknownField = computed(
	() => !isFieldsUnavailable.value && Boolean(props.condition.fieldname) && !field.value
);

const fieldOptions = computed(() =>
	fields.value.map((f) => ({ label: f.label, value: f.fieldname }))
);

const offeredOperators = computed(() =>
	conditionOperators(field.value?.fieldtype ?? "", field.value?.fieldname)
);

const operators = computed(() => {
	const offered = offeredOperators.value;
	const stored = props.condition.operator;
	// A stored operator the field's own list doesn't offer is appended, so the
	// rule stays readable instead of rendering as a blank Select.
	if (!stored || offered.some((option) => option.value === stored)) return offered;
	return [...offered, { label: stored, value: stored }];
});

// A fieldtype with no operator rules behind it reads like a deleted-field row —
// text, with the field picker live so it can be pointed somewhere editable.
const isUnsupportedField = computed(
	() => Boolean(field.value) && offeredOperators.value.length === 0
);

// The operator and value cells need a field to have any rules behind them.
const isEditable = computed(
	() =>
		!isReadonly.value &&
		!isFieldsUnavailable.value &&
		!isUnknownField.value &&
		!isUnsupportedField.value &&
		Boolean(field.value)
);

// The condition as `Filter` sees it: the same three values plus the Meta looked
// up from `fields`, which is all its operator and value-control rules need.
const filterCondition = computed<Filter>(() => ({
	fieldname: props.condition.fieldname,
	operator: props.condition.operator,
	value: props.condition.value as Filter["value"],
	field: field.value,
}));

const control = computed(() => valueControl(filterCondition.value));

// The controls that drop the name: the date pickers render inside a Popover,
// `MultiSelect` reads only `class` and `style` off its attrs, and the rating
// widget is several controls with no single element to name.
const UNNAMEABLE_CONTROLS = [
	"date",
	"datetime",
	"dateRange",
	"rating",
	"multiSelect",
	"multiLink",
];
const valueNeedsGroup = computed(
	() => isEditable.value && UNNAMEABLE_CONTROLS.includes(control.value.control)
);

// Controls that take and emit `string[]`: both coerce a non-array to `[]`, so a
// stored comma string is dropped the moment the row is touched.
const ARRAY_CONTROLS = ["multiSelect", "multiLink"];

/**
 * The field's own option list, where the fieldtype has a fixed one. Empty for a
 * Link, whose values live in another doctype and are not enumerable here.
 */
const knownOptions = computed<Set<string>>(() => {
	const options = field.value?.options;
	if (control.value.control !== "multiSelect" || typeof options !== "string") {
		return new Set();
	}
	return new Set(
		options
			.split("\n")
			.map((option) => option.trim())
			.filter(Boolean)
	);
});

/**
 * The stored value in the shape the control accepts: it is persisted as a comma
 * string while the multi-value controls take arrays. A whole string that is
 * itself a known option wins over splitting, since a value may contain a comma.
 */
const controlValue = computed<ConditionValue>(() => {
	const value = props.condition.value;
	if (!ARRAY_CONTROLS.includes(control.value.control)) return value;
	if (Array.isArray(value)) return value;
	if (typeof value !== "string" || value === "") return [];

	const known = knownOptions.value;
	if (known.has(value.trim())) return [value.trim()];

	const parts = value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);

	// One unrecognised part means the comma was inside a value, not between two.
	if (known.size > 0 && parts.some((part) => !known.has(part))) {
		return [value.trim()];
	}
	return parts;
});

const fieldText = computed(() => {
	if (field.value) return field.value.label;
	return props.condition.fieldname;
});

const operatorText = computed(() => {
	if (!props.condition.fieldname) return "";
	const known = operators.value.find((o) => o.value === props.condition.operator);
	return known?.label ?? props.condition.operator;
});

const valueText = computed(() => {
	const value = props.condition.value;
	if (value == null || value === "") return "";
	return Array.isArray(value) ? value.join(", ") : String(value);
});

// Combobox hands back the chosen option; its `value` is the fieldname.
function fieldFromOption(option: unknown): FilterField | undefined {
	if (!option) return undefined;
	const fieldname =
		typeof option === "string" ? option : (option as { value?: string }).value ?? "";
	return fields.value.find((f) => f.fieldname === fieldname);
}

function onFieldChange(option: unknown) {
	const next = fieldFromOption(option);
	if (!next) return;
	// `carryOver` keeps the operator and value where they still mean something
	// for the new field, instead of resetting the row on every field change. It is
	// told what this component offers, not what `Filter` does, or `is not` would
	// read as unavailable on every field and reset the row that used it.
	const carried = carryOver(
		filterCondition.value,
		next,
		conditionOperators(next.fieldtype, next.fieldname)
	);
	emit("update", {
		fieldname: carried.fieldname,
		operator: carried.operator,
		value: carried.value as ConditionValue,
	});
}

function onOperatorChange(operator: FilterOperator | undefined) {
	if (!operator || !field.value) return;
	emit("update", {
		...props.condition,
		operator,
		value: defaultValueFor(field.value, operator) as ConditionValue,
	});
}

function onValueChange(value: ConditionValue) {
	emit("update", { ...props.condition, value });
}
</script>
