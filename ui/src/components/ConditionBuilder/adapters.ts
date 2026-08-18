import { getOperators } from "../Filter/operators";
import type { OperatorOption } from "../Filter/operators";
import type { FilterField, FilterOperator } from "../Filter/types";
import { isGroup } from "./tree";

import type {
  ConditionGroup,
  ConditionNode,
  ConditionValue,
  Conjunction,
  FieldConditionValue,
} from "./types";

type Leaf = FieldConditionValue;
type Node = ConditionNode<Leaf>;

/**
 * The tree helpers a host needs beside the conversions: a fresh tree, telling a
 * group from a leaf, and setting one operator across a group. Re-exported rather
 * than moved so that `tree.ts` stays what it is — the edit primitives the
 * component runs on, which a consumer has no reason to reach for — while this
 * file is the whole of the API that is not the component itself.
 */
export { emptyTree, isGroup, setGroupConjunction } from "./tree";

const UNWRITABLE_OPERATORS: FilterOperator[] = ["timespan"];
const IS_NOT: OperatorOption = { label: "Is not", value: "is not" };

/**
 * The operators this component can write. The host's compiler implements
 * `is not`, and has no rule for `timespan` — which would raise when the rule
 * runs. `getOperators` returns a fresh array, so it is safe to reshape.
 */
export function conditionOperators(
  fieldtype: string,
  fieldname?: string
): OperatorOption[] {
  const offered = getOperators(fieldtype, fieldname).filter(
    (option) => !UNWRITABLE_OPERATORS.includes(option.value)
  );
  const is = offered.findIndex((option) => option.value === "is");
  if (is !== -1) offered.splice(is + 1, 0, IS_NOT);
  return offered;
}

/**
 * Operators accepted on the way in, mapped to the vocabulary the tree stores.
 * `equals`, `=` and `==` all compile to the same `==`, so Python's own tokens
 * read as aliases. An entry on an unlisted operator is dropped.
 *
 * `timespan` is deliberately absent, though `Filter` offers it: there is no
 * `safe_eval` expression for it, so a row holding one could only compile to
 * something that raises for every document the rule runs against. Dropping it on
 * read costs that one condition; keeping it costs the whole rule.
 */
const READ_OPERATOR: Record<string, FilterOperator> = {
  "==": "equals",
  "=": "equals",
  equals: "equals",
  "!=": "not equals",
  "not equals": "not equals",
  like: "like",
  "not like": "not like",
  in: "in",
  "not in": "not in",
  is: "is",
  "is not": "is not",
  "<": "<",
  ">": ">",
  "<=": "<=",
  ">=": ">=",
  between: "between",
};

/**
 * Convert a tree to the interleaved array that Frappe's Assignment Rule and
 * SLA condition fields persist. The stored format carries a token per gap and
 * a group carries one for all of them, so the group's token is repeated between
 * every surviving pair: `{ conjunction: "or", conditions: [a, b, c] }` writes
 * `[a, "or", b, "or", c]`. The format is unchanged by the model — anything
 * already stored still loads, and anything written here still reads everywhere
 * it did before.
 */
export function toFrappeConditions(tree: ConditionGroup<Leaf>): unknown[] {
  const out: unknown[] = [];
  let written = 0;

  tree.conditions.forEach((node) => {
    // A row with no field holds no condition, so dropping it is lossless.
    if (!isGroup(node) && !node.fieldname) return;

    const encoded = nodeToFrappe(node);

    // The host's compiler destructures a field/operator/value out of every
    // entry, so a group that encodes to nothing is dropped rather than written
    // as `[]`. `removeNode` prunes them, so only a hand-written record gets here.
    if (isGroup(node) && Array.isArray(encoded) && encoded.length === 0) return;

    // `written`, not `index`, so a skipped entry cannot leave the array starting
    // on a conjunction — and with one token for the level there is nothing else
    // a dropped row could strand.
    if (written > 0) out.push(tree.conjunction ?? "and");
    out.push(encoded);
    written += 1;
  });

  return out;
}

function nodeToFrappe(node: Node): unknown {
  if (isGroup(node)) return toFrappeConditions(node);
  return [node.fieldname, node.operator, node.value];
}

