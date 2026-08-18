import type {
  ConditionGroup,
  ConditionNode,
  ConditionPath,
  Conjunction,
} from "./types";

/**
 * Groups are told apart from leaves structurally, so the model survives a JSON
 * round-trip with no discriminator field to keep in sync. The `conditions`
 * array is the whole test: a group written without a `conjunction` — a tree
 * hand-built by a host, an older record — is still a group, and reading it as a
 * leaf would lose every rule inside it, where defaulting its operator to `and`
 * loses nothing a reader cannot see and change.
 */
export function isGroup<T>(node: ConditionNode<T>): node is ConditionGroup<T> {
  return (
    node !== null &&
    typeof node === "object" &&
    Array.isArray((node as ConditionGroup<T>).conditions)
  );
}

export function emptyTree<T>(): ConditionGroup<T> {
  return { conjunction: "and", conditions: [] };
}

/**
 * A detached, proxy-free copy every operation starts from. `structuredClone`
 * keeps non-JSON values in a consumer's leaf (a `Date`, a `Map`) intact; a JSON
 * round-trip is the fallback for the shapes it refuses.
 */
function clone<T>(tree: ConditionGroup<T>): ConditionGroup<T> {
  try {
    return structuredClone(tree);
  } catch {
    return JSON.parse(JSON.stringify(tree));
  }
}

export function getNode<T>(
  tree: ConditionGroup<T>,
  path: ConditionPath
): ConditionNode<T> | undefined {
  let node: ConditionNode<T> = tree;
  for (const index of path) {
    if (!isGroup(node)) return undefined;
    node = node.conditions[index];
    if (node === undefined) return undefined;
  }
  return node;
}

function parentOf<T>(
  tree: ConditionGroup<T>,
  path: ConditionPath
): ConditionGroup<T> | undefined {
  const node = getNode(tree, path.slice(0, -1));
  return node !== undefined && isGroup(node) ? node : undefined;
}

/**
 * Every edit is the same three steps — clone, resolve, bail if the path names
 * nothing — around one mutation. Written once so a new operation cannot forget
 * the clone and mutate the tree the host still holds, and so "a path that no
 * longer resolves is a no-op" is one rule rather than nine copies of it.
 */
function editGroup<T>(
  tree: ConditionGroup<T>,
  groupPath: ConditionPath,
  edit: (group: ConditionGroup<T>) => void
): ConditionGroup<T> {
  const next = clone(tree);
  const group = getNode(next, groupPath);
  if (group !== undefined && isGroup(group)) edit(group);
  return next;
}

/** The same, for an edit that addresses a child by its place in its parent. */
function editParent<T>(
  tree: ConditionGroup<T>,
  path: ConditionPath,
  edit: (parent: ConditionGroup<T>, index: number) => void
): ConditionGroup<T> {
  const next = clone(tree);
  const parent = parentOf(next, path);
  if (parent) edit(parent, path[path.length - 1]);
  return next;
}

export function addCondition<T>(
  tree: ConditionGroup<T>,
  groupPath: ConditionPath,
  leaf: T
): ConditionGroup<T> {
  return editGroup(tree, groupPath, (group) => {
    group.conditions.push(leaf);
  });
}

/**
 * A new group starts on `and`, the same operator `emptyTree` starts on and the
 * one Frappe's own default writes. It does not inherit its parent's: a group of
 * one shows no operator at all, so the inherited word would first become
 * visible on a row the user added later, having been decided by a group they
 * were not looking at.
 */
export function addGroup<T>(
  tree: ConditionGroup<T>,
  groupPath: ConditionPath,
  leaf: T
): ConditionGroup<T> {
  return editGroup(tree, groupPath, (group) => {
    group.conditions.push({ conjunction: "and", conditions: [leaf] });
  });
}

export function removeNode<T>(
  tree: ConditionGroup<T>,
  path: ConditionPath
): ConditionGroup<T> {
  if (path.length === 0) return emptyTree<T>();

  const next = clone(tree);
  const parent = parentOf(next, path);
  if (!parent) return next;

  parent.conditions.splice(path[path.length - 1], 1);

  // A group that just lost its last child goes with it.
  if (parent.conditions.length === 0 && path.length > 1) {
    return removeNode(next, path.slice(0, -1));
  }
  return next;
}

/**
 * Move a child within its own group. The group's operator joins every pair
 * alike, so a reorder cannot change what the level matches — it changes only
 * the order the rules read in.
 */
export function moveNode<T>(
  tree: ConditionGroup<T>,
  groupPath: ConditionPath,
  from: number,
  to: number
): ConditionGroup<T> {
  return editGroup(tree, groupPath, (group) => {
    const last = group.conditions.length - 1;
    if (from === to || from < 0 || to < 0 || from > last || to > last) return;

    const [node] = group.conditions.splice(from, 1);
    group.conditions.splice(to, 0, node);
  });
}

/** Whether two paths address the same node. */
export function samePath(a: ConditionPath, b: ConditionPath): boolean {
  return a.length === b.length && a.every((index, depth) => index === b[depth]);
}

/** Whether `path` addresses `other` or something inside it. */
function isAtOrBelow(path: ConditionPath, other: ConditionPath): boolean {
  return path.length >= other.length && other.every((i, d) => i === path[d]);
}

/**
 * How many levels of group a node is: 0 for a leaf, 1 for a group of leaves, 2
 * for a group holding a group. A move adds this to its destination's own depth
 * to ask whether what lands there still fits under `maxDepth` — the whole
 * subtree travels, so it is the deepest group inside it that decides, not the
 * node itself.
 */
