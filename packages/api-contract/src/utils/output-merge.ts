import type { JsonValue } from "../schemas/common";
import type { OsOutputContent, OsWorkbook } from "../schemas/os-workspaces";
import { blocksFromRichText } from "./os-document";
import { projectPresentationDeck } from "./presentation-patch";

/**
 * Three-way merge of two saves made from the same output revision.
 *
 * `base` is the revision both people started from, `mine` the save that
 * arrived second and `theirs` the revision already stored. Edits to different
 * parts both land: different cells, slides, slide elements or paragraphs.
 * Two different changes to the same part are a conflict, reported by path,
 * and the caller keeps today's "a newer revision exists" answer.
 *
 * Objects merge key by key. Lists whose items all carry an `id` (sheets,
 * columns, slides, slide elements) merge by id, so a reorder on one side and
 * an edit on the other both survive. Other lists (sheet rows, document
 * paragraphs) merge as sequences: inserts and deletes in different places both
 * apply, and an item both sides changed in place merges recursively.
 */
export type OutputMergeResult =
	| { ok: true; content: OsOutputContent }
	| { ok: false; conflicts: string[] };

/** Keys that record what one viewer had open, never content worth a conflict. */
const VIEW_STATE_KEYS = new Set(["activeSheetId", "activeSlideId"]);
/** Sequence merges beyond this many base × side items stay conflicts. */
const SEQUENCE_LIMIT = 1_000_000;

type Json = JsonValue | undefined;
type Hunk = { start: number; end: number; items: Json[] };

export function mergeOutputContent(
	base: OsOutputContent,
	mine: OsOutputContent,
	theirs: OsOutputContent,
): OutputMergeResult {
	if (
		base.kind !== mine.kind ||
		base.kind !== theirs.kind ||
		base.kind === "video"
	)
		return { ok: false, conflicts: ["kind"] };
	const derived = derivedKeys(base, mine, theirs);
	const strip = (content: OsOutputContent) =>
		Object.fromEntries(
			Object.entries(content).filter(([key]) => !derived.includes(key)),
		) as unknown as Json;
	const conflicts: string[] = [];
	const merged = merge(strip(base), strip(mine), strip(theirs), "", conflicts);
	if (conflicts.length > 0) return { ok: false, conflicts };
	return { ok: true, content: project(merged as OsOutputContent) };
}

/**
 * Fields recomputed from the canonical body. Merging them as well would turn
 * every pair of edits into a conflict on the projection.
 */
function derivedKeys(...contents: OsOutputContent[]): string[] {
	if (contents.every((c) => c.kind === "document" && c.richText))
		return ["blocks"];
	if (contents.every((c) => c.kind === "sheet" && c.workbook))
		return ["columns", "rows"];
	if (contents.every((c) => c.kind === "presentation" && c.deck))
		return ["slides"];
	return [];
}

function project(content: OsOutputContent): OsOutputContent {
	if (content.kind === "document" && content.richText)
		return { ...content, blocks: blocksFromRichText(content.richText) };
	if (content.kind === "sheet" && content.workbook)
		return { ...content, ...projectSheet(content.workbook) };
	if (content.kind === "presentation" && content.deck)
		return { ...content, slides: projectPresentationDeck(content.deck) };
	return content;
}

function projectSheet(workbook: OsWorkbook) {
	const active =
		workbook.sheets.find((sheet) => sheet.id === workbook.activeSheetId) ??
		workbook.sheets[0]!;
	return {
		columns: active.columns.map((column) => column.label),
		rows: active.rows.map((row) =>
			active.columns.map((_, index) => row[index]?.value ?? null),
		),
	};
}

function key(value: Json): string {
	return value === undefined ? "\u0000" : JSON.stringify(value);
}

function same(a: Json, b: Json): boolean {
	return a === b || key(a) === key(b);
}

function isObject(value: Json): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(
	base: Json,
	mine: Json,
	theirs: Json,
	path: string,
	conflicts: string[],
): Json {
	if (same(mine, theirs) || same(base, theirs)) return mine;
	if (same(base, mine)) return theirs;
	if (isObject(base) && isObject(mine) && isObject(theirs))
		return mergeObject(base, mine, theirs, path, conflicts);
	if (Array.isArray(base) && Array.isArray(mine) && Array.isArray(theirs))
		return mergeList(base, mine, theirs, path, conflicts);
	conflicts.push(path || "/");
	return theirs;
}

function mergeObject(
	base: { [key: string]: JsonValue },
	mine: { [key: string]: JsonValue },
	theirs: { [key: string]: JsonValue },
	path: string,
	conflicts: string[],
): Json {
	const result: { [key: string]: JsonValue } = {};
	for (const name of new Set([
		...Object.keys(theirs),
		...Object.keys(mine),
		...Object.keys(base),
	])) {
		// A cell's cached value follows whichever side changed its input.
		const cached = name === "value" && "input" in base;
		const value =
			VIEW_STATE_KEYS.has(name) || cached
				? mergeLoose(base, mine, theirs, name)
				: merge(
						base[name],
						mine[name],
						theirs[name],
						`${path}/${name}`,
						conflicts,
					);
		if (value !== undefined) result[name] = value;
	}
	return result;
}

function mergeLoose(
	base: { [key: string]: JsonValue },
	mine: { [key: string]: JsonValue },
	theirs: { [key: string]: JsonValue },
	name: string,
): Json {
	if (name === "value")
		return same(base.input, mine.input) ? theirs.value : mine.value;
	return same(base[name], mine[name]) ? theirs[name] : mine[name];
}

function idOf(value: Json): string | undefined {
	return isObject(value) && typeof value.id === "string" ? value.id : undefined;
}

