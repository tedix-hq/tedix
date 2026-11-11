import type { JsonValue } from "../schemas/common";
import type { OsOutputContent } from "../schemas/os-workspaces";
import {
	projectSheet,
	type OutputMergeOptions,
} from "@tedix/api-contract/utils/output-merge";

/**
 * The changed parts of a workspace file, so a save sends those and not the
 * whole file.
 *
 * A patch is a list of operations against the content of one known revision
 * (its base). Each operation names a part by a path from the content's root:
 *
 * - a string steps into an object by key (`"deck"`, `"workbook"`);
 * - `{ id }` steps into a list whose items carry ids, by that id: a slide, a
 *   slide element, a sheet tab, a column. Ids survive reordering, so the
 *   address stays right whatever else moved;
 * - a number steps into a list by position. Sheet rows and cells are
 *   addressed this way: `["workbook","sheets",{id},"rows",row,column]`.
 *
 * Operations:
 *
 * - `set` writes one part: a property, a cell, a whole item;
 * - `unset` removes a property;
 * - `arrange` gives a list of id-carrying items its new order and carries the
 *   items that are new; an item left out of the order is removed;
 * - `splice` replaces runs of a list without ids (a document's top-level
 *   blocks, a sheet's rows when rows were inserted or removed). Positions
 *   count in the base list; each run names where it starts, how many items it
 *   removes and the items that take their place.
 *
 * A document's blocks have no ids, and adding ids would change every stored
 * document and what older readers accept. They are addressed by position in
 * the base revision instead. The base is named by its revision number, which
 * identifies stored content exactly, so no digest is needed. When the file
 * has moved on since the base, the server does not replay positions against
 * newer content: it applies the patch to the base and merges the result with
 * the newer content (`mergeOutputContent`), where edits to different blocks,
 * slides, elements or cells all land and edits to the same part conflict.
 *
 * The plain copies kept next to a rich body (`blocks`, the flat sheet
 * `columns`/`rows`, the slide outline `slides`) are never sent: whoever
 * applies a patch rebuilds them from the body.
 */
export type OutputPatchSegment = string | number | { id: string };
export type OutputPatchPath = OutputPatchSegment[];
export type OutputPatchHunk = {
	at: number;
	remove: number;
	insert: JsonValue[];
};
export type OutputPatchOp =
	| { op: "set"; path: OutputPatchPath; value: JsonValue }
	| { op: "unset"; path: OutputPatchPath }
	| {
			op: "arrange";
			path: OutputPatchPath;
			order: string[];
			insert?: JsonValue[];
	  }
	| { op: "splice"; path: OutputPatchPath; hunks: OutputPatchHunk[] };
export type OutputPatchKind = "document" | "sheet" | "presentation";
export interface OutputPatch {
	kind: OutputPatchKind;
	ops: OutputPatchOp[];
}

/** A patch that cannot be applied to the content it was sent for. */
export class OutputPatchError extends Error {}

type Json = JsonValue | undefined;
type JsonObject = { [key: string]: JsonValue };

/** Object keys a path may never step through. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Runs longer than this many base × next items are sent as one run. */
const SEQUENCE_LIMIT = 250_000;

const isObject = (value: Json): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const idOf = (value: Json): string | undefined =>
	isObject(value) && typeof value.id === "string" ? value.id : undefined;

/** Deep equality of JSON values; a property set to `undefined` counts as absent. */
function equal(a: Json, b: Json): boolean {
	if (a === b) return true;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let index = 0; index < a.length; index++)
			if (!equal(a[index], b[index])) return false;
		return true;
	}
	if (isObject(a)) {
		if (!isObject(b)) return false;
		let count = 0;
		for (const key in a) {
			if (a[key] === undefined) continue;
			count++;
			if (!equal(a[key], b[key])) return false;
		}
		for (const key in b) if (b[key] !== undefined) count--;
		return count === 0;
	}
	return false;
}

/** The copies rebuilt from the body `content` carries, so never sent. */
function derivedKeys(content: OsOutputContent): string[] {
	if (content.kind === "document" && content.richText) return ["blocks"];
	if (content.kind === "sheet" && content.workbook) return ["columns", "rows"];
	if (content.kind === "presentation" && content.deck) return ["slides"];
	return [];
}

/**
 * The operations that turn `base` into `next`, or null when nothing a save
 * stores differs. Neither content is changed.
 */
export function diffOutputContent(
	base: OsOutputContent,
	next: OsOutputContent,
): OutputPatch | null {
	if (base.kind !== next.kind || next.kind === "video")
		throw new OutputPatchError("Only content of the same kind can be compared");
	const derived = derivedKeys(next);
	const ops: OutputPatchOp[] = [];
	const from = base as unknown as JsonObject;
	const to = next as unknown as JsonObject;
	for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
		if (key === "kind" || derived.includes(key)) continue;
		diff(from[key], to[key], [key], ops);
	}
	return ops.length > 0 ? { kind: next.kind, ops } : null;
}

