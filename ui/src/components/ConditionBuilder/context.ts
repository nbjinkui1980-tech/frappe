import { customRef, inject } from "vue";
import type { ComputedRef, InjectionKey, Ref } from "vue";
import type { FilterField } from "../Filter/types";
import type {
  ConditionBorders,
  ConditionBuilderLabels,
  ConditionColumns,
  ConditionPath,
  Conjunction,
} from "./types";

/**
 * Shared by every node in the recursive tree. Mutations are reported by path so
 * `ConditionGroup` never relays events up through its own recursion.
 */
export interface ConditionBuilderContext {
  /**
   * Identifies this builder's rows in the document. Focus moves by querying for
   * a path, and a path is only unique inside one builder — two on a page hold
   * the same ones — so every such query is scoped by this rather than by
   * containment.
   */
  builderId: ComputedRef<string>;

  fields: ComputedRef<FilterField[]>;

  /**
   * While the doctype's Meta is in flight a fieldname missing from `fields`
   * means "not loaded" rather than "not a field any more", and the two get
   * opposite treatments in the leaf.
   */
  fieldsLoading: ComputedRef<boolean>;

  /**
   * The Meta request's error, if it failed. A failed request leaves the field
   * list unknowable, which is not the same as the doctype having no fields, and
   * the leaf has to tell those apart.
   */
  fieldsError: ComputedRef<unknown>;

  /** Re-run the Meta request. */
  reloadFields: () => void;

  columns: ComputedRef<Required<ConditionColumns>>;
  labels: Ref<ConditionBuilderLabels>;
  bordered: ComputedRef<ConditionBorders>;
  maxDepth: ComputedRef<number>;
  readonly: ComputedRef<boolean>;
  reorderable: ComputedRef<boolean>;

  addCondition: (groupPath: ConditionPath) => void;
  addGroup: (groupPath: ConditionPath) => void;
  remove: (path: ConditionPath) => void;
  update: (path: ConditionPath, leaf: unknown) => void;
  turnIntoGroup: (path: ConditionPath) => void;
  ungroup: (path: ConditionPath) => void;
  /** Set a group's operator, which every one of its rows is joined by. */
  setConjunction: (groupPath: ConditionPath, value: Conjunction) => void;

  /**
   * Reorder one child within its group. `name` is what the announcement calls
   * the row: the group holds the field label, this does not. A drop and a menu
   * move both land here and both announce; only the menu move places focus,
   * since a pointer drop has not taken any.
   */
  move: (
    groupPath: ConditionPath,
    from: number,
    to: number,
    options?: { name?: string; focus?: boolean }
  ) => void;

  /**
   * Whether the node at `from` may be dropped into the group at `toGroupPath`.
   * Asked while a drag is in flight, so a drop that would nest past `maxDepth`
   * shows no drop indicator rather than landing and snapping back.
   */
  canDrop: (from: ConditionPath, toGroupPath: ConditionPath) => boolean;

  /**
   * Move a row to `toIndex` of the group at `toGroupPath` — a sibling group, a
   * nested one, or an ancestor. Where `move` reorders inside one group from a
   * control that holds focus, this is the pointer's edit: it takes no focus and
   * places none, and it is applied once, from the list the drag started in.
   */
  moveInto: (
    from: ConditionPath,
    toGroupPath: ConditionPath,
    toIndex: number,
    options?: { name?: string }
  ) => void;

  /** Put a message in the builder's live region. */
  announce: (message: string) => void;
}

export const conditionBuilderKey: InjectionKey<ConditionBuilderContext> =
  Symbol("conditionBuilder");

/**
 * Grid tracks for the leaf's three editable cells. Each row resolves them
 * against its own content — the group does not share one grid — so a row that
 * names a long field is the only row that pays for it. `minmax(0, max-content)`
 * rather than a bare `max-content`: the bare form floors at min-content, and a
 * floor is what makes a grid overflow a narrow container instead of shrinking
 * inside it.
 */
export const DEFAULT_COLUMNS: Required<ConditionColumns> = {
  // Each cell is the width of what it holds, which is what makes a row read as
  // a phrase rather than as three boxes: `Status` gets a pill the width of the
  // word and `Raised Outside Working Hours` one the width of the sentence, on
  // the same row as an operator no wider than `Equals`. There is no `fr` here
  // on purpose — an `fr` track is a share of the *leftover* space, so it would
  // stretch a cell past its contents purely to use the width up. The row's
  // leftover collects in the actions' track at the end instead.
  field: "minmax(0, max-content)",
  operator: "minmax(0, max-content)",
  value: "minmax(0, max-content)",
};

/** Deepest nesting level offered. The root group is depth 0. */
export const DEFAULT_MAX_DEPTH = 4;