function mergeList(
	base: JsonValue[],
	mine: JsonValue[],
	theirs: JsonValue[],
	path: string,
	conflicts: string[],
): Json {
	const lists = [base, mine, theirs];
	if (
		lists.some((list) => list.length > 0) &&
		lists.every((list) => list.every((item) => idOf(item)))
	)
		return mergeById(base, mine, theirs, path, conflicts);
	// A grid row or a row of cells keeps its positions: the same cell is the
	// same index. Typed nodes (document paragraphs) can shift, so they diff.
	if (
		base.length === mine.length &&
		base.length === theirs.length &&
		!lists.some((list) => list.some((item) => isObject(item) && "type" in item))
	)
		return base.map(
			(item, index) =>
				merge(
					item,
					mine[index],
					theirs[index],
					`${path}/${index}`,
					conflicts,
				) ?? null,
		);
	return mergeSequence(base, mine, theirs, path, conflicts);
}

function mergeById(
	base: JsonValue[],
	mine: JsonValue[],
	theirs: JsonValue[],
	path: string,
	conflicts: string[],
): Json {
	const byId = (list: JsonValue[]) =>
		new Map(list.map((item) => [idOf(item)!, item]));
	const [b, m, t] = [byId(base), byId(mine), byId(theirs)];
	if (
		b.size !== base.length ||
		m.size !== mine.length ||
		t.size !== theirs.length
	) {
		conflicts.push(`${path}/(duplicate ids)`);
		return theirs;
	}
	// Removing an item the other side edited would silently drop that edit.
	for (const [id, original] of b) {
		const kept = m.get(id) ?? t.get(id);
		if (!m.has(id) !== !t.has(id) && kept && !same(original, kept))
			conflicts.push(`${path}/${id}`);
	}
	const order = mergeSequence(
		base.map(idOf) as string[],
		mine.map(idOf) as string[],
		theirs.map(idOf) as string[],
		`${path}/(order)`,
		conflicts,
		false,
	) as string[];
	return order.map(
		(id) =>
			merge(
				b.get(id),
				m.get(id),
				t.get(id),
				`${path}/${id}`,
				conflicts,
			) as JsonValue,
	);
}

/** The changed ranges that turn `base` into `next`, by longest common subsequence. */
function hunks(base: JsonValue[], next: JsonValue[]): Hunk[] | null {
	if (base.length * next.length > SEQUENCE_LIMIT) return null;
	const a = base.map(key);
	const b = next.map(key);
	const table = Array.from(
		{ length: a.length + 1 },
		() => new Uint32Array(b.length + 1),
	);
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			table[i]![j] =
				a[i] === b[j]
					? table[i + 1]![j + 1]! + 1
					: Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
	const result: Hunk[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			i++;
			j++;
			continue;
		}
		const start = i;
		const items: Json[] = [];
		while (i < a.length || j < b.length) {
			if (i < a.length && j < b.length && a[i] === b[j]) break;
			// On a tie, delete before inserting, so a changed item reads as a
			// replacement in place rather than an insert next to a removal.
			if (
				j < b.length &&
				(i === a.length || table[i]![j + 1]! > table[i + 1]![j]!)
			)
				items.push(next[j++]);
			else i++;
		}
		result.push({ start, end: i, items });
	}
	return result;
}

function mergeSequence(
	base: JsonValue[],
	mine: JsonValue[],
	theirs: JsonValue[],
	path: string,
	conflicts: string[],
	recurse = true,
): Json {
	const left = hunks(base, mine);
	const right = hunks(base, theirs);
	if (!left || !right) {
		conflicts.push(`${path}/(too large)`);
		return theirs;
	}
	const touches = (x: Hunk, y: Hunk) =>
		Math.max(x.start, y.start) < Math.min(x.end, y.end) ||
		x.start === y.start ||
		(x.start === x.end && x.start > y.start && x.start < y.end) ||
		(y.start === y.end && y.start > x.start && y.start < x.end);
	const applied: Hunk[] = [...left];
	for (const change of right) {
		const clash = left.find((edit) => touches(edit, change));
		if (!clash) {
			applied.push(change);
			continue;
		}
		const index = applied.indexOf(clash);
		if (
			same(clash.items as JsonValue[], change.items as JsonValue[]) &&
			clash.end === change.end
		)
			continue;
		// Both sides only added items at the same spot: keep theirs, then mine.
		if (
			clash.start === clash.end &&
			change.start === change.end &&
			clash.start === change.start
		) {
			applied[index] = { ...clash, items: [...change.items, ...clash.items] };
			continue;
		}
		// Both sides rewrote the same single item, perhaps adding items right
		// after it: merge inside the item and keep both sides' additions.
		if (
			recurse &&
			clash.start === change.start &&
			clash.end === clash.start + 1 &&
			change.end === change.start + 1 &&
			clash.items.length >= 1 &&
			change.items.length >= 1
		) {
			applied[index] = {
				...clash,
				items: [
					merge(
						base[clash.start],
						clash.items[0],
						change.items[0],
						`${path}/${clash.start}`,
						conflicts,
					),
					...change.items.slice(1),
					...clash.items.slice(1),
				],
			};
			continue;
		}
		conflicts.push(`${path}/${change.start}`);
	}
	applied.sort((x, y) => x.start - y.start || x.end - y.end);
	const result: JsonValue[] = [];
	let cursor = 0;
	for (const edit of applied) {
		result.push(...base.slice(cursor, edit.start));
		result.push(...(edit.items as JsonValue[]));
		cursor = Math.max(cursor, edit.end);
	}
	result.push(...base.slice(cursor));
	return result;
}