function diff(
	base: Json,
	next: Json,
	path: OutputPatchPath,
	ops: OutputPatchOp[],
): void {
	if (equal(base, next)) return;
	if (next === undefined) {
		ops.push({ op: "unset", path });
		return;
	}
	if (isObject(base) && isObject(next)) {
		for (const key of new Set([...Object.keys(base), ...Object.keys(next)]))
			diff(base[key], next[key], [...path, key], ops);
		return;
	}
	if (Array.isArray(base) && Array.isArray(next))
		return diffList(base, next, path, ops);
	ops.push({ op: "set", path, value: next });
}

function diffList(
	base: JsonValue[],
	next: JsonValue[],
	path: OutputPatchPath,
	ops: OutputPatchOp[],
): void {
	const baseIds = base.map(idOf);
	const nextIds = next.map(idOf);
	if (
		base.length + next.length > 0 &&
		baseIds.every((id) => id !== undefined) &&
		nextIds.every((id) => id !== undefined)
	) {
		const known = new Map(base.map((item, index) => [baseIds[index]!, item]));
		if (known.size !== base.length || new Set(nextIds).size !== next.length) {
			// Duplicate ids cannot be addressed one by one.
			ops.push({ op: "set", path, value: next });
			return;
		}
		// Items both lists hold are compared first, while their ids resolve.
		for (const [index, item] of next.entries()) {
			const id = nextIds[index]!;
			if (known.has(id)) diff(known.get(id), item, [...path, { id }], ops);
		}
		if (
			base.length !== next.length ||
			baseIds.some((id, index) => id !== nextIds[index])
		) {
			const insert = next.filter((_, index) => !known.has(nextIds[index]!));
			ops.push({
				op: "arrange",
				path,
				order: nextIds as string[],
				...(insert.length > 0 ? { insert } : {}),
			});
		}
		return;
	}
	// A grid keeps its positions: the same cell is the same index. Typed nodes
	// (document blocks) can shift, so they compare as a sequence.
	const typed = (item: JsonValue) => isObject(item) && "type" in item;
	if (base.length === next.length && !base.some(typed) && !next.some(typed)) {
		for (let index = 0; index < base.length; index++)
			diff(base[index], next[index], [...path, index], ops);
		return;
	}
	const hunks = sequenceHunks(base, next);
	if (hunks.length > 0) ops.push({ op: "splice", path, hunks });
}

/** The runs that turn `base` into `next`, with positions in `base`. */
function sequenceHunks(
	base: JsonValue[],
	next: JsonValue[],
): OutputPatchHunk[] {
	let start = 0;
	const shortest = Math.min(base.length, next.length);
	while (start < shortest && equal(base[start], next[start])) start++;
	let baseEnd = base.length;
	let nextEnd = next.length;
	while (
		baseEnd > start &&
		nextEnd > start &&
		equal(base[baseEnd - 1], next[nextEnd - 1])
	) {
		baseEnd--;
		nextEnd--;
	}
	if (baseEnd === start && nextEnd === start) return [];
	const a = base.slice(start, baseEnd);
	const b = next.slice(start, nextEnd);
	if (a.length === 0 || b.length === 0 || a.length * b.length > SEQUENCE_LIMIT)
		return [{ at: start, remove: a.length, insert: b }];
	// Longest common subsequence over the part that differs.
	const keyA = a.map((item) => JSON.stringify(item));
	const keyB = b.map((item) => JSON.stringify(item));
	const table = Array.from(
		{ length: a.length + 1 },
		() => new Uint32Array(b.length + 1),
	);
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			table[i]![j] =
				keyA[i] === keyB[j]
					? table[i + 1]![j + 1]! + 1
					: Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
	const hunks: OutputPatchHunk[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && keyA[i] === keyB[j]) {
			i++;
			j++;
			continue;
		}
		const at = i;
		const insert: JsonValue[] = [];
		while (i < a.length || j < b.length) {
			if (i < a.length && j < b.length && keyA[i] === keyB[j]) break;
			if (
				j < b.length &&
				(i === a.length || table[i]![j + 1]! > table[i + 1]![j]!)
			)
				insert.push(b[j++]!);
			else i++;
		}
		hunks.push({ at: start + at, remove: i - at, insert });
	}
	return hunks;
}

const show = (path: OutputPatchPath) =>
	"/" +
	path
		.map((segment) => (typeof segment === "object" ? segment.id : segment))
		.join("/");

