import type { Component } from "vue";
import type { FilterField, FilterOperator, FilterValue } from "../Filter/types";

export type Conjunction = "and" | "or";

/** Child indices from the root group. `[]` addresses the root itself. */
export type ConditionPath = number[];

/**
 * A condition's value: `Filter`'s own `FilterValue`, widened by the two shapes
 * the shared `Fields` controls emit and it does not cover — a `Rating` number,
 * and the `null` a date holds before anything is picked.
 */
export type ConditionValue = FilterValue | number | null;

/**
 * The leaf shape used by the built-in editor: a `Filter` condition without the
 * resolved Meta. The field is looked up in `fields` by `fieldname` on every
 * render rather than stored, so a tree stays serializable as JSON.
 */
export interface FieldConditionValue {
  fieldname: string;
  operator: FilterOperator;
  value: ConditionValue;
}

/**
 * One operator for the whole group: every child is joined to the next by the
 * same `and` or `or`, so a level reads `A and B and C` and never
 * `A and B or C`. Mixing is expressed by nesting a group instead, which is the
 * only spelling of it a reader has to learn. The `conditions` array is what
 * tells a group from a leaf.
 */
export interface ConditionGroup<TLeaf = FieldConditionValue> {
  /** How every child of this group joins the next. Defaults to `and`. */
  conjunction: Conjunction;
  conditions: ConditionNode<TLeaf>[];
}

export type ConditionNode<TLeaf = FieldConditionValue> =
  | TLeaf
  | ConditionGroup<TLeaf>;

/**
 * Widths for the built-in leaf's three editable cells, as CSS grid track sizes.
 * Each row resolves them against its own contents, so a cell is the width of
 * what it holds; an `fr` here is a share of the row's leftover instead, which
 * stretches a cell past its content to use the width up.
 */
export interface ConditionColumns {
  field?: string;
  operator?: string;
  value?: string;
}

/**
 * `'all'` borders the root and every nested group, `'root'` only the outer card
 * so nesting reads from indentation alone, `'none'` draws no card at all.
 */
export type ConditionBorders = "all" | "root" | "none";

export interface ConditionBuilderLabels {
  where: string;
  and: string;
  or: string;

  /**
   * Names the root `<fieldset>` and every nested `role="group"`. A group holds
   * one operator, so these two are the whole vocabulary — there is no level
   * left that is neither all-and nor all-or.
   */
  matchAll: string;
  matchAny: string;

  /**
   * Describes what the and/or button does — set the whole group's operator, not
   * the one gap it sits in. Never rendered as visible text.
   */
  conjunctionHint: string;

  addCondition: string;
  addGroup: string;
  turnIntoGroup: string;
  ungroup: string;
  remove: string;
  removeGroup: string;
  empty: string;

  /** Accessible name for a row's overflow menu. Never rendered as text. */
  rowActions: string;

  /** Accessible name for a group's overflow menu. Never rendered as text. */
  groupActions: string;

  /** Names for the three cells of the built-in leaf. Never rendered as text. */
  field: string;
  operator: string;
  value: string;

  /** Shown when the doctype's fields could not be loaded. */
  fieldsError: string;
  retryFields: string;

  /**
   * Announced after a row or group is removed. A function so the sentence is
   * built in the host's language rather than assembled here from English
   * fragments, and because a cascade lands focus at a depth the user never
   * asked to delete in.
   */
  removed: (remaining: number, groupRemoved: boolean) => string;

  /**
   * Announced after a row is reordered. A drop and a menu move are the same
   * edit, so both say the same sentence. It carries where the row came from as
   * well as where it landed: a position on its own is only meaningful to
   * someone who watched it move. Positions are 1-based; `name` is the row's
   * field, and empty for a leaf the builder cannot name.
   */
  moved: (name: string, from: number, to: number, total: number) => string;

  /**
   * Announced after a row is dragged into a different group. A sentence of its
   * own because `moved` names two positions and nothing else, which would
   * report a reparent as a reorder — and where the row went is the whole of
   * what changed. It does not name the destination: a group's only name is its
   * conjunction, which two groups in one tree routinely share.
   */
  movedToGroup: (name: string, to: number, total: number) => string;
}

export interface ConditionBuilderProps<TLeaf = FieldConditionValue> {
  /**
   * The condition tree. Use with v-model — the component renders what it is
   * handed and keeps nothing of its own, so a host that never writes the emitted
   * value renders a tree that does not change. `null` is an empty tree, which is
   * what a nullable backend field bound straight to `v-model` arrives as; only
   * leaving the prop off is a wiring mistake, and it is required so that fails.
   */
  modelValue: ConditionGroup<TLeaf> | null;