export const DEFAULT_BORDERS: ConditionBorders = "all";

/** Rows reorder unless the host sorts the tree itself. */
export const DEFAULT_REORDERABLE = true;

/**
 * The host's translation function, read off the global at call time: this
 * package has no i18n of its own, and a host that installs none still renders.
 * Anything carrying a value uses a `{0}` placeholder — a sentence glued from
 * separately translated halves only reads correctly in English.
 */
function t(message: string, replace?: unknown[]): string {
  const translate = (
    globalThis as { __?: (m: string, r?: unknown[]) => string }
  ).__;
  if (typeof translate === "function") return translate(message, replace);
  if (!replace) return message;
  // The fallback substitutes too: a literal `{0}` would otherwise be read out to
  // a screen reader on any host without a translation plugin.
  return message.replace(/\{(\d+)\}/g, (match, index) => {
    const value = replace[Number(index)];
    return value === undefined ? match : String(value);
  });
}

/**
 * The built-in UI strings, translated through the host's `__`. A function and
 * not a const: a module-level object is built while the import graph resolves,
 * before the host installs its translations, which would freeze every label as
 * English for the life of the page.
 */
export function defaultLabels(): ConditionBuilderLabels {
  return {
    where: t("Where"),
    and: t("and"),
    or: t("or"),
    matchAll: t("Match all of the following"),
    matchAny: t("Match any of the following"),
    conjunctionHint: t("Changes how every condition in this group is joined"),
    addCondition: t("Add Condition"),
    addGroup: t("Add Condition Group"),
    turnIntoGroup: t("Turn into a Group"),
    ungroup: t("Ungroup Conditions"),
    remove: t("Remove"),
    removeGroup: t("Remove Group"),
    empty: t("Add a Condition"),
    rowActions: t("Condition actions"),
    groupActions: t("Group actions"),
    field: t("Field"),
    operator: t("Operator"),
    value: t("Value"),
    fieldsError: t("Could not load this doctype's fields."),
    retryFields: t("Retry"),
    removed: (remaining, groupRemoved) =>
      [
        t("Condition removed."),
        groupRemoved ? t("Its group was left empty and was removed too.") : "",
        t("{0} remaining.", [remaining]),
      ]
        .filter(Boolean)
        .join(" "),
    movedToGroup: (name, to, total) =>
      name
        ? t("{0} moved into another group, at position {1} of {2}.", [
            name,
            to,
            total,
          ])
        : t("Condition moved into another group, at position {0} of {1}.", [
            to,
            total,
          ]),
    moved: (name, from, to, total) =>
      name
        ? t("{0} moved from position {1} to position {2} of {3}.", [
            name,
            from,
            to,
            total,
          ])
        : t("Condition moved from position {0} to position {1} of {2}.", [
            from,
            to,
            total,
          ]),
  };
}

/**
 * Labels that re-read on every access and invalidate their readers once the
 * host's messages land. A `computed` caches, freezing whatever it read first;
 * a bare `{ get value() }` object is not a ref, so a template never unwraps it.
 */
export function uncachedLabels(
  read: () => ConditionBuilderLabels
): Ref<ConditionBuilderLabels> {
  let probe = t("Where");
  return customRef((track, trigger) => ({
    get() {
      track();
      const current = t("Where");
      if (current !== probe) {
        probe = current;
        queueMicrotask(trigger);
      }
      return read();
    },
    set() {},
  }));
}

/**
 * Overlay a consumer's partial object onto the defaults, key by key. Not a
 * spread: an object literal built from a host's optional values carries the
 * missing ones as explicit `undefined` keys, which a spread copies over the
 * defaults and leaves the UI with an empty string where a label should be. An
 * unknown key is ignored rather than added.
 */
function overlay<T extends object>(defaults: T, overrides?: Partial<T>): T {
  if (!overrides) return defaults;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || !(key in defaults)) continue;
    (defaults as Record<string, unknown>)[key] = value;
  }
  return defaults;
}

export function mergeLabels(
  overrides?: Partial<ConditionBuilderLabels>
): ConditionBuilderLabels {
  return overlay(defaultLabels(), overrides);
}

export function mergeColumns(
  overrides?: ConditionColumns
): Required<ConditionColumns> {
  return overlay({ ...DEFAULT_COLUMNS }, overrides);
}

/**
 * Read the shared context. Every node that calls this is rendered by the
 * builder, so a miss is a node used outside one, which has no tree to edit and
 * nothing to render from. It says so rather than carrying a second, inert copy
 * of every default that has to be kept in step with this one.
 */
export function useConditionBuilderContext(): ConditionBuilderContext {
  const context = inject(conditionBuilderKey, null);
  if (!context) {
    throw new Error(
      "ConditionBuilder: this component must be used inside one."
    );
  }
  return context;
}
