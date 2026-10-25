import {
	WorkItemDispositionSchema,
	WorkItemKindSchema,
	WorkItemClassSchema,
	WorkExecutorSchema,
} from "@tedix/api-contract/schemas/work-items";
import { WorkInteractionCursorSchema } from "@tedix/api-contract/schemas/work-interactions";
import { readFileSync } from "node:fs";
import { resolveAgentContext } from "./agent-context";
import { dim, green } from "./format";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { WorkContext } from "./work";
import {
	type BoardResult,
	isUuid,
	tediNamespace,
	identityBoundCallable,
	mutationCallable,
	withSession,
} from "./work-identity";
import { nativeBootstrap, boardCall } from "./work-native";
import {
	fail,
	ok,
	truncate,
	itemsFromList,
	dispositionPaint,
	renderWorkItemsTable,
	renderContextBrief,
	contextBriefJson,
	filterEvidenceRows,
	renderWorkEvidenceTable,
	renderWorkAttemptsTable,
	renderWorkEventsTable,
} from "./work-render";

// Keep default board output bounded; native projections enforce per-page limits.
const DEFAULT_LIST_LIMIT = 20;

/** Rows per native bounded board page. */
const LIST_PAGE_SIZE = 50;

/** Backstop so a huge `--limit` cannot fan out into unbounded round trips. */
const LIST_MAX_PAGES = 40;

/** Stitch bounded native board pages without publishing partial results. */
async function listBoard(
	ctx: WorkContext,
	callable: string,
	args: Record<string, unknown>,
): Promise<BoardResult> {
	const requested =
		typeof args.limit === "number" && Number.isFinite(args.limit)
			? Math.max(1, Math.trunc(args.limit))
			: LIST_PAGE_SIZE;
	const baseOffset =
		typeof args.offset === "number" && Number.isFinite(args.offset)
			? Math.max(0, Math.trunc(args.offset))
			: 0;

	const rows: unknown[] = [];
	let pagination: unknown;
	for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
		const remaining = requested - rows.length;
		if (remaining <= 0) break;
		// Omit a zero offset: single-page calls stay byte-identical to an
		// unpaged call, so server-side filters (e.g. the idPrefix resolver) are
		// visibly not doing a client-side scan.
		const pageOffset = baseOffset + rows.length;
		const pageArgs = {
			...args,
			limit: Math.min(LIST_PAGE_SIZE, remaining),
			...(pageOffset > 0 ? { offset: pageOffset } : {}),
		};
		const result = await listBoardPage(ctx, callable, pageArgs);
		if (result.error) {
			// Partial pages are not a usable board view; surface the failure.
			return result;
		}
		const value = isRecord(result.value) ? result.value : undefined;
		const pageRows = Array.isArray(value?.data) ? value.data : [];
		rows.push(...pageRows);
		pagination = value?.pagination;
		const hasMore = isRecord(pagination) ? pagination.hasMore === true : false;
		if (pageRows.length < pageArgs.limit || !hasMore) break;
	}

	const total = isRecord(pagination) ? pagination.total : undefined;
	return {
		value: {
			data: rows,
			pagination: {
				limit: requested,
				offset: baseOffset,
				...(typeof total === "number" ? { total } : {}),
				hasMore:
					typeof total === "number" ? baseOffset + rows.length < total : false,
			},
		},
	};
}

/** One gateway round trip for {@link listBoard}. */
async function listBoardPage(
	ctx: WorkContext,
	callable: string,
	args: Record<string, unknown>,
): Promise<BoardResult> {
	const namespace = ctx.work.as
		? tediNamespace(ctx.work.as)
		: callable.slice(0, callable.indexOf("."));
	const view =
		typeof args.idPrefix === "string" || typeof args.titleContains === "string"
			? "resolve"
			: "board";
	const call = await boardCall(ctx, `${namespace}.list_work_item_cli_rows`, {
		...args,
		view,
	});
	if (call.error) return call;
	if (
		!isRecord(call.value) ||
		call.value.view !== view ||
		!Array.isArray(call.value.data) ||
		call.value.data.length > 50 ||
		!isRecord(call.value.pagination) ||
		typeof call.value.pagination.total !== "number" ||
		typeof call.value.pagination.hasMore !== "boolean"
	)
		return {
			value: undefined,
			error: { message: "Malformed native Work board projection" },
		};
	return call;
}

