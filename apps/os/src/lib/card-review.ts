import {
	type CardActionKind,
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
	const withoutLinks = text.replace(new RegExp(URL_PATTERN.source, "g"), "");
	// Scan each separator/whitespace run once; nested regex repetition backtracks.
	const parts: string[] = [];
	let kept = 0;
	for (let index = 0; index < withoutLinks.length;) {
		const start = index;
		let separator = false;
		while (index < withoutLinks.length) {
			const character = withoutLinks[index]!;
			if ("·;,".includes(character)) separator = true;
			else if (!/\s/.test(character)) break;
			index++;
		}
		if (
			separator &&
			(index === withoutLinks.length || withoutLinks[index] === ")")
		) {
			parts.push(withoutLinks.slice(kept, start));
			kept = index;
		}
		if (index === start) index++;
	}
	parts.push(withoutLinks.slice(kept));
	const label = parts
		.join("")
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
	/** null when this sheet has no action column (an older run). */
	action: string | null;
	draft: string;
	useful: string;
	reason: string;
	done: string;
	/** A run_skill Do it's outcome, e.g. "Failed: …"; empty until a run writes it. */
	result: string;
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

/** The "why" cell without its rule ids, which the card keeps behind Details. */
export function plainWhy(why: string): string {
	const text = why
		.replace(/\(?\bR\d{1,3}\b(\s*[,/&]\s*R\d{1,3}\b)*\)?\s*:?\s*/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();
	return text.charAt(0).toUpperCase() + text.slice(1);
}

const ACTION_LABEL_MAX = 40;

/** Whether an action cell is short enough to name the Do it button. */
export function isActionLabel(action: string | null): action is string {
	return !!action && action.length <= ACTION_LABEL_MAX;
}

/**
 * The Do it button's label: the card's own action, or null to hide the button
 * when the card has none. A sheet without an action column, or an older long
 * action sentence, falls back to the configured label.
 */
export function doItLabel(
	source: Pick<CardReviewSource, "doIt" | "doItLabel">,
	card: Pick<ReviewCard, "action">,
): string | null {
	if (card.action === "") return null;
	if (isActionLabel(card.action)) return card.action;
	return (
		source.doItLabel ??
		(source.doIt === "copy_and_open" ? "Copy draft and open" : "Do it")
	);
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
			action:
				col(source.columns.action) < 0 ? null : at(row, source.columns.action),
			draft: at(row, source.columns.draft),
			useful: at(row, source.columns.useful),
			reason: at(row, source.columns.reason),
			done: at(row, source.columns.done),
			result: at(row, source.columns.result),
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

/**
 * What a run_skill Do it does with this card: the first configured kind whose
 * match text appears in the card's type, else in its action; work otherwise.
 */
export function cardActionKind(
	source: Pick<CardReviewSource, "run">,
	card: Pick<ReviewCard, "type" | "action">,
): CardActionKind {
	const actions = source.run?.actions ?? [];
	for (const cell of [card.type, card.action ?? ""]) {
		const lower = cell.toLowerCase();
		if (!lower) continue;
		const found = actions.find((entry) =>
			entry.match.some((text) => lower.includes(text.toLowerCase())),
		);
		if (found) return found.kind;
	}
	return "work";
}

/** Kinds that change the owner's mailbox and so need organise access. */
export function needsOrganise(kind: CardActionKind): boolean {
	return kind !== "work";
}

/** Where a run writes its outcome when the source names no result column. */
export const DEFAULT_RESULT_COLUMN = "Result";

/** The params a run_skill Do it starts its skill with. */
export function runParams(
	source: CardReviewSource,
	card: Pick<ReviewCard, "outputId" | "rowIndex" | "action">,
	kind: CardActionKind,
	reason = "",
): Record<string, unknown> {
	const { columns } = source;
	return {
		cardSheetId: card.outputId,
		row: card.rowIndex,
		kind,
		action: card.action ?? "",
		reason,
		columns: {
			type: columns.type ?? null,
			source: columns.source,
			who: columns.who ?? null,
			why: columns.why,
			action: columns.action ?? null,
			draft: columns.draft ?? null,
			useful: columns.useful,
			reason: columns.reason,
			done: columns.done,
			result: columns.result ?? DEFAULT_RESULT_COLUMN,
		},
		actions: source.run?.actions ?? [],
		...(source.run?.workProjectId
			? { workProjectId: source.run.workProjectId }
			: {}),
	};
}

const WORK_LINK = /\/work\/items\/[0-9a-f-]{36}/i;

/** A result cell split into its text and the Work item it links, if any. */
export function resultParts(result: string): {
	text: string;
	workHref: string | null;
	failed: boolean;
} {
	const match = WORK_LINK.exec(result);
	return {
		text: match ? result.replace(match[0], "").trim() : result,
		workHref: match ? match[0] : null,
		failed: /^failed\b/i.test(result),
	};
}