export interface ConditionExpressionOptions {
  /**
   * Prefix every fieldname with this and a dot. Which one a host wants is
   * settled by what the Python caller puts in scope, never by taste: a
   * Notification or a Helpdesk SLA evaluates against `get_context(doc)`, whose
   * `doc` key is what makes `doc.status` resolve, while an Assignment Rule
   * passes the document itself as the locals — `safe_eval(cond, None, doc)` —
   * so its fieldnames are bare, which is what leaving this off emits. A wrong
   * guess compiles and stores exactly like a right one, and raises only where
   * the rule is finally run.
   */
  fieldPrefix?: string;

  /**
   * The doctype's filterable fields, for the two rules that cannot be decided
   * from a condition alone: a Check field compiles to its own truthiness, and a
   * numeric field compiles to a number rather than a quoted string, which is
   * what `doc.grand_total > "100"` would otherwise raise on. Without them both
   * fall back to reading the value — `"Yes"` is taken for a Check, and every
   * value is quoted — which is what the compilers in CRM and Helpdesk do.
   *
   * `ConditionBuilder` passes the fields it already derived from `doctype`, so
   * a host binding `v-model:expression` gets this for free.
   */
  fields?: FilterField[];
}

/**
 * Compile a tree into the Python expression `safe_eval` runs — the executable
 * half of what a host persists, next to the array `toFrappeConditions` writes.
 * Without this every consumer writes the compiler again, and the operators it
 * has to implement are not a `join(" and ")`: `like` is a membership test, `is
 * set` is the bare field, a Check field's `== "Yes"` is the bare field too.
 *
 * Compiled through `toFrappeConditions`, so a row without a field is treated
 * exactly as it is on save — dropped.
 */
export function toConditionExpression(
  tree: ConditionGroup<Leaf>,
  options: ConditionExpressionOptions = {}
): string {
  return compileEntries(toFrappeConditions(tree), options);
}

/**
 * Split one level of the array into its operands and the separators between
 * them, running each entry through `read`. An entry `read` makes nothing of
 * takes its pending separator with it, which is right at either end: a dropped
 * first entry has none pending, so the token after it is never kept either.
 *
 * Both directions need exactly this — reading a stored array into a tree, and
 * compiling one into an expression — and the rule is subtle enough that a second
 * copy of it would eventually disagree with this one.
 *
 * It returns every separator it found, not just the first, because the format
 * carries one per gap and the compiler joins each gap with the token written in
 * it. `fromFrappeConditions` is the caller that collapses them, and it is the
 * only one: flattening here would put the tree's rule into the compiler as
 * well, so a record would compile to something the array beside it does not say.
 */
function foldEntries<T>(
  entries: unknown[],
  read: (entry: unknown) => T | null
): { items: T[]; separators: Conjunction[] } {
  const items: T[] = [];
  const separators: Conjunction[] = [];
  let pending: Conjunction | null = null;

  for (const entry of entries) {
    const token = asConjunction(entry);
    if (token !== null) {
      pending = token;
      continue;
    }

    const item = read(entry);
    if (item === null) {
      pending = null;
      continue;
    }

    if (items.length > 0) separators.push(pending ?? "and");
    items.push(item);
    pending = null;
  }

  return { items, separators };
}

/** One level of the array, as the expression it evaluates to. */
function compileEntries(
  entries: unknown[],
  options: ConditionExpressionOptions
): string {
  const { items, separators } = foldEntries(entries, (entry) => {
    const compiled = compileEntry(entry, options);
    return compiled === "" ? null : compiled;
  });

  return items.reduce(
    (expression, operand, index) =>
      index === 0
        ? operand
        : `${expression} ${separators[index - 1]} ${operand}`,
    ""
  );
}

/**
 * A nested group is parenthesised, so the tree's own shape decides the reading
 * rather than Python's precedence — the one place the two disagree is exactly
 * the group a user nested to say `(a or b) and c`.
 */
function compileEntry(
  entry: unknown,
  options: ConditionExpressionOptions
): string {
  if (Array.isArray(entry) && Array.isArray(entry[0])) {
    const nested = compileEntries(entry, options);
    return nested === "" ? "" : `(${nested})`;
  }
  return compileLeaf(entry, options);
}

