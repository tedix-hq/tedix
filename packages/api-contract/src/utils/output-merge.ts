import type { JsonValue } from "../schemas/common";
import type {
	OsDocumentBlock,
	OsOutputContent,
	OsPresentationDeck,
	OsPresentationSlide,
	OsRichTextDocument,
	OsWorkbook,
} from "../schemas/os-workspaces";

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
 *
 * The text of one paragraph merges word by word: two people who changed
 * different words of it both keep their change, formatting included. It is a
 * conflict only where both changed the same words or typed at the same spot.
 */
export type OutputMergeResult =
	| { ok: true; content: OsOutputContent; conflicts: string[] }
	| { ok: false; conflicts: string[] };

/**
 * Who wins where both changed the same part. Without it a conflict fails the
 * merge; with it the merge succeeds, still listing what was overridden.
 */
export type OutputMergePreference = "mine" | "theirs";

/**
 * How to rebuild the simpler copies kept next to a rich body. Each caller
 * passes the functions it already loads, so a small editor bundle does not pull
 * in parsers it never uses. Without a function, that copy merges as is.
 */
export interface OutputMergeOptions {
	prefer?: OutputMergePreference;
	documentBlocks?: (richText: OsRichTextDocument) => OsDocumentBlock[];
	presentationSlides?: (deck: OsPresentationDeck) => OsPresentationSlide[];
}

/** Conflict paths found so far, and which side resolves them. */
type Conflicts = string[] & { prefer?: OutputMergePreference };

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
	options: OutputMergeOptions = {},
): OutputMergeResult {
	const { prefer } = options;
	if (
		base.kind !== mine.kind ||
		base.kind !== theirs.kind ||
		base.kind === "video"
	)
		return { ok: false, conflicts: ["kind"] };
	const derived = derivedKeys(options, base, mine, theirs);
	const strip = (content: OsOutputContent) =>
		Object.fromEntries(
			Object.entries(content).filter(([key]) => !derived.includes(key)),
		) as unknown as Json;
	const conflicts: Conflicts = Object.assign([], { prefer });
	const [from, left, right] = alignGrids(base, mine, theirs);
	const merged = merge(strip(from), strip(left), strip(right), "", conflicts);
	if (conflicts.length > 0 && !prefer) return { ok: false, conflicts };
	return {
		ok: true,
		content: project(merged as OsOutputContent, options),
		conflicts: [...conflicts],
	};
}

type Row = OsWorkbook["sheets"][number]["rows"][number];
type Grid = OsWorkbook["sheets"][number];

/**
 * Line up sheets that grew at their edges. A sheet has no fixed size: typing
 * below the last row or right of the last column adds rows and columns to
 * reach that cell. When two people do that, their new rows and columns are
 * the same grid positions, not separate additions to keep one after the
 * other. Where both only edited cells in place and added at the edges, all
 * three copies are filled out to one size, so each cell merges with the cell
 * at the same position. A sheet only one of them grew, or where either side
 * inserted, deleted or moved rows or columns, is left as it is and merges as
 * a sequence.
 */
function alignGrids(
	base: OsOutputContent,
	mine: OsOutputContent,
	theirs: OsOutputContent,
): [OsOutputContent, OsOutputContent, OsOutputContent] {
	if (
		base.kind !== "sheet" ||
		mine.kind !== "sheet" ||
		theirs.kind !== "sheet" ||
		!base.workbook ||
		!mine.workbook ||
		!theirs.workbook
	)
		return [base, mine, theirs];
	const aligned = new Map<string, [Grid, Grid, Grid]>();
	for (const from of base.workbook.sheets) {
		const left = mine.workbook.sheets.find((sheet) => sheet.id === from.id);
		const right = theirs.workbook.sheets.find((sheet) => sheet.id === from.id);
		const grids = left && right && alignGrid(from, left, right);
		if (grids) aligned.set(from.id, grids);
	}
	if (aligned.size === 0) return [base, mine, theirs];
	const use = (content: typeof base, side: 0 | 1 | 2) => ({
		...content,
		workbook: {
			...content.workbook!,
			sheets: content.workbook!.sheets.map(
				(sheet) => aligned.get(sheet.id)?.[side] ?? sheet,
			),
		},
	});
	return [use(base, 0), use(mine, 1), use(theirs, 2)];
}

const blank = (cell: Row[number] | undefined) =>
	cell == null || (cell.input === "" && cell.value === null && !cell.format);