function groupLevels<T>(node: ConditionNode<T>): number {
  if (!isGroup(node)) return 0;
  return (
    1 +
    node.conditions.reduce(
      (deepest, child) => Math.max(deepest, groupLevels(child)),
      0
    )
  );
}

/**
 * Whether the node at `from` may be dropped into the group at `toGroupPath`.
 * The same guard the move runs, exposed so a drag can refuse the drop while it
 * is still happening rather than letting it land and snap back.
 *
 * Three things are refused: the root, which has nowhere to go; a group dropped
 * into itself or into anything it contains, which would detach that subtree
 * from the tree entirely; and a drop whose subtree would sit deeper than
 * `maxDepth`. A leaf adds no level, so depth never refuses one.
 */
export function canMoveInto<T>(
  tree: ConditionGroup<T>,
  from: ConditionPath,
  toGroupPath: ConditionPath,
  maxDepth: number
): boolean {
  if (from.length === 0) return false;

  const node = getNode(tree, from);
  if (node === undefined) return false;

  const target = getNode(tree, toGroupPath);
  if (target === undefined || !isGroup(target)) return false;

  if (isAtOrBelow(toGroupPath, from)) return false;

  return toGroupPath.length + groupLevels(node) <= maxDepth;
}

/**
 * Move a node to `toIndex` of the group at `toGroupPath`, from anywhere in the
 * tree — a sibling group, a nested one, or back out to an ancestor. One edit,
 * so the tree is never briefly missing the node it is carrying.
 *
 * Everything after the clone is done through object references rather than
 * paths, because the splices invalidate paths as they go: taking a row out of a
 * group re-points every later sibling, and putting it into another re-points
 * that group's. A group emptied by the move goes the way `removeNode` takes an
 * emptied group — removed, cascading up, never the root — and is pruned by
 * reference for the same reason.
 *
 * `toIndex` is clamped rather than rejected: it comes from a pointer, and a drop
 * one past the end is an append, not a mistake.
 */
export function moveNodeToGroup<T>(
  tree: ConditionGroup<T>,
  from: ConditionPath,
  toGroupPath: ConditionPath,
  toIndex: number,
  maxDepth: number
): ConditionGroup<T> {
  const next = clone(tree);
  if (!canMoveInto(next, from, toGroupPath, maxDepth)) return next;

  const source = parentOf(next, from);
  const target = getNode(next, toGroupPath);
  if (!source || target === undefined || !isGroup(target)) return next;

  const [node] = source.conditions.splice(from[from.length - 1], 1);
  if (node === undefined) return next;

  target.conditions.splice(
    Math.max(0, Math.min(toIndex, target.conditions.length)),
    0,
    node
  );

  if (source !== target) pruneEmpty(next, source);
  return next;
}

/** The group holding `child`, found by identity rather than by path. */
function parentGroupOf<T>(
  root: ConditionGroup<T>,
  child: ConditionNode<T>
): ConditionGroup<T> | null {
  if (root.conditions.includes(child)) return root;
  for (const node of root.conditions) {
    if (!isGroup(node)) continue;
    const found = parentGroupOf(node, child);
    if (found) return found;
  }
  return null;
}

/**
 * Drop `group` if the move left it empty, and its parent if that empties too.
 * The root stays: an empty root is the builder's empty state, not a group to
 * delete. Same rule as `removeNode`'s cascade, by reference.
 */
function pruneEmpty<T>(
  root: ConditionGroup<T>,
  group: ConditionGroup<T>
): void {
  if (group === root || group.conditions.length > 0) return;

  const parent = parentGroupOf(root, group);
  if (!parent) return;

  parent.conditions.splice(parent.conditions.indexOf(group), 1);
  pruneEmpty(root, parent);
}

export function updateLeaf<T>(
  tree: ConditionGroup<T>,
  path: ConditionPath,
  leaf: T
): ConditionGroup<T> {
  return editParent(tree, path, (parent, index) => {
    parent.conditions[index] = leaf;
  });
}

export function turnIntoGroup<T>(
  tree: ConditionGroup<T>,
  path: ConditionPath
): ConditionGroup<T> {
  return editParent(tree, path, (parent, index) => {
    const node = parent.conditions[index];
    if (node === undefined || isGroup(node)) return;
    parent.conditions[index] = { conjunction: "and", conditions: [node] };
  });
}

/**
 * Splice a group's children into its parent. The children are re-joined by the
 * parent's operator, since that is the only one their new level has: ungrouping
 * an `or` group into an `and` parent changes what the rule matches, which is
 * the same thing the brackets coming off would mean if it were written out.
 */
export function ungroup<T>(
  tree: ConditionGroup<T>,
  path: ConditionPath
): ConditionGroup<T> {
  if (path.length === 0) return clone(tree);

  return editParent(tree, path, (parent, index) => {
    const group = parent.conditions[index];
    if (group === undefined || !isGroup(group)) return;
    parent.conditions.splice(index, 1, ...group.conditions);
  });
}

/**
 * Set a group's operator — the only way to change one, since a group holds
 * exactly one. What the and/or button in the group's first gap writes, and what
 * a host restyling that cell through `#conjunction` runs.
 */
export function setGroupConjunction<T>(
  tree: ConditionGroup<T>,
  groupPath: ConditionPath,
  value: Conjunction
): ConditionGroup<T> {
  return editGroup(tree, groupPath, (group) => {
    group.conjunction = value;
  });
}

/** The root group is depth 0, so a group at `path` sits at `path.length`. */
export function canNest(groupPath: ConditionPath, maxDepth: number): boolean {
  return groupPath.length < maxDepth;
}