/** List board rows through the canonical work namespace. */
export async function listWorkItems(
	ctx: WorkContext,
	args: Record<string, unknown>,
): Promise<BoardResult> {
	return listBoard(ctx, "work.list_work_items", args);
}

/** Read a work item through the canonical work namespace. */
export async function getWorkItem(
	ctx: WorkContext,
	id: string,
): Promise<BoardResult> {
	return boardCall(ctx, "work.get_work_items_by_id", { id });
}

/** Work Items reference projects only by canonical UUID. */
export function projectArg(project?: string): Record<string, unknown> {
	const value = project?.trim();
	if (!value) return {};
	if (!isUuid(value)) {
		throw new Error("--project requires the canonical project UUID");
	}
	return { projectId: value };
}

async function resolveProjectArg(
	_ctx: WorkContext,
	project?: string,
): Promise<Record<string, unknown>> {
	return projectArg(project);
}

// ─── Id resolution (prefix → full id) ──────────────────────────────────────

/** Shortest id prefix we will attempt to resolve — below this it's too ambiguous. */
const MIN_ID_PREFIX = 6;
/** Soft cap on `find` results so a broad title match stays bounded. */
const FIND_MAX_RESULTS = 30;

/**
 * True when `token` is neither a full UUID nor obvious garbage, but a plausible
 * work-item id PREFIX we should resolve org-wide: ≥6 hex chars, optionally
 * hyphenated, shorter than a full UUID. A non-hex token (e.g. a slug or a typo
 * with letters outside a-f) is passed through untouched so current behavior and
 * the board's own error message are preserved.
 */
function isResolvablePrefix(token: string): boolean {
	const t = token.trim();
	if (t.length < MIN_ID_PREFIX || t.length > 35) return false;
	if (!/^[0-9a-f-]+$/i.test(t)) return false;
	return t.replace(/-/g, "").length >= MIN_ID_PREFIX;
}

/**
 * Resolve a work-item id TOKEN to exactly one full id.
 *   - A full UUID is used as-is (fast path — no network).
 *   - A short hex prefix (≥6 chars) is resolved with ONE server-side-filtered
 *     `work.list_work_items` call (`idPrefix`, limit 2 — two rows are enough to
 *     prove ambiguity):
 *       0 matches  → clear "no work item matches prefix X" error
 *       1 match    → that item's full id
 *       ≥2 matches → "ambiguous prefix X matches N items: <ids+titles>" (never
 *                    guesses which one was meant)
 *   - Any other token (slug/typo) is passed through unchanged so the board's own
 *     validation reports it.
 */
export async function resolveWorkItemId(
	ctx: WorkContext,
	token: string,
): Promise<string> {
	const raw = token.trim();
	if (!raw) return token;
	if (isUuid(raw)) return raw;
	if (!isResolvablePrefix(raw)) return token;

	const prefix = raw.toLowerCase();
	const call = await listWorkItems(ctx, {
		idPrefix: prefix,
		limit: 2,
	});
	if (call.error) {
		throw new Error(
			`could not resolve work item prefix ${raw}: ${call.error.message}`,
		);
	}
	const matches = itemsFromList(call.value);
	if (matches.length === 0) {
		throw new Error(`no work item matches prefix ${raw}`);
	}
	if (matches.length > 1) {
		const candidates = matches
			.map((m) => `${String(m.id)} (${String(m.title ?? "").trim()})`)
			.join(", ");
		throw new Error(
			`ambiguous prefix ${raw} matches ${matches.length} items: ${candidates}`,
		);
	}
	return String(matches[0]?.id);
}

/**
 * `find` — discover a full work-item id when you only remember a fragment.
 * A hex-shaped query filters server-side by `idPrefix` (falling back to a
 * title search when no id starts with it); anything else filters server-side
 * by `titleContains` (case-insensitive). Prints the FULL id so it can be
 * copied straight into lifecycle writes.
 */