const rowKey = (row: Row) => {
	let end = row.length;
	while (end > 0 && blank(row[end - 1])) end--;
	return JSON.stringify(
		row.slice(0, end).map((cell) => (blank(cell) ? 0 : cell)),
	);
};

/**
 * Whether `side` kept every row and column of `base` where it was: cells
 * edited in place, rows and columns added only after the last one.
 */
function grewInPlace(base: Grid, side: Grid): boolean {
	if (
		side.rows.length < base.rows.length ||
		side.columns.length < base.columns.length ||
		base.columns.some((column, index) => side.columns[index]!.id !== column.id)
	)
		return false;
	const keys = base.rows.map(rowKey);
	const places = new Map<string, number[]>();
	keys.forEach((key, index) =>
		places.set(key, [...(places.get(key) ?? []), index]),
	);
	return base.rows.every((row, index) => {
		const now = side.rows[index]!;
		const key = rowKey(now);
		if (key === keys[index] || key === "[]" || keys[index] === "[]")
			return true;
		// The row is one that used to be somewhere else: rows moved.
		if (places.get(key)?.some((place) => place !== index)) return false;
		// A row that moved and had its formulas rewritten shares little with
		// the row that was here; an edited row still shares most of its cells.
		let kept = 0;
		let changed = 0;
		for (let i = 0; i < Math.max(row.length, now.length); i++) {
			if (blank(row[i]) && blank(now[i])) continue;
			if (same(row[i] ?? null, now[i] ?? null)) kept++;
			else changed++;
		}
		return kept >= changed || kept + changed === 1;
	});
}

function alignGrid(
	base: Grid,
	mine: Grid,
	theirs: Grid,
): [Grid, Grid, Grid] | null {
	const height = Math.max(mine.rows.length, theirs.rows.length);
	const width = Math.max(mine.columns.length, theirs.columns.length);
	// One side growing already merges as a sequence; this is for both.
	const grew = (grid: Grid) =>
		grid.rows.length > base.rows.length ||
		grid.columns.length > base.columns.length;
	if (!grew(mine) || !grew(theirs)) return null;
	if (!grewInPlace(base, mine) || !grewInPlace(base, theirs)) return null;
	// A column both added at one position is one column: it takes their id.
	const columns = (grid: Grid, other: Grid) =>
		Array.from({ length: width }, (_, index) => {
			const column = grid.columns[index] ?? other.columns[index]!;
			const shared = theirs.columns[index] ?? mine.columns[index]!;
			return index < base.columns.length
				? column
				: { ...column, id: shared.id };
		});
	const rows = (grid: Grid) =>
		Array.from({ length: height }, (_, row) =>
			Array.from(
				{ length: width },
				(_, column) => grid.rows[row]?.[column] ?? null,
			),
		);
	return [
		{ ...base, rows: rows(base) },
		{ ...mine, columns: columns(mine, theirs), rows: rows(mine) },
		{ ...theirs, columns: columns(theirs, mine), rows: rows(theirs) },
	];
}

/**
 * Fields recomputed from the canonical body. Merging them as well would turn
 * every pair of edits into a conflict on the projection.
 */
function derivedKeys(
	options: OutputMergeOptions,
	...contents: OsOutputContent[]
): string[] {
	if (
		options.documentBlocks &&
		contents.every((c) => c.kind === "document" && c.richText)
	)
		return ["blocks"];
	if (contents.every((c) => c.kind === "sheet" && c.workbook))
		return ["columns", "rows"];
	if (
		options.presentationSlides &&
		contents.every((c) => c.kind === "presentation" && c.deck)
	)
		return ["slides"];
	return [];
}