/**
 * The operators that compile to a different Python token than they are written
 * with. Everything else either has a rule in `compileLeaf` or is already spelled
 * the way Python spells it.
 */
const PYTHON_OPERATOR: Record<string, string> = {
  equals: "==",
  "=": "==",
  "==": "==",
  "not equals": "!=",
  "!=": "!=",
};

/** Fieldtypes whose value is a number in the document, not a string. */
const NUMERIC_FIELDTYPES = ["Int", "Float", "Currency", "Percent", "Rating"];

/**
 * The comparisons that are already Python, so a value can be placed straight
 * after them. This is also the whole of what may be emitted without a rule: an
 * operator that reaches the end of `compileLeaf` without matching one compiles to
 * nothing rather than to `field between ""` or `field timespan "last week"`,
 * neither of which `safe_eval` can parse — and a rule that will not parse matches
 * nothing at all, so emitting one loses every other condition in the record too.
 */
const SCALAR_COMPARISONS = ["==", "!=", "<", "<=", ">", ">="];

/**
 * The comparisons Python refuses to make across types. `1 > "1"` is a TypeError,
 * where `1 == "1"` is merely False — which is why an unreadable number sinks
 * only these, and `==`/`!=` may still be emitted quoted.
 */
const ORDERING = ["<", "<=", ">", ">="];