  /**
   * The Python expression the tree compiles to. Write-only: it is never read
   * back, and exists so `v-model:expression` binds the Code field a host saves
   * beside the tree. The component compiles with the fields it derived from
   * `doctype`, so the Check and numeric rules are right without the host
   * supplying anything.
   */
  expression?: string;

  /**
   * Prefixes every fieldname in the emitted expression — `doc` for the
   * `doc.status` an SLA is evaluated against, nothing for an Assignment Rule,
   * which core evaluates in the document's own namespace. Affects nothing on
   * screen.
   */
  fieldPrefix?: string;

  /**
   * Doctype whose Meta drives the fields offered by the built-in leaf and the
   * operators each one gets. Ignored when `fields` is supplied, and unused
   * when `#condition` replaces the leaf entirely.
   */
  doctype?: string;

  /**
   * Fields offered by the built-in leaf, overriding the ones derived from
   * `doctype`. Ignored when `#condition` is used.
   */
  fields?: FilterField[];

  /** Cell widths for the built-in leaf. Ignored when #condition is used. */
  columns?: ConditionColumns;

  /**
   * Maximum group nesting depth. The root group is depth 0. Once reached,
   * "Add Condition Group" and "Turn into a Group" stop being offered.
   * Defaults to 4 — past that, rows have too little width left to stay usable.
   */
  maxDepth?: number;

  /** Factory for a new leaf. Defaults to an empty fieldname/operator/value. */
  newCondition?: () => TLeaf;

  /**
   * Renders the tree non-interactive: no add buttons, no overflow menus, every
   * control read-only. Read-only, not disabled — the rows keep their tab stops
   * and stay reachable, so the tree can still be read with a screen reader.
   */
  readonly?: boolean;

  /**
   * Overridable UI strings. The defaults already go through the host's `__`, so
   * this is for changing the wording, not for translating it; an override is
   * taken as given and is the app's own to translate.
   */
  labels?: Partial<ConditionBuilderLabels>;

  /** Which groups draw a card. Defaults to 'all'. */
  bordered?: ConditionBorders;

  /**
   * Whether rows can be reordered within their group, by drag or from the row
   * menu. Defaults to true. Order is meaningful to read even where it does not
   * change the result, so this is for hosts that sort the tree themselves and
   * would have the user's arrangement overwritten. Turns off dragging between
   * groups as well as within them — both are this one edit.
   */
  reorderable?: boolean;
}

export interface ConditionSlotProps<TLeaf = FieldConditionValue> {
  /** The leaf being rendered. */
  condition: TLeaf;

  /** Child indices from the root, addressing this leaf. */
  path: ConditionPath;

  /** Nesting depth of this leaf. */
  depth: number;

  /** True when the builder is read-only; the slot must not mutate the tree. */
  readonly: boolean;

  /** Replace this leaf with a new one. */
  update: (leaf: TLeaf) => void;
}

export interface ValueSlotProps {
  /** The matched field's Meta, or undefined when the fieldname is unknown. */
  field: FilterField | undefined;

  /** The condition's current operator. */
  operator: FilterOperator;

  /** The condition's current value. */
  modelValue: ConditionValue;

  /**
   * True when this value must not be edited — a read-only builder, or a row on a
   * field the doctype no longer has, whose fields have not loaded, or whose
   * fieldtype has no value control. The slot is rendered in every one of those
   * states, so this is what tells it which it is in; it must not call `update`
   * while this is true.
   */
  readonly: boolean;

  /** Write a new value back to the condition. */
  update: (value: ConditionValue) => void;
}

/**
 * Props for `#group`, which wraps or replaces how a **nested** group renders.
 *
 * The root group is not passed through it. The root is the builder itself —
 * there is no row around it to keep and no ancestor to render it into, so a
 * host wrapping the root is wrapping the whole control, which it does where it
 * mounts it rather than through a slot.
 */
export interface GroupSlotProps<TLeaf = FieldConditionValue> {
  /** The nested group being rendered. */
  group: ConditionGroup<TLeaf>;

  /** Child indices from the root, addressing this group. Never `[]`. */
  path: ConditionPath;

  /** How deep this group sits. The root is 0, so this is 1 or greater. */
  depth: number;

  /** True when the builder is read-only; the slot must not mutate the tree. */
  readonly: boolean;