function project(
	content: OsOutputContent,
	options: OutputMergeOptions,
): OsOutputContent {
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

/** The active sheet's labels and cached values, as the flat sheet fields hold them. */
export function projectSheet(workbook: OsWorkbook) {
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
	conflicts: Conflicts,
): Json {
	if (same(mine, theirs) || same(base, theirs)) return mine;
	if (same(base, mine)) return theirs;
	if (isObject(base) && isObject(mine) && isObject(theirs))
		return mergeObject(base, mine, theirs, path, conflicts);
	if (Array.isArray(base) && Array.isArray(mine) && Array.isArray(theirs))
		return mergeList(base, mine, theirs, path, conflicts);
	conflicts.push(path || "/");
	return conflicts.prefer === "mine" ? mine : theirs;
}

function mergeObject(
	base: { [key: string]: JsonValue },
	mine: { [key: string]: JsonValue },
	theirs: { [key: string]: JsonValue },
	path: string,
	conflicts: Conflicts,
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
	conflicts: Conflicts,
): Json {
	const lists = [base, mine, theirs];
	if (
		lists.some((list) => list.length > 0) &&
		lists.every((list) => list.every((item) => idOf(item)))
	)
		return mergeById(base, mine, theirs, path, conflicts);
	const typed = (item: JsonValue) =>
		isObject(item) && typeof item.type === "string";
	if (lists.every((list) => list.every(typed)) && lists.some(hasText))
		return joinWords(
			mergeSequence(
				splitWords(base),
				splitWords(mine),
				splitWords(theirs),
				path,
				conflicts,
				false,
				false,
			) as JsonValue[],
		);
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

type TextNode = { type: "text"; text: string; [key: string]: JsonValue };
const isText = (item: Json): item is TextNode =>
	isObject(item) && item.type === "text" && typeof item.text === "string";
const hasText = (list: JsonValue[]) => list.some(isText);
/** A word, a run of spaces, or one punctuation mark. */
const WORDS = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/** A line of text as one item per word, each keeping its formatting. */
function splitWords(line: JsonValue[]): JsonValue[] {
	return line.flatMap((node) =>
		isText(node)
			? (node.text.match(WORDS) ?? []).map((text) => ({ ...node, text }))
			: [node],
	);
}

/** Put neighbouring words with the same formatting back into one run. */
function joinWords(words: JsonValue[]): JsonValue[] {
	const line: JsonValue[] = [];
	for (const word of words) {
		const last = line[line.length - 1];
		if (
			isText(last) &&
			isText(word) &&
			same({ ...last, text: "" }, { ...word, text: "" })
		)
			line[line.length - 1] = { ...last, text: last.text + word.text };
		else line.push(word);
	}
	return line;
}

function mergeById(
	base: JsonValue[],
	mine: JsonValue[],
	theirs: JsonValue[],
	path: string,
	conflicts: Conflicts,
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
		return conflicts.prefer === "mine" ? mine : theirs;
	}
	// Removing an item the other side edited would silently drop that edit.
	const restore: string[] = [];
	for (const [id, original] of b) {
		const kept = m.get(id) ?? t.get(id);
		if (!m.has(id) !== !t.has(id) && kept && !same(original, kept)) {
			conflicts.push(`${path}/${id}`);
			if ((conflicts.prefer === "mine" ? m : t).has(id)) restore.push(id);
		}
	}
	const order = mergeSequence(
		base.map(idOf) as string[],
		mine.map(idOf) as string[],
		theirs.map(idOf) as string[],
		`${path}/(order)`,
		conflicts,
		false,
	) as string[];
	// The preferred side kept an item the other deleted: put it back where
	// the preferred side has it.
	const preferred = conflicts.prefer === "mine" ? mine : theirs;
	for (const id of restore) {
		if (order.includes(id)) continue;
		const before = preferred.slice(
			0,
			preferred.findIndex((x) => idOf(x) === id),
		);
		const anchor = before
			.map(idOf)
			.reverse()
			.find((x) => order.includes(x!));
		order.splice(anchor ? order.indexOf(anchor) + 1 : 0, 0, id);
	}
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
	conflicts: Conflicts,
	recurse = true,
	/** Whether items both sides added at one spot are all kept, theirs first. */
	stack = true,
): Json {
	const left = hunks(base, mine);
	const right = hunks(base, theirs);
	if (!left || !right) {
		conflicts.push(`${path}/(too large)`);
		return conflicts.prefer === "mine" ? mine : theirs;
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
		// Both sides only changed items in place (no inserts or deletes), so each
		// base position still lines up: merge position by position.
		const inPlace = (hunk: Hunk) =>
			hunk.end > hunk.start && hunk.items.length === hunk.end - hunk.start;
		if (
			recurse &&
			inPlace(clash) &&
			inPlace(change) &&
			left.filter((edit) => touches(edit, change)).length === 1
		) {
			const start = Math.min(clash.start, change.start);
			const end = Math.max(clash.end, change.end);
			const at = (hunk: Hunk, i: number) =>
				i >= hunk.start && i < hunk.end ? hunk.items[i - hunk.start] : base[i];
			applied[index] = {
				start,
				end,
				items: base
					.slice(start, end)
					.map((item, offset) =>
						merge(
							item,
							at(clash, start + offset),
							at(change, start + offset),
							`${path}/${start + offset}`,
							conflicts,
						),
					),
			};
			continue;
		}
		// Both sides only added items at the same spot: keep theirs, then mine.
		if (
			stack &&
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
		if (conflicts.prefer === "theirs") applied[index] = change;
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