function compileLeaf(
  entry: unknown,
  options: ConditionExpressionOptions
): string {
  if (
    !Array.isArray(entry) ||
    entry.length !== 3 ||
    typeof entry[0] !== "string"
  ) {
    return "";
  }

  const [fieldname, rawOperator, value] = entry;
  const { fieldPrefix, fields } = options;
  const field = fieldPrefix ? `${fieldPrefix}.${fieldname}` : fieldname;
  const token = String(rawOperator).toLowerCase();
  const operator = PYTHON_OPERATOR[token] ?? token;
  const fieldtype = fields?.find((f) => f.fieldname === fieldname)?.fieldtype;

  // A Check field holds the string "Yes"/"No" and compiles to the field itself:
  // the document's value is a 0/1, which `== "Yes"` never matches. Given fields,
  // the fieldtype decides and the guessing stops — including for a fieldname
  // they do not carry, which is a field the rule has outlived rather than a
  // Check. Given none, the value is all there is to go on and a Data field
  // holding the word "Yes" reads as a Check, which is what CRM's and Helpdesk's
  // compilers do.
  const check = String(value).trim().toLowerCase();
  const isCheck =
    fields !== undefined
      ? fieldtype === "Check"
      : check === "yes" || check === "no";
  if (
    (operator === "==" || operator === "!=") &&
    isCheck &&
    (check === "yes" || check === "no")
  ) {
    return (check === "yes") === (operator === "==") ? field : `not ${field}`;
  }

  // `is`/`is not` take Set or Not Set, and all four pairings resolve to the
  // field's truthiness. CRM's compiler leaves `is not` + `not set` to fall
  // through to `field is not "not set"`, which is true of every document.
  if (operator === "is" || operator === "is not") {
    if (check === "set" || check === "not set") {
      return (check === "set") === (operator === "is") ? field : `not ${field}`;
    }
  }

  const isNumeric =
    fieldtype !== undefined && NUMERIC_FIELDTYPES.includes(fieldtype);

  // `like` is not a Python operator. The `field and` guard is what keeps a null
  // field out of the membership test, where it would raise rather than not match.
  //
  // A number cannot be the subject of one at all — `"1" in doc.qty` raises — and
  // there is nothing to coerce it with, since `safe_eval`'s whitelist is
  // int/float/long/round and holds no `str`. `Filter` offers `like` for the
  // numeric fieldtypes anyway, so this is reachable; the row compiles to nothing.
  if (operator === "like" || operator === "not like") {
    if (isNumeric) return "";
    // A pattern nobody has written is not a condition yet. `"" in doc.subject`
    // is True of every document that has a subject, so `like ""` would read as
    // "is set", and `not like ""` is False for every document and takes the
    // whole rule down with it. This is where a fresh text row starts, not an
    // edge case: `like` is `getDefaultOperator`'s answer for a Data field and
    // `defaultValueFor` seeds the empty string beside it.
    if (!isNamed(value)) return "";
    const membership = operator === "like" ? "in" : "not in";
    return `(${field} and ${quote(value)} ${membership} ${field})`;
  }

  // A numeric member has to go in unquoted or it matches nothing: the document
  // holds `100`, and `100 in ["100"]` is False. A member that is not a number
  // stays quoted rather than dropping the row — `in` compares by equality and
  // answers False across types instead of raising.
  if (operator === "in" || operator === "not in") {
    // A list naming no member is the same unusable value `between` refuses, and
    // it is what `defaultValueFor` seeds the moment the operator is picked: `in
    // []` is False for every document and `not in []` is True for every one, so
    // a row the user has not finished would fire the rule on all of them. A
    // blank member inside a list that does name others drops out with it, and
    // loses nothing — the `field and` guard already excludes the only documents
    // an empty member could have matched.
    const members = asList(value).filter(isNamed);
    if (members.length === 0) return "";
    const items = members.map((item) => literal(item, isNumeric)).join(", ");
    return `(${field} and ${field} ${operator} [${items}])`;
  }

  // `between` is two comparisons, and it answers for itself rather than falling
  // out of here: below is the unset-value rule, which compiles to the field's own
  // truthiness — so a range the picker cleared would quietly become "is set",
  // matching every document that has a date at all. It arrives as a `[from, to]`
  // pair from the range picker and as a comma string from a record written by
  // hand, and both ends are ordering comparisons, so both must be readable.
  if (operator === "between") {
    const range = asRange(value);
    if (!range) return "";
    const from = rangeEnd(range[0], isNumeric);
    const to = rangeEnd(range[1], isNumeric);
    return from !== null && to !== null
      ? `(${field} >= ${from} and ${field} <= ${to})`
      : "";
  }

  // An unset value is the field's own falsiness, since there is no literal to
  // compare against — `field == None` is not what an empty condition means.
  if (value === null || value === undefined) {
    return operator === "==" || operator === "is" ? `not ${field}` : field;
  }

  // Every rule that had one has run. What is left has to be an operator Python
  // spells the same way, or there is no expression for this row — `between` whose
  // value names only one end, `is` against something other than Set/Not Set, an
  // operator a host put in a leaf itself.
  if (!SCALAR_COMPARISONS.includes(operator)) return "";

  // A numeric field's value is a number in the document, so a quoted one raises
  // rather than compares: `doc.grand_total > "100"` is a TypeError, not False.
  // A value that cannot be read as one takes the row out entirely where the
  // comparison is an ordering, since the raise would lose every other condition
  // in the rule; `==`/`!=` are left to compile quoted and answer False.
  if (isNumeric) {
    const number = numeric(value);
    if (number !== null) return `${field} ${operator} ${number}`;
    if (ORDERING.includes(operator)) return "";
  }

  if (typeof value === "number") return `${field} ${operator} ${value}`;
  // Python's booleans, not JavaScript's: `true` is a NameError under `safe_eval`.
  if (typeof value === "boolean")
    return `${field} ${operator} ${value ? "True" : "False"}`;

  return `${field} ${operator} ${quote(value)}`;
}

/** The characters that cannot be written into a literal as themselves. */
const CONTROL = /[\u0000-\u001f\u007f]/g;
const NAMED_ESCAPE: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * A Python string literal. The backslash goes first, or it escapes the escapes.
 *
 * Control characters are escaped rather than written through: a newline inside
 * a literal ends it, so a Long Text value holding one would emit an expression
 * `safe_eval` cannot parse — and an unparseable rule matches nothing at all,
 * losing every other condition in the record along with this row.
 */
function quote(value: unknown): string {
  const escaped = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(
      CONTROL,
      (character) =>
        NAMED_ESCAPE[character] ??
        `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`
    );
  return `"${escaped}"`;
}