  /**
   * The default rendering, as a component. `<component :is="Group" />` renders
   * the real recursive group — this builder's context, its rows, its own
   * nested groups and every slot still forwarded below it — wherever the host
   * puts it, including inside a dialog it teleports to `<body>`. It is the
   * same code path the slot's own fallback uses, so what a host wraps is the
   * component's rendering rather than a reimplementation of it.
   *
   * It takes no props: the group it renders is read from the tree on each
   * render, so its identity stays stable across edits and a dialog that opens
   * and closes over it does not remount the subtree underneath.
   *
   * Capitalised because it is a component, where `group` is the node.
   */
  Group: Component;
}

/** Props for `#where`, the leading cell of a group's first row. */
export interface WhereSlotProps {
  /** Path of the group this row belongs to. */
  groupPath: ConditionPath;

  /** The group's operator. Every group has one, whatever it holds. */
  conjunction: Conjunction;
}

/** Props for `#conjunction`, the and/or cell on every row after the first. */
export interface ConjunctionSlotProps {
  /** The group's operator, which is the word this cell shows. */
  conjunction: Conjunction;

  /** This row's index within its group. Always 1 or greater. */
  index: number;

  /** Path of the group this cell belongs to. */
  groupPath: ConditionPath;

  /** Flip the whole group's operator. */
  toggle: () => void;

  /**
   * Whether this cell's control is live. Exactly one cell in a group is —
   * row 1, the only one whose word is not a repeat — and none while readonly.
   * A cell that is not live renders the word as text rather than as a disabled
   * button; the slot should do the same.
   */
  canToggle: boolean;
}

/** Props for `#actions`, the per-row overflow menu. */
export interface ActionsSlotProps {
  /** Path of the row or group these actions apply to. */
  path: ConditionPath;

  /** True when this row is a nested group rather than a leaf. */
  isGroup: boolean;

  /** True when the builder is read-only. */
  readonly: boolean;

  /**
   * Whether `turnIntoGroup` would do anything: false for a row that is already a
   * group, and false where nesting here would exceed `maxDepth`. Both, rather
   * than only the depth, because the two together are the whole condition under
   * which wrapping is offered — a host guarding on this alone is correct, and one
   * that had to remember `!isGroup` beside it would ship a dead menu item.
   */
  canGroup: boolean;

  /** False for the first row of a group, which has nowhere above to go. */
  canMoveUp: boolean;

  /** False for the last row of a group. */
  canMoveDown: boolean;

  /** Swap this row with the one above it. */
  moveUp: () => void;

  /** Swap this row with the one below it. */
  moveDown: () => void;

  /** Wrap this leaf in a new group. */
  turnIntoGroup: () => void;

  /** Splice this group's children into its parent. */
  ungroup: () => void;

  /** Delete this row or group. */
  remove: () => void;
}

/** Props for `#addCondition`, a group's add affordance. */
export interface AddConditionSlotProps {
  /** Path of the group to add into. */
  groupPath: ConditionPath;

  /** Append an empty leaf. */
  addCondition: () => void;

  /** Append a new group holding one empty leaf. */
  addGroup: () => void;

  /** False when a new group here would exceed `maxDepth`. */
  canAddGroup: boolean;
}

export interface ConditionBuilderSlots<TLeaf = FieldConditionValue> {
  /** Replaces the entire leaf row. */
  condition?: (props: ConditionSlotProps<TLeaf>) => unknown;

  /**
   * Wraps or replaces a nested group. Render `Group` to place the default
   * rendering inside whatever the host wraps it in.
   *
   * An empty template renders the default group rather than nothing: Vue falls
   * back whenever a slot produces no vnode, here and in every other slot. A
   * node that draws nothing (`<span />`) renders no group at all, leaving it in
   * the tree with its rows unreachable.
   */
  group?: (props: GroupSlotProps<TLeaf>) => unknown;

  /** Replaces only the value control inside the built-in leaf. */
  value?: (props: ValueSlotProps) => unknown;

  /** Replaces the empty-state content. */
  empty?: () => unknown;

  /** Replaces the "Where" cell. Render a `<span />` to draw nothing. */
  where?: (props: WhereSlotProps) => unknown;

  /** Replaces the and/or cell. Render a `<span />` to draw nothing. */
  conjunction?: (props: ConjunctionSlotProps) => unknown;

  /** Replaces the row's overflow menu. Render a `<span />` to draw nothing. */
  actions?: (props: ActionsSlotProps) => unknown;

  /** Replaces the add affordance. Render a `<span />` to draw nothing. */
  addCondition?: (props: AddConditionSlotProps) => unknown;
}
