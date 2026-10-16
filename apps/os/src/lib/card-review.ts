import {
	CARD_REVIEW_ENTRY,
	type CardReviewConfig,
	CardReviewConfigSchema,
	type CardReviewSource,
} from "@tedix/api-contract/schemas/os-card-review";
import type {
	OsGadgetManifest,
	OsOutput,
} from "@tedix/api-contract/schemas/os-workspaces";

/**
 * Card review: a built-in workspace app that turns a factory's card sheets
 * into one-card-at-a-time decisions. Everything tenant-specific — which
 * workspaces, which sheet titles, which columns, what "Do it" means — is the
 * app's manifest `config`; this module is the engine that reads it.
 *
 * Verdicts are written back into the card sheet's own cells, so a factory that
 * already reads those cells keeps working unchanged.
 */

export type CardReviewConfigResult =
	| { kind: "none" }
	| { kind: "invalid"; message: string }
	| { kind: "ok"; config: CardReviewConfig };

/** Whether a manifest selects this built-in app, and with which settings. */
export function cardReviewConfigFromManifest(
	manifest: OsGadgetManifest | null | undefined,
): CardReviewConfigResult {
	if (manifest?.entry.trim() !== CARD_REVIEW_ENTRY) return { kind: "none" };
	const parsed = CardReviewConfigSchema.safeParse(manifest.config);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return {
			kind: "invalid",
			message: issue
				? `${issue.path.join(".") || "config"}: ${issue.message}`
				: "The app settings are not valid",
		};
	}
	return { kind: "ok", config: parsed.data };
}

type Cell = string | number | boolean | null;
export type SheetBody = { columns: string[]; rows: Cell[][] };

const DEFAULT_CHIPS = {
	useful: ["Good catch", "Great angle", "Timely"],
	notUseful: ["Wrong person", "Not timely", "Too generic", "Already handled"],
} as const;

export function reasonChips(
	source: CardReviewSource,
	verdict: "useful" | "notUseful",
): readonly string[] {
	return source.reasonChips?.[verdict] ?? DEFAULT_CHIPS[verdict];
}

/** Exact (case-insensitive) header match first, then a header that starts with the configured text. */
export function columnIndex(columns: readonly string[], name: string): number {
	const wanted = name.trim().toLowerCase();
	const exact = columns.findIndex((c) => c.trim().toLowerCase() === wanted);
	if (exact >= 0) return exact;
	return columns.findIndex((c) => c.trim().toLowerCase().startsWith(wanted));
}

export function cellText(value: Cell | undefined): string {
	if (value === null || value === undefined) return "";
	return String(value).trim();
}