export async function workFind(
	ctx: WorkContext,
	query: string,
): Promise<number> {
	const q = query.trim();
	if (!q) {
		throw new Error(
			"work find requires a <query> (an id prefix or a title substring)",
		);
	}
	const limit = ctx.work.limit ?? FIND_MAX_RESULTS;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new Error("work find --limit requires an integer from 1 to 100");
	const disposition = ctx.work.disposition;
	if (disposition && !WorkItemDispositionSchema.safeParse(disposition).success)
		throw new Error(
			"work find --disposition requires a canonical Work disposition",
		);
	const filters = {
		limit,
		...projectArg(ctx.work.project),
		...(disposition ? { disposition } : {}),
	};
	let call: BoardResult | undefined;
	if (isResolvablePrefix(q)) {
		call = await listWorkItems(ctx, {
			idPrefix: q.toLowerCase(),
			...filters,
		});
		// A hex-looking fragment that matches no id may still live in a title
		// (e.g. a sha pasted into one) — retry as a title search before giving up.
		if (!call.error && itemsFromList(call.value).length === 0) call = undefined;
	}
	if (!call) {
		call = await listWorkItems(ctx, {
			titleContains: q,
			...filters,
		});
	}
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not search work items: ${call.error.message}`,
		);
	}
	const matches = itemsFromList(call.value);
	return ok(ctx, { data: matches }, () => {
		if (matches.length === 0) {
			console.log(dim(`No work item matches "${q}".`, ctx.color));
			return;
		}
		for (const m of matches) {
			const rawDisposition = String(m.disposition ?? "—");
			const disposition = dispositionPaint(rawDisposition, ctx.color);
			console.log(
				`${String(m.id)}  ${disposition}  ${truncate(String(m.title ?? ""), 60)}`,
			);
		}
	});
}

// ─── Verbs ─────────────────────────────────────────────────────────────────

export function workExecutorArg(value: string | undefined) {
	if (value === undefined) return undefined;
	const parsed = WorkExecutorSchema.safeParse(value.trim());
	if (!parsed.success)
		throw new Error(
			`--executor must be one of ${WorkExecutorSchema.options.join("|")}, got "${value}"`,
		);
	return parsed.data;
}

/** One `work list` enum filter; a typo must error, not silently widen the page. */
function listEnumArg(
	flag: string,
	values: readonly string[],
	value: string | undefined,
	arg: string,
): Record<string, unknown> {
	if (value === undefined) return {};
	const trimmed = value.trim();
	if (!values.includes(trimmed))
		throw new Error(
			`work list ${flag} must be one of ${values.join("|")}, got "${value}"`,
		);
	return { [arg]: trimmed };
}

export async function workList(ctx: WorkContext, _id: string): Promise<number> {
	const { as, project, disposition, mine, limit } = ctx.work;
	const base: Record<string, unknown> = {
		limit: limit ?? DEFAULT_LIST_LIMIT,
		...(disposition ? { disposition } : {}),
		...projectArg(project),
		...listEnumArg(
			"--kind",
			WorkItemKindSchema.options,
			ctx.work.kind,
			"workKind",
		),
		...listEnumArg(
			"--class",
			WorkItemClassSchema.options,
			ctx.work.workClass,
			"workClass",
		),
		...listEnumArg(
			"--executor",
			WorkExecutorSchema.options,
			ctx.work.executor,
			"executor",
		),
	};
	const objective = ctx.work.objective?.trim();
	if (objective && !isUuid(objective)) {
		throw new Error(
			"work list --objective requires the canonical objective UUID",
		);
	}
	if (objective) base.objectiveId = objective;
	const offset = ctx.work.offset?.trim();
	if (offset) {
		const parsed = Number(offset);
		if (!Number.isSafeInteger(parsed) || parsed < 0) {
			throw new Error(
				"work list --offset requires a non-negative safe integer",
			);
		}
		base.offset = parsed;
	}

	let call: BoardResult;
	if (mine) {
		if (!as) {
			throw new Error(
				"work list --mine needs --as <tediSlug> (whose items to show)",
			);
		}
		call = await listBoard(
			ctx,
			identityBoundCallable(as, "work.list_work_items", "work_items_list"),
			{ ...base, mine: true },
		);
	} else {
		call = await listWorkItems(ctx, base);
	}

	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not list work items: ${call.error.message}`,
		);
	}
	const items = itemsFromList(call.value);
	const pagination =
		isRecord(call.value) && isRecord(call.value.pagination)
			? call.value.pagination
			: undefined;
	const total =
		typeof pagination?.total === "number" ? pagination.total : undefined;
	const nextOffset =
		(typeof pagination?.offset === "number" ? pagination.offset : 0) +
		items.length;
	return ok(ctx, call.value, () => {
		console.log(renderWorkItemsTable(items, ctx.color));
		if (pagination?.hasMore === true && total !== undefined) {
			console.log(
				dim(
					`Showing ${items.length} of ${total} (use --offset ${nextOffset} for the next page)`,
					ctx.color,
				),
			);
		}
	});
}