/** Rewrite the part at `path`, copying only the containers on the way to it. */
function update(
	node: Json,
	path: OutputPatchPath,
	depth: number,
	change: (target: Json) => Json,
	whole: OutputPatchPath,
): Json {
	if (depth === path.length) return change(node);
	const segment = path[depth]!;
	const missing = () =>
		new OutputPatchError(
			`The file has no part ${show(whole.slice(0, depth + 1))}`,
		);
	if (typeof segment === "string") {
		if (FORBIDDEN_KEYS.has(segment) || !isObject(node)) throw missing();
		const last = depth === path.length - 1;
		if (!last && !Object.hasOwn(node, segment)) throw missing();
		const value = update(
			Object.hasOwn(node, segment) ? node[segment] : undefined,
			path,
			depth + 1,
			change,
			whole,
		);
		const copy: JsonObject = { ...node };
		if (value === undefined) delete copy[segment];
		else copy[segment] = value;
		return copy;
	}
	if (!Array.isArray(node)) throw missing();
	const index =
		typeof segment === "number"
			? segment
			: node.findIndex((item) => idOf(item) === segment.id);
	if (!Number.isInteger(index) || index < 0 || index >= node.length)
		throw missing();
	const value = update(node[index], path, depth + 1, change, whole);
	if (value === undefined)
		throw new OutputPatchError(
			`A list item cannot be unset: ${show(whole)}; arrange or splice the list`,
		);
	const copy = [...node];
	copy[index] = value;
	return copy;
}

function applyOp(root: Json, op: OutputPatchOp): Json {
	if (op.path.length === 0)
		throw new OutputPatchError("A patch cannot replace the whole file");
	const first = op.path[0];
	if (first === "kind")
		throw new OutputPatchError("A patch cannot change the kind of a file");
	const at = show(op.path);
	switch (op.op) {
		case "set":
			return update(root, op.path, 0, () => op.value, op.path);
		case "unset":
			if (typeof op.path[op.path.length - 1] !== "string")
				throw new OutputPatchError(`Only a property can be unset: ${at}`);
			return update(root, op.path, 0, () => undefined, op.path);
		case "arrange":
			return update(
				root,
				op.path,
				0,
				(target) => {
					if (!Array.isArray(target))
						throw new OutputPatchError(`${at} is not a list`);
					const items = new Map<string, JsonValue>();
					for (const item of target) {
						const id = idOf(item);
						if (id === undefined)
							throw new OutputPatchError(`${at} holds items without ids`);
						items.set(id, item);
					}
					for (const item of op.insert ?? []) {
						const id = idOf(item);
						if (id === undefined || items.has(id))
							throw new OutputPatchError(
								`${at}: a new item needs an id the list does not hold yet`,
							);
						items.set(id, item);
					}
					if (new Set(op.order).size !== op.order.length)
						throw new OutputPatchError(`${at}: the order repeats an id`);
					return op.order.map((id) => {
						const item = items.get(id);
						if (item === undefined)
							throw new OutputPatchError(`${at} has no item ${id}`);
						return item;
					});
				},
				op.path,
			);
		case "splice":
			return update(
				root,
				op.path,
				0,
				(target) => {
					if (!Array.isArray(target))
						throw new OutputPatchError(`${at} is not a list`);
					const result: JsonValue[] = [];
					let cursor = 0;
					for (const hunk of op.hunks) {
						if (
							!Number.isInteger(hunk.at) ||
							!Number.isInteger(hunk.remove) ||
							hunk.at < cursor ||
							hunk.remove < 0 ||
							hunk.at + hunk.remove > target.length
						)
							throw new OutputPatchError(
								`${at}: a changed run does not fit the list it was made for`,
							);
						for (let index = cursor; index < hunk.at; index++)
							result.push(target[index]!);
						for (const item of hunk.insert) result.push(item);
						cursor = hunk.at + hunk.remove;
					}
					for (let index = cursor; index < target.length; index++)
						result.push(target[index]!);
					return result;
				},
				op.path,
			);
	}
}

/**
 * Apply a patch to the content it was made against and rebuild the plain
 * copies next to a rich body. The content passed in is not changed; parts the
 * patch does not touch are shared with it. Throws `OutputPatchError` when the
 * patch does not fit the content. The result is not checked against the
 * content schema: a caller that stores it does that.
 */
export function applyOutputPatch<T extends OsOutputContent>(
	content: T,
	patch: OutputPatch,
	options: Pick<
		OutputMergeOptions,
		"documentBlocks" | "presentationSlides"
	> = {},
): T {
	if (content.kind !== patch.kind)
		throw new OutputPatchError(
			`The patch is for a ${patch.kind} but the file is a ${content.kind}`,
		);
	let next = content as unknown as Json;
	for (const op of patch.ops) next = applyOp(next, op);
	return projectOutputContent(next as unknown as T, options);
}

/** Rebuild the plain copies kept next to a rich body. */
export function projectOutputContent<T extends OsOutputContent>(
	content: T,
	options: Pick<OutputMergeOptions, "documentBlocks" | "presentationSlides">,
): T {
	if (content.kind === "document" && content.richText && options.documentBlocks)
		return { ...content, blocks: options.documentBlocks(content.richText) };
	if (content.kind === "sheet" && content.workbook)
		return { ...content, ...projectSheet(content.workbook) };
	if (
		content.kind === "presentation" &&
		content.deck &&
		options.presentationSlides
	)
		return { ...content, slides: options.presentationSlides(content.deck) };
	return content;
}

/** The parts a patch touches, as short paths; for messages and logs. */
export function outputPatchParts(patch: OutputPatch): string[] {
	return [...new Set(patch.ops.map((op) => show(op.path)))];
}
