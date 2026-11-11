/**
 * Per-user undo for structured editors that share one collab room.
 *
 * The room syncs one JSON text, so text OT cannot invert a structured edit
 * safely: an inverse text change would be meaningful only against the exact
 * serialization it came from. A history step instead records what this user
 * changed as path patches (before -> after), and undo writes `before` back
 * only where the shared value still equals `after`. A colleague's edit to
 * another element, cell or field is never touched; a colleague's edit to the
 * same path is a conflict that undo skips and reports.
 *
 * Paths address arrays of `{ id }` objects (slides, elements, sheets) by id,
 * so a step survives a colleague inserting or reordering items around it.
 * Other arrays (sheet rows and cells) are positional.
 */

export type PathSegment = string | number | { id: string };
export type EditorPath = PathSegment[];

/** A path the history should neither record nor compare (derived data). */
export type IgnorePath = (path: EditorPath) => boolean;

type Json = unknown;
type IdItem = { id: string };

export type EditorPatch =
	| { kind: "set"; path: EditorPath; before: Json; after: Json }
	/** Membership and order of an id-keyed array; item contents diff separately. */
	| { kind: "list"; path: EditorPath; before: IdItem[]; after: IdItem[] };

export interface ApplyResult<T> {
	value: T;
	applied: number;
	conflicts: EditorPath[];
}

const isObject = (value: Json): value is Record<string, Json> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The array as `{ id }` items, or null when it is positional. Empty counts as both. */
function idList(value: Json): IdItem[] | null {
	if (!Array.isArray(value)) return null;
	const seen = new Set<string>();
	for (const item of value) {
		if (!isObject(item) || typeof item.id !== "string" || seen.has(item.id))
			return null;
		seen.add(item.id);
	}
	return value as IdItem[];
}

export const pathKey = (path: EditorPath) => JSON.stringify(path);

function sameIds(a: readonly IdItem[], b: readonly IdItem[]) {
	return a.length === b.length && a.every((item, i) => item.id === b[i]!.id);
}

/** Deep equality that skips every path `ignore` names. */
export function equalAt(
	a: Json,
	b: Json,
	path: EditorPath = [],
	ignore: IgnorePath = () => false,
): boolean {
	if (ignore(path)) return true;
	if (a === b) return true;
	const aIds = idList(a);
	const bIds = idList(b);
	if (aIds && bIds) {
		return (
			sameIds(aIds, bIds) &&
			aIds.every((item, i) =>
				equalAt(item, bIds[i], [...path, { id: item.id }], ignore),
			)
		);
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return (
			a.length === b.length &&
			a.every((item, i) => equalAt(item, b[i], [...path, i], ignore))
		);
	}
	if (isObject(a) && isObject(b)) {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const key of keys)
			if (!equalAt(a[key], b[key], [...path, key], ignore)) return false;
		return true;
	}
	return false;
}

/** The patches that turn `before` into `after`, skipping ignored paths. */
export function diffValues(
	before: Json,
	after: Json,
	ignore: IgnorePath = () => false,
	path: EditorPath = [],
): EditorPatch[] {
	if (ignore(path) || before === after) return [];
	const beforeIds = idList(before);
	const afterIds = idList(after);
	if (beforeIds && afterIds) {
		const patches: EditorPatch[] = sameIds(beforeIds, afterIds)
			? []
			: [{ kind: "list", path, before: beforeIds, after: afterIds }];
		const afterById = new Map(afterIds.map((item) => [item.id, item]));
		for (const item of beforeIds) {
			const next = afterById.get(item.id);
			if (next)
				patches.push(
					...diffValues(item, next, ignore, [...path, { id: item.id }]),
				);
		}
		return patches;
	}
	if (
		Array.isArray(before) &&
		Array.isArray(after) &&
		before.length === after.length
	) {
		return before.flatMap((item, i) =>
			diffValues(item, after[i], ignore, [...path, i]),
		);
	}
	if (isObject(before) && isObject(after)) {
		const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
		return [...keys].flatMap((key) =>
			diffValues(before[key], after[key], ignore, [...path, key]),
		);
	}
	return equalAt(before, after, path, ignore)
		? []
		: [{ kind: "set", path, before, after }];
}

function childOf(parent: Json, segment: PathSegment): Json {
	if (typeof segment === "object")
		return Array.isArray(parent)
			? parent.find((item) => isObject(item) && item.id === segment.id)
			: undefined;
	if (typeof segment === "number")
		return Array.isArray(parent) ? parent[segment] : undefined;
	return isObject(parent) ? parent[segment] : undefined;
}

/** Reads `path`; `found` is false when an ancestor no longer exists. */
function read(root: Json, path: EditorPath): { found: boolean; value: Json } {
	let current = root;
	for (const segment of path) {
		// An absent object key is a value (undefined); a missing parent, item
		// or cell means the path no longer exists.
		if (
			typeof segment === "string" ? !isObject(current) : !Array.isArray(current)
		)
			return { found: false, value: undefined };
		current = childOf(current, segment);
		if (current === undefined && typeof segment !== "string")
			return { found: false, value: undefined };
	}
	return { found: true, value: current };
}

/** Copy-on-write update of `path`; `undefined` deletes an object key. */
function write(root: Json, path: EditorPath, value: Json): Json {
	if (path.length === 0) return value;
	const [segment, ...rest] = path;
	if (typeof segment === "string") {
		const object = root as Record<string, Json>;
		const child = write(object[segment], rest, value);
		const next = { ...object };
		if (child === undefined) delete next[segment];
		else next[segment] = child;
		return next;
	}
	const array = root as Json[];
	const index =
		typeof segment === "number"
			? segment
			: array.findIndex((item) => isObject(item) && item.id === segment!.id);
	return array.map((item, i) =>
		i === index ? write(item, rest, value) : item,
	);
}