/** Purpose-exception classes `create` accepts (objective work uses --objective). */
export const CREATE_EXCEPTION_CLASSES = new Set([
	"maintenance",
	"incident",
	"hygiene",
]);
const CREATE_WORK_KINDS = new Set([
	"coding",
	"research",
	"document",
	"design",
	"browser",
	"operations",
	"communication",
	"finance",
	"legal",
	"stewardship",
	"incident",
	"other",
]);
const CREATE_PRIORITIES = new Set(["critical", "high", "medium", "low"]);

/**
 * `--expires` accepts a relative duration (`45m`, `72h`, `7d`, `2w`) or an
 * absolute ISO datetime, normalized to the ISO instant the purpose gate stores.
 */
export function expiresToIso(raw: string, now = Date.now()): string {
	const t = raw.trim();
	const duration = t.match(/^(\d+)\s*([mhdw])$/i);
	let parsed: number;
	if (duration) {
		const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
			duration[2]!.toLowerCase() as "m" | "h" | "d" | "w"
		];
		parsed = new Date(now + Number(duration[1]) * unitMs).getTime();
	} else {
		parsed = Date.parse(t);
	}
	if (!Number.isFinite(parsed)) {
		throw new Error(
			`--expires must be a duration (45m, 72h, 7d) or an ISO datetime, got "${raw}"`,
		);
	}
	return new Date(parsed).toISOString();
}

/**
 * `create` — guided Work Item creation that surfaces the board's purpose gate
 * ergonomically: purpose comes from a project, an explicit objective, or a
 * time-bounded operational exception. The board resolves inherited purpose.
 */