const URL_PATTERN = /https?:\/\/[^\s<>"')]+/;

/** The first link in a cell, without trailing punctuation. */
export function firstLink(text: string): string | null {
	const match = URL_PATTERN.exec(text);
	if (!match) return null;
	return match[0].replace(/[.,;:]+$/, "");
}

/** A source cell split into readable text and its links (at most three). */
export function sourceParts(text: string): { label: string; links: string[] } {
	const links = [
		...new Set(
			(text.match(new RegExp(URL_PATTERN.source, "g")) ?? []).map((link) =>
				link.replace(/[.,;:]+$/, ""),
			),
		),
	].slice(0, 3);
	const label = text
		.replace(new RegExp(URL_PATTERN.source, "g"), "")
		.replace(/(\s*[·;,]\s*)+(?=$|\))/g, "")
		.replace(/\(\s*\)/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();
	return { label, links };
}

export type ReviewCard = {
	key: string;
	sourceIndex: number;
	sourceLabel: string;
	channel: string;
	outputId: string;
	sheetTitle: string;
	runCreatedAt: string;
	rowIndex: number;
	number: string;
	type: string;
	sourceText: string;
	link: string | null;
	who: string;
	why: string;
	ruleIds: string[];
	action: string;
	draft: string;
	useful: string;
	reason: string;
	done: string;
};

export function channelFor(source: CardReviewSource, haystack: string): string {
	const lower = haystack.toLowerCase();
	for (const channel of source.channels ?? []) {
		if (channel.match.some((m) => lower.includes(m.toLowerCase())))
			return channel.label;
	}
	return source.label;
}

/** Rule ids cited in a "why" cell, e.g. "R4: …" or "R2, R7". */
export function citedRuleIds(why: string): string[] {
	return [...new Set(why.match(/\bR\d{1,3}\b/g) ?? [])];
}

/** Card-sheet outputs for one source, newest run first. */
export function cardSheetsForSource(
	source: CardReviewSource,
	outputs: readonly Pick<
		OsOutput,
		"id" | "title" | "kind" | "status" | "createdAt"
	>[],
) {
	return outputs
		.filter(
			(o) =>
				o.kind === "sheet" &&
				o.status === "active" &&
				o.title.startsWith(source.cardSheetPrefix),
		)
		.sort((a, b) =>
			b.createdAt === a.createdAt
				? b.title.localeCompare(a.title)
				: b.createdAt.localeCompare(a.createdAt),
		)
		.slice(0, source.maxRuns);
}

export type MissingColumns = { sheetTitle: string; missing: string[] };

/** Cards of one sheet in row order, or the configured columns it lacks. */
export function cardsFromSheet(input: {
	source: CardReviewSource;
	sourceIndex: number;
	outputId: string;
	sheetTitle: string;
	runCreatedAt: string;
	body: SheetBody;
}): { cards: ReviewCard[] } | { missing: MissingColumns } {
	const { source, body } = input;
	const col = (name: string | undefined) =>
		name === undefined ? -1 : columnIndex(body.columns, name);
	const required = ["source", "why", "useful", "reason", "done"] as const;
	const missing = required
		.filter((key) => col(source.columns[key]) < 0)
		.map((key) => source.columns[key]);
	if (missing.length > 0)
		return { missing: { sheetTitle: input.sheetTitle, missing } };
	const at = (row: Cell[], name: string | undefined) => {
		const index = col(name);
		return index < 0 ? "" : cellText(row[index]);
	};
	const cards: ReviewCard[] = [];
	body.rows.forEach((row, rowIndex) => {
		const sourceText = at(row, source.columns.source);
		const why = at(row, source.columns.why);
		if (!sourceText && !why) return;
		const who = at(row, source.columns.who);
		const type = at(row, source.columns.type);
		cards.push({
			key: `${input.outputId}:${rowIndex}`,
			sourceIndex: input.sourceIndex,
			sourceLabel: source.label,
			channel: channelFor(source, `${sourceText} ${who} ${type}`),
			outputId: input.outputId,
			sheetTitle: input.sheetTitle,
			runCreatedAt: input.runCreatedAt,
			rowIndex,
			number: at(row, source.columns.number) || String(rowIndex + 1),
			type,
			sourceText,
			link: firstLink(sourceText),
			who,
			why,
			ruleIds: citedRuleIds(why),
			action: at(row, source.columns.action),
			draft: at(row, source.columns.draft),
			useful: at(row, source.columns.useful),
			reason: at(row, source.columns.reason),
			done: at(row, source.columns.done),
		});
	});
	return { cards };
}

/** A card is open until any verdict cell carries a value. */
export function isOpen(card: Pick<ReviewCard, "useful" | "reason" | "done">) {
	return !card.useful && !card.reason && !card.done;
}

/** One consistent Reason form the factory can count: "Chip, Chip: free text". */
export function formatReason(chips: readonly string[], text: string): string {
	const note = text.trim().replace(/\s+/g, " ");
	const head = chips.join(", ");
	if (head && note) return `${head}: ${note}`;
	return head || note;
}

export type Verdict =
	| { kind: "useful"; reason: string }
	| { kind: "not_useful"; reason: string }
	| { kind: "do_it"; reason: string };

/** The cells a verdict writes, by configured column name. */
export function verdictCells(
	source: CardReviewSource,
	card: Pick<ReviewCard, "useful">,
	verdict: Verdict,
): Record<string, string> {
	const { columns } = source;
	switch (verdict.kind) {
		case "useful":
			return { [columns.useful]: "yes", [columns.reason]: verdict.reason };
		case "not_useful":
			return {
				[columns.useful]: "no",
				[columns.reason]: verdict.reason,
				[columns.done]: "no",
			};
		case "do_it":
			return {
				[columns.useful]: card.useful || "yes",
				[columns.reason]: verdict.reason,
				[columns.done]: "yes",
			};
	}
}

/**
 * One contiguous rectangle for a row write. Columns between the written ones
 * keep their current values, so the rectangle never clears unrelated cells.
 */
export function rowWrite(
	body: SheetBody,
	rowIndex: number,
	cellsByColumn: Record<string, Cell>,
): { startColumn: number; cells: Cell[][] } {
	const entries = Object.entries(cellsByColumn).map(
		([name, value]) => [columnIndex(body.columns, name), value] as const,
	);
	if (entries.some(([index]) => index < 0))
		throw new Error("A configured column is missing from this sheet");
	const indexes = entries.map(([index]) => index);
	const start = Math.min(...indexes);
	const end = Math.max(...indexes);
	const current = body.rows[rowIndex] ?? [];
	const row: Cell[] = [];
	for (let i = start; i <= end; i += 1) row.push(current[i] ?? null);
	for (const [index, value] of entries) row[index - start] = value;
	return { startColumn: start, cells: [row] };
}

export type PendingRule = {
	key: string;
	sourceIndex: number;
	sourceLabel: string;
	outputId: string;
	rowIndex: number;
	id: string;
	text: string;
};

/** Rules rows whose status is "proposed": the factory's suggested changes. */
export function pendingRules(input: {
	source: CardReviewSource;
	sourceIndex: number;
	outputId: string;
	body: SheetBody;
}): PendingRule[] {
	const rules = input.source.rules;
	if (!rules) return [];
	const status = columnIndex(input.body.columns, rules.statusColumn);
	if (status < 0) return [];
	const id = columnIndex(input.body.columns, rules.idColumn);
	const text = columnIndex(input.body.columns, rules.textColumn);
	return input.body.rows.flatMap((row, rowIndex) =>
		cellText(row[status]).toLowerCase() === "proposed"
			? [
					{
						key: `${input.outputId}:${rowIndex}`,
						sourceIndex: input.sourceIndex,
						sourceLabel: input.source.label,
						outputId: input.outputId,
						rowIndex,
						id: id < 0 ? "" : cellText(row[id]),
						text: text < 0 ? "" : cellText(row[text]),
					},
				]
			: [],
	);
}

/** Rule text by id for one source, so a card can say why in plain words. */
export function ruleTextById(
	source: CardReviewSource,
	body: SheetBody | undefined,
): Map<string, string> {
	const map = new Map<string, string>();
	if (!body || !source.rules) return map;
	const id = columnIndex(body.columns, source.rules.idColumn);
	const text = columnIndex(body.columns, source.rules.textColumn);
	if (id < 0 || text < 0) return map;
	for (const row of body.rows) {
		const key = cellText(row[id]);
		if (key) map.set(key, cellText(row[text]));
	}
	return map;
}

/** Snoozed until the next local day; stored per viewer only. */
export function snoozeUntil(now: Date): string {
	const next = new Date(now);
	next.setHours(24, 0, 0, 0);
	return next.toISOString();
}

export function isSnoozed(
	snoozes: Record<string, string>,
	key: string,
	now: Date,
): boolean {
	const until = snoozes[key];
	return until !== undefined && until > now.toISOString();
}

/**
 * The review queue: open, unsnoozed cards in the selected channel, in the
 * configured source order (an install lists its own workspace first), then
 * newest run first and sheet order; skipped cards move to the end.
 */
export function reviewQueue(
	cards: readonly ReviewCard[],
	options: {
		channel: string | null;
		snoozes: Record<string, string>;
		skipped: readonly string[];
		now: Date;
	},
): ReviewCard[] {
	const open = cards
		.filter(
			(card) =>
				isOpen(card) &&
				(options.channel === null || card.channel === options.channel) &&
				!isSnoozed(options.snoozes, card.key, options.now),
		)
		.sort((a, b) =>
			a.sourceIndex !== b.sourceIndex
				? a.sourceIndex - b.sourceIndex
				: a.runCreatedAt === b.runCreatedAt
					? a.outputId === b.outputId
						? a.rowIndex - b.rowIndex
						: a.outputId.localeCompare(b.outputId)
					: b.runCreatedAt.localeCompare(a.runCreatedAt),
		);
	const skipped = new Map(options.skipped.map((key, i) => [key, i]));
	return [
		...open.filter((card) => !skipped.has(card.key)),
		...open
			.filter((card) => skipped.has(card.key))
			.sort((a, b) => skipped.get(a.key)! - skipped.get(b.key)!),
	];
}
