// ConditionBuilder — a controlled editor for a nested and/or condition tree,
// built over the same operator and value-control rules as `Filter` so the two
// cannot drift. Everything that is not the component is in `adapters`: reading
// and writing Frappe's interleaved condition array, compiling the expression
// `safe_eval` runs, and the three helpers for handling a tree.
export { default as ConditionBuilder } from "./ConditionBuilder.vue";
export {
  emptyTree,
  fromFrappeConditions,
  isGroup,
  setGroupConjunction,
  toConditionExpression,
  toFrappeConditions,
} from "./adapters";
export type { ConditionExpressionOptions } from "./adapters";
export type {
  ConditionBorders,
  ConditionBuilderLabels,
  ConditionBuilderProps,
  ConditionColumns,
  ConditionGroup,
  ConditionNode,
  ConditionPath,
  ConditionValue,
  Conjunction,
  FieldConditionValue,
} from "./types";
// The field shape the built-in leaf takes, so a consumer supplying `fields`
// need not also import from the Filter subpath.
export type { FilterField } from "../Filter/types";