export async function workCreate(
	ctx: WorkContext,
	title: string,
): Promise<number> {
	const t = title.trim();
	if (!t) throw new Error('work create requires a "<title>"');
	const { as, desc, kind, priority, objective, workClass, expires } = ctx.work;
	const executor = workExecutorArg(ctx.work.executor);

	// The purpose gate, enforced client-side first.
	if (!objective && !workClass && !ctx.work.project) {
		throw new Error(
			"work create requires a purpose: pass --objective <objectiveId> for objective work, " +
				"or --class maintenance|incident|hygiene --expires <duration|iso> for a time-bounded " +
				"operational exception (e.g. --class hygiene --expires 72h). The board rejects purposeless items.",
		);
	}
	if (objective && workClass) {
		throw new Error(
			"pass either --objective (objective work) or --class (operational exception), not both",
		);
	}
	if (objective && !isUuid(objective)) {
		throw new Error("--objective requires an objective UUID");
	}
	let purposeExceptionExpiresAt: string | undefined;
	if (workClass) {
		if (!CREATE_EXCEPTION_CLASSES.has(workClass)) {
			throw new Error(
				`--class must be one of maintenance|incident|hygiene, got "${workClass}"`,
			);
		}
		if (!expires?.trim()) {
			throw new Error(
				`--class ${workClass} requires --expires <duration|iso> (e.g. 72h, 7d) — operational exceptions are time-bounded`,
			);
		}
		purposeExceptionExpiresAt = expiresToIso(expires);
	}
	if (kind && !CREATE_WORK_KINDS.has(kind)) {
		throw new Error(
			`--kind must be one of ${[...CREATE_WORK_KINDS].join("|")}, got "${kind}"`,
		);
	}
	if (priority && !CREATE_PRIORITIES.has(priority)) {
		throw new Error(
			`--priority must be one of critical|high|medium|low, got "${priority}"`,
		);
	}

	const args: Record<string, unknown> = {
		title: t,
		...(executor ? { executor } : {}),
		...(desc?.trim() ? { description: desc.trim() } : {}),
		...(kind ? { workKind: kind } : {}),
		...(priority ? { priority } : {}),
		...(objective ? { objectiveId: objective.trim() } : {}),
		...(workClass ? { workClass, purposeExceptionExpiresAt } : {}),
		...(await resolveProjectArg(ctx, ctx.work.project)),
	};
	const call = await boardCall(
		ctx,
		mutationCallable(as, "work.create_work_items"),
		withSession(ctx, args),
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not create work item: ${call.error.message}`,
		);
	}
	// The platform tool returns the row; a namespaced variant may wrap it.
	const item = isRecord(call.value)
		? isRecord(call.value.workItem)
			? call.value.workItem
			: call.value
		: {};
	const id = typeof item.id === "string" ? item.id : "";
	return ok(ctx, call.value, () => {
		if (!objective && workClass && item.objectiveId) {
			console.log(
				`Inherited objective ${item.objectiveId} from project ${ctx.work.project}; --class and --expires were ignored.`,
			);
		}
		console.log(
			`${green("Created", ctx.color)} ${id || "(id unavailable)"}  ${dispositionPaint(
				String(item.disposition ?? "proposed"),
				ctx.color,
			)}  ${truncate(t, 60)}`,
		);
		if (id) {
			console.log(
				dim(
					`  accept it, then start: tedix work accept ${id} --done-when "<what done looks like>"`,
					ctx.color,
				),
			);
		}
	});
}

export function parseObjectArgument(
	raw: string,
	flag: string,
): Record<string, unknown> {
	const source = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
	const parsed: unknown = JSON.parse(source);
	if (!isRecord(parsed))
		throw new Error(`${flag} must contain one JSON object`);
	return parsed;
}

export async function workReadiness(
	ctx: WorkContext,
	id: string,
): Promise<number> {
	if (!id) throw new Error("work readiness requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const call = await boardCall(ctx, "work.get_work_item_readiness", { id });
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not read readiness for ${id}: ${call.error.message}`,
		);
	return ok(ctx, call.value, () =>
		console.log(JSON.stringify(call.value, null, 2)),
	);
}

export async function workContext(
	ctx: WorkContext,
	id: string,
): Promise<number> {
	if (!id) throw new Error("work context requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const call = await getWorkItem(ctx, id);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not read context for ${id}: ${call.error.message}`,
		);
	}
	// Parse-recover BEFORE branching so --json gets the compact brief too.
	let parsed = call.value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			/* leave as string */
		}
	}
	if (ctx.json) {
		console.log(
			JSON.stringify(isRecord(parsed) ? contextBriefJson(parsed) : parsed),
		);
		return 0;
	}
	return ok(ctx, call.value, () => {
		// A very large single item can arrive as a truncated JSON string; recover
		// the object when it parses, else say so rather than rendering nothing.
		let value = call.value;
		if (typeof value === "string") {
			try {
				value = JSON.parse(value);
			} catch {
				/* leave as string */
			}
		}
		if (isRecord(value)) renderContextBrief(value, ctx.color);
		else console.log(dim("No context available.", ctx.color));
	});
}

// ─── Ledger reads (evidence / attempts / events) ─────────────────────────────

/** Bounded cursor ledgers use the exact native CLI projections. */
const LEDGER_DEFAULT_LIMIT = 25;
const LEDGER_MAX_LIMIT = 100;

function ledgerLimit(requested: number | undefined): number {
	if (typeof requested !== "number" || !Number.isFinite(requested)) {
		return LEDGER_DEFAULT_LIMIT;
	}
	return Math.min(LEDGER_MAX_LIMIT, Math.max(1, Math.trunc(requested)));
}