/** A value as a Python number, or null where it cannot be read as one. */
function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (text === "") return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** A list member, as the literal it compiles to. */
function literal(value: unknown, isNumeric: boolean): string {
  if (isNumeric) {
    const number = numeric(value);
    if (number !== null) return String(number);
  }
  return quote(value);
}

/** One end of a range, or null where an ordering comparison could not use it. */
function rangeEnd(value: unknown, isNumeric: boolean): string | null {
  if (!isNumeric) return quote(value);
  const number = numeric(value);
  return number === null ? null : String(number);
}

/** `in`'s operand: a list as it stands, a comma string as its parts. */
function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim());
  if (typeof value === "string")
    return value.split(",").map((item) => item.trim());
  return [value];
}

/**
 * `between`'s two ends, or null unless both are named. A pair is not enough:
 * `DateRangePicker.clearSelection()` leaves `[null, null]` and a half-used one
 * leaves an empty string, and neither is a bound — `due_date >= "null"` compares
 * against the four-letter word, and `>= ""` is true of every date there is.
 */
function asRange(value: unknown): [unknown, unknown] | null {
  const pair = asPair(value);
  return pair !== null && pair.every(isNamed) ? pair : null;
}

function asPair(value: unknown): [unknown, unknown] | null {
  if (Array.isArray(value))
    return value.length === 2 ? [value[0], value[1]] : null;
  if (typeof value !== "string" || !value.includes(",")) return null;
  const [from, to] = value.split(",").map((part) => part.trim());
  return [from, to];
}

function isNamed(end: unknown): boolean {
  return end !== null && end !== undefined && String(end).trim() !== "";
}

/**
 * Parse the interleaved array back into a tree. An entry this parser cannot
 * model — a doctype-qualified filter, an unlisted operator, a stray token — is
 * dropped, so a record holding one is edited without it and saved without it.
 *
 * **This read is lossy, and silently changes what a mixed record means.** The
 * stored array carries a token per gap and can therefore be mixed; a group
 * carries one token for the whole level and cannot. The first separator token
 * on a level wins and every later one is discarded, so a record stored as
 * `A and B or C` loads — and re-saves — as `A and B and C`. Nothing on screen
 * says so: the rule looks like the one the record holds, and the difference
 * only appears in what it matches. Frappe's own editors write uniform levels,
 * so this is reached by a record hand-edited, written by another tool, or
 * written by an earlier version of this component; it is the accepted cost of
 * one operator per group, not an oversight.
 */
export function fromFrappeConditions(
  conditions: unknown
): ConditionGroup<Leaf> {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return { conjunction: "and", conditions: [] };
  }

  const { items, separators } = foldEntries(conditions, frappeToNode);
  return { conjunction: separators[0] ?? "and", conditions: items };
}

/**
 * The separator tokens, case-insensitively. Frappe writes them lowercase, but a
 * record hand-edited or produced by another tool can carry `"OR"` — matched
 * here, since sending it down the operand path would invert the rule.
 */
function asConjunction(item: unknown): Conjunction | null {
  if (typeof item !== "string") return null;
  const token = item.trim().toLowerCase();
  return token === "and" || token === "or" ? token : null;
}

/** A node, or null for an entry this parser cannot model. */
function frappeToNode(item: unknown): Node | null {
  if (Array.isArray(item)) {
    // A new, still-empty group is persisted as `[]`; read it back as an empty group.
    if (item.length === 0) return { conjunction: "and", conditions: [] };

    // A group's first element is itself an array; a leaf's is a fieldname.
    if (Array.isArray(item[0])) return fromFrappeConditions(item);
  }

  if (Array.isArray(item) && item.length === 3 && typeof item[0] === "string") {
    const token = String(item[1]).toLowerCase();
    // `hasOwn`, not a bare index: a stored operator named `constructor` would
    // otherwise resolve through `Object.prototype` and pass the check below.
    const operator = Object.hasOwn(READ_OPERATOR, token)
      ? READ_OPERATOR[token]
      : undefined;
    if (operator) {
      return {
        fieldname: item[0],
        operator,
        value: item[2] as ConditionValue,
      };
    }
  }

  // Not a shape this parser can model: wrong length, doctype-qualified, an
  // unlisted operator, or not an array at all.
  return null;
}