/** Moves a list from `from` to `to` membership and order where `current` allows. */
function applyList(
	current: IdItem[],
	from: IdItem[],
	to: IdItem[],
	path: EditorPath,
	ignore: IgnorePath,
): { list: IdItem[]; conflict: boolean } {
	let list = [...current];
	let conflict = false;
	const fromIds = new Set(from.map((item) => item.id));
	const toIds = new Set(to.map((item) => item.id));
	// Order of the items both sides keep.
	const fromOrder = from.filter((item) => toIds.has(item.id)).map((i) => i.id);
	const toOrder = to.filter((item) => fromIds.has(item.id)).map((i) => i.id);
	if (fromOrder.join("\0") !== toOrder.join("\0")) {
		const kept = new Set(fromOrder);
		const currentOrder = list.filter((i) => kept.has(i.id)).map((i) => i.id);
		const expected = fromOrder.filter((id) => currentOrder.includes(id));
		if (currentOrder.join("\0") === expected.join("\0")) {
			const byId = new Map(list.map((item) => [item.id, item]));
			const ordered = toOrder.filter((id) => byId.has(id));
			let next = 0;
			list = list.map((item) =>
				kept.has(item.id) ? byId.get(ordered[next++]!)! : item,
			);
		} else conflict = true;
	}
	// Items the step added: remove them unless someone changed them since.
	for (const item of from) {
		if (toIds.has(item.id)) continue;
		const present = list.find((candidate) => candidate.id === item.id);
		if (!present) continue;
		if (equalAt(present, item, [...path, { id: item.id }], ignore))
			list = list.filter((candidate) => candidate.id !== item.id);
		else conflict = true;
	}
	// Items the step removed: put them back next to their old neighbours.
	to.forEach((item, index) => {
		if (fromIds.has(item.id) || list.some((c) => c.id === item.id)) return;
		const before = to
			.slice(0, index)
			.reverse()
			.find((n) => list.some((c) => c.id === n.id));
		const after = to
			.slice(index + 1)
			.find((n) => list.some((c) => c.id === n.id));
		const at = before
			? list.findIndex((c) => c.id === before.id) + 1
			: after
				? list.findIndex((c) => c.id === after.id)
				: list.length;
		list.splice(at, 0, item);
	});
	return { list, conflict };
}

/**
 * Applies `patches` in the given direction to the CURRENT shared value: each
 * path moves from its recorded `from` side to its `to` side only where the
 * current value still equals `from` (or already equals `to`).
 */
export function applyPatches<T>(
	current: T,
	patches: readonly EditorPatch[],
	direction: "undo" | "redo",
	ignore: IgnorePath = () => false,
): ApplyResult<T> {
	let value: Json = current;
	let applied = 0;
	const conflicts: EditorPath[] = [];
	const ordered = direction === "undo" ? [...patches].reverse() : patches;
	for (const patch of ordered) {
		const from = direction === "undo" ? patch.after : patch.before;
		const to = direction === "undo" ? patch.before : patch.after;
		const at = read(value, patch.path);
		if (!at.found) {
			conflicts.push(patch.path);
			continue;
		}
		if (patch.kind === "list") {
			const list = idList(at.value);
			if (!list) {
				conflicts.push(patch.path);
				continue;
			}
			const result = applyList(
				list,
				from as IdItem[],
				to as IdItem[],
				patch.path,
				ignore,
			);
			if (result.conflict) conflicts.push(patch.path);
			if (!equalAt(result.list, list)) {
				value = write(value, patch.path, result.list);
				applied++;
			}
			continue;
		}
		if (equalAt(at.value, to, patch.path, ignore)) continue;
		if (!equalAt(at.value, from, patch.path, ignore)) {
			conflicts.push(patch.path);
			continue;
		}
		value = write(value, patch.path, to);
		applied++;
	}
	return { value: value as T, applied, conflicts };
}

const isPrefix = (prefix: EditorPath, path: EditorPath) =>
	prefix.length <= path.length &&
	prefix.every((segment, i) => pathKey([segment]) === pathKey([path[i]!]));

/**
 * Folds `next` into `step` when every path it touches lies inside a path the
 * step already records, which is what typing into one field does. Returns
 * null when the edit belongs in a new step.
 */
export function coalescePatches(
	step: readonly EditorPatch[],
	next: readonly EditorPatch[],
	nextValue: Json,
): EditorPatch[] | null {
	// Structural edits (add, delete, reorder) are discrete actions, never typing.
	if (next.some((patch) => patch.kind === "list")) return null;
	const owners = next.map((patch) =>
		step.find((owner) => isPrefix(owner.path, patch.path)),
	);
	if (owners.some((owner) => owner?.kind !== "set")) return null;
	return step.map((owner) =>
		owner.kind === "set" && owners.includes(owner)
			? { ...owner, after: read(nextValue, owner.path).value }
			: owner,
	);
}

/** The notice shown when undo or redo skipped a collaborator's edit. */
export function describeConflicts(
	paths: readonly EditorPath[],
	direction: "undo" | "redo",
): string {
	const action = direction === "undo" ? "Undo" : "Redo";
	return paths.length === 1
		? `${action} skipped 1 change a collaborator has since edited.`
		: `${action} skipped ${paths.length} changes collaborators have since edited.`;
}