/** Read one compact native ledger and preserve its canonical continuation. */
async function listLedgerPage(
	ctx: WorkContext,
	callable: string,
	args: Record<string, unknown>,
	rowsKey: string,
	nextKey: string,
): Promise<BoardResult> {
	const tools: Record<string, string> = {
		"work.list_work_item_attempts": "work.list_work_attempt_cli_rows",
		"work.list_work_item_evidence": "work.list_work_evidence_cli_rows",
		"work.list_work_item_events": "work.list_work_event_cli_rows",
	};
	const call = await boardCall(ctx, tools[callable]!, args);
	if (call.error) return call;
	if (!isRecord(call.value) || !Array.isArray(call.value[rowsKey]))
		return {
			value: undefined,
			error: { message: "Malformed native Work ledger projection" },
		};
	return {
		value: { data: call.value[rowsKey], next: call.value[nextKey] ?? null },
	};
}

const EVIDENCE_DISPOSITIONS = [
	"pending",
	"accepted",
	"rejected",
	"superseded",
] as const;

/**
 * `evidence` — read a Work Item's evidence ledger.
 *
 * Kept after the review plane was retired: the ~22 in-flight items accepted
 * under the old contracts carry historical `work_evidence` rows, and those
 * rows must stay readable. Nothing decides them any more — there is no
 * `review-evidence` verb — so this is a ledger view, not half a review loop.
 */
export async function workEvidence(
	ctx: WorkContext,
	id: string,
): Promise<number> {
	if (!id) throw new Error("work evidence requires a work item id");
	const disposition = ctx.work.disposition?.trim();
	if (disposition && !EVIDENCE_DISPOSITIONS.includes(disposition as never)) {
		throw new Error(
			`work evidence --disposition must be one of ${EVIDENCE_DISPOSITIONS.join("|")}`,
		);
	}
	const resolvedId = await resolveWorkItemId(ctx, id);
	const call = await listLedgerPage(
		ctx,
		"work.list_work_item_evidence",
		{ id: resolvedId, limit: ledgerLimit(ctx.work.limit) },
		"data",
		"nextCursor",
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not list evidence for ${resolvedId}: ${call.error.message}`,
		);
	}
	const rows = filterEvidenceRows(itemsFromList(call.value), {
		...(ctx.work.claimKey ? { claimKey: ctx.work.claimKey } : {}),
		...(disposition ? { disposition } : {}),
	});
	const nextCursor = isRecord(call.value) ? (call.value.next ?? null) : null;
	return ok(ctx, { data: rows, nextCursor }, () =>
		console.log(renderWorkEvidenceTable(rows, ctx.color)),
	);
}

/** `attempts` — list a Work Item's attempt ledger (same ledger read path). */
export async function workAttempts(
	ctx: WorkContext,
	id: string,
): Promise<number> {
	if (!id) throw new Error("work attempts requires a work item id");
	const resolvedId = await resolveWorkItemId(ctx, id);
	const call = await listLedgerPage(
		ctx,
		"work.list_work_item_attempts",
		{ id: resolvedId, limit: ledgerLimit(ctx.work.limit) },
		"data",
		"nextCursor",
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not list attempts for ${resolvedId}: ${call.error.message}`,
		);
	}
	const rows = itemsFromList(call.value);
	const nextCursor = isRecord(call.value) ? (call.value.next ?? null) : null;
	return ok(ctx, { data: rows, nextCursor }, () =>
		console.log(renderWorkAttemptsTable(rows, ctx.color)),
	);
}

