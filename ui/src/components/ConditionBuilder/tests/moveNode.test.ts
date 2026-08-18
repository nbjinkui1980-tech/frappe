import { describe, expect, it } from "vitest";
import { moveNode } from "../tree";
import type { ConditionGroup } from "../types";

/** `A or B or C`, the tree every reorder below starts from. */
function tree(): ConditionGroup<string> {
  return { conjunction: "or", conditions: ["A", "B", "C"] };
}

function nested(): ConditionGroup<string> {
  return {
    conjunction: "or",
    conditions: ["A", { conjunction: "and", conditions: ["B", "C"] }],
  };
}

describe("moveNode", () => {
  it("reorders a row within its group", () => {
    const next = moveNode(tree(), [], 2, 0);
    expect(next.conditions).toEqual(["C", "A", "B"]);
  });

  it("leaves the source tree untouched", () => {
    const before = tree();
    moveNode(before, [], 0, 2);
    expect(before.conditions).toEqual(["A", "B", "C"]);
  });

  it("cannot change what the level matches", () => {
    // One operator for the group, so there is no gap for a move to re-point:
    // every arrangement of `A or B or C` is still `A or B or C`.
    for (const [from, to] of [
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 2],
      [2, 0],
      [2, 1],
    ]) {
      const next = moveNode(tree(), [], from, to);
      expect(next.conjunction).toBe("or");
      expect(next.conditions).toHaveLength(3);
    }
  });

  it("moves inside a nested group without touching its parent", () => {
    const next = moveNode(nested(), [1], 1, 0);
    const group = next.conditions[1] as ConditionGroup<string>;
    expect(group.conditions).toEqual(["C", "B"]);
    expect(group.conjunction).toBe("and");
    expect(next.conjunction).toBe("or");
    expect(next.conditions[0]).toBe("A");
  });

  it("is a no-op when the row does not move", () => {
    expect(moveNode(tree(), [], 1, 1)).toEqual(tree());
  });

  it("is a no-op for an index outside the group", () => {
    expect(moveNode(tree(), [], 0, 3)).toEqual(tree());
    expect(moveNode(tree(), [], -1, 0)).toEqual(tree());
  });

  it("is a no-op for a path that is not a group", () => {
    expect(moveNode(nested(), [0], 0, 1)).toEqual(nested());
    expect(moveNode(tree(), [9], 0, 1)).toEqual(tree());
  });

  it("never reparents", () => {
    const next = moveNode(nested(), [1], 0, 1);
    expect(next.conditions).toHaveLength(2);
    expect(
      (next.conditions[1] as ConditionGroup<string>).conditions
    ).toHaveLength(2);
  });
});