/** `events` — list a Work Item's immutable event ledger. */
export async function workEvents(
	ctx: WorkContext,
	id: string,
): Promise<number> {
	if (!id) throw new Error("work events requires a work item id");
	const resolvedId = await resolveWorkItemId(ctx, id);
	const call = await listLedgerPage(
		ctx,
		"work.list_work_item_events",
		{ id: resolvedId, limit: ledgerLimit(ctx.work.limit) },
		"events",
		"nextSequence",
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not list events for ${resolvedId}: ${call.error.message}`,
		);
	}
	const rows = itemsFromList(call.value);
	const nextSequence = isRecord(call.value) ? (call.value.next ?? null) : null;
	return ok(ctx, { data: rows, nextSequence }, () =>
		console.log(renderWorkEventsTable(rows, ctx.color)),
	);
}

/** Explicit safe-point read; retrieval never acknowledges a guardian request. */
export async function workCheckpoint(
	ctx: WorkContext,
	id: string,
	text: string,
): Promise<number> {
	if (id || text || ctx.work.as || ctx.work.input || ctx.work.project)
		throw new Error(
			"work checkpoint uses the current chat selection; no id, --as, --input or --project override",
		);
	const binding = (ctx.resolveContext ?? (() => resolveAgentContext()))();
	if (
		binding.status !== "bound" ||
		!binding.workItemId ||
		!binding.contextSessionId ||
		binding.contextSource !== "chat"
	)
		throw new Error(
			'work checkpoint needs Work selected for this chat, and none is. Find the item with `tedix work find "<title terms>"` (add --project <id> from `tedix setup agents context show`), then select it with `tedix setup agents context select <id>`.',
		);
	if (
		binding.workspace !== ctx.workspace ||
		!ctx.mcpUrl ||
		binding.mcpUrl !== ctx.mcpUrl
	)
		throw new Error(
			"work checkpoint cannot correlate the effective gateway and organization with this chat; use its connected profile",
		);
	const bootstrap = await nativeBootstrap(ctx);
	const runtime = bootstrap.nativeContext!;
	const itemCall = await boardCall(ctx, "work.get_work_item_checkpoint", {
		id: binding.workItemId,
	});
	if (itemCall.error) return fail(ctx, itemCall.error, itemCall.error.message);
	const item = isRecord(itemCall.value) ? itemCall.value : undefined;
	if (
		!item ||
		item.id !== binding.workItemId ||
		item.projectId !== binding.projectId ||
		item.orgId !== runtime.organizationId
	)
		throw new Error(
			"work checkpoint selected Work identity, project or organization mismatch",
		);
	const input = { workItemId: binding.workItemId, states: ["open"], limit: 5 };
	const inboxCall = await boardCall(
		ctx,
		"work.list_work_interaction_cli_rows",
		input,
	);
	if (inboxCall.error)
		return fail(ctx, inboxCall.error, inboxCall.error.message);
	const page = inboxCall.value;
	if (
		!isRecord(page) ||
		!Array.isArray(page.data) ||
		page.data.length > 5 ||
		typeof page.observedAt !== "string" ||
		typeof page.hasMore !== "boolean" ||
		!WorkInteractionCursorSchema.nullable().safeParse(page.nextCursor).success
	)
		throw new Error(
			"Malformed checkpoint inbox page; no current decisions were established",
		);
	const requests: Record<string, unknown>[] = [];
	for (const row of page.data) {
		if (!isRecord(row) || !isRecord(row.request))
			throw new Error("Malformed checkpoint interaction");
		const request = row.request;
		if (request.workItemId !== item.id || request.orgId !== item.orgId)
			throw new Error(
				"Checkpoint interaction belongs to another Work or organization",
			);
		if (row.canRespond !== true || row.effectiveState !== "open") continue;
		if (
			typeof request.id !== "string" ||
			!isUuid(request.id) ||
			!Number.isInteger(request.version) ||
			Number(request.version) < 1 ||
			typeof request.prompt !== "string" ||
			typeof request.subject !== "string"
		)
			throw new Error("Malformed actionable checkpoint interaction");
		requests.push({
			id: request.id,
			version: request.version,
			kind: request.kind,
			subject: request.subject.slice(0, 300),
			prompt: request.prompt.slice(0, 800),
			promptComplete:
				request.promptComplete === true && request.prompt.length <= 800,
			requestedFromType: request.requestedFromType,
			requestedFromId: request.requestedFromId,
			requestedAt: request.requestedAt,
		});
	}
	const value = {
		workItem: {
			id: item.id,
			projectId: item.projectId,
			organizationId: item.orgId,
			disposition: item.disposition,
		},
		chatId: binding.contextSessionId,
		observedAt: page.observedAt,
		requests,
		nextCursor: page.nextCursor,
		hasMore: page.hasMore,
		receipt: "retrieved",
		guidance:
			"Retrieval is not acknowledgment or action. Read truncated requests with work interaction-get <id>. Explicitly acknowledge with work interaction-respond <id> --input containing expectedRequestVersion, the responseKind its kind takes (question: answer, input: input_provided, handoff: handoff_accepted or handoff_declined, coordination: coordination_update), body and resolvesRequest=false; record acted/deferred separately with evidence. No execution authority changed.",
	};
	return ok(ctx, value, () => console.log(JSON.stringify(value, null, 2)));
}
