import { cyan, dim, green, red, yellow } from "./format";
import type { ColorMode } from "./terminal";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { type WorkContext } from "./work";
import { WORK_EXIT_FAIL, type BoardError } from "./work-identity";

// ─── Output ──────────────────────────────────────────────────────────────────

export function fail(
	ctx: WorkContext,
	error: BoardError,
	humanLine: string,
): number {
	if (ctx.json) {
		console.log(JSON.stringify({ error }));
	} else {
		console.error(humanLine);
	}
	return WORK_EXIT_FAIL;
}

export function ok(
	ctx: WorkContext,
	value: unknown,
	render: () => void,
): number {
	if (ctx.json) console.log(JSON.stringify(value));
	else render();
	return 0;
}

function shortId(id: unknown): string {
	return typeof id === "string" && id.length >= 8 ? id.slice(0, 8) : "—";
}

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function itemsFromList(value: unknown): Record<string, unknown>[] {
	const rows =
		isRecord(value) && Array.isArray(value.data)
			? value.data
			: Array.isArray(value)
				? value
				: [];
	return rows.filter(isRecord);
}

export function dispositionPaint(
	disposition: string,
	color: ColorMode,
): string {
	if (disposition === "completed") return green(disposition, color);
	if (disposition === "cancelled") return red(disposition, color);
	if (disposition === "proposed") return yellow(disposition, color);
	return cyan(disposition, color);
}

/** Pad a possibly-colorized cell to a visible width, ignoring ANSI length. */
function padCell(rawText: string, painted: string, width: number): string {
	const pad = Math.max(0, width - rawText.length);
	return painted + " ".repeat(pad);
}

/** Pad that never truncates — callers shorten deliberately. */
function padEnd(value: string, width: number): string {
	return value.length >= width ? value : value.padEnd(width);
}

/**
 * Who is holding a Work Item right now, in one short cell.
 *
 * An agent session key is the useful identity (`codex:…`, `claude-code:…`) and
 * the harness prefix is the part a reader scans, so the prefix survives and the
 * uuid is clipped. A tedi or an unkeyed executor falls back to its executor id.
 */
export function workItemHolderLabel(active: unknown): string {
	if (!active || typeof active !== "object") return "—";
	const row = active as Record<string, unknown>;
	const session = typeof row.agentSession === "string" ? row.agentSession : "";
	if (session) {
		const [harness, id = ""] = session.split(":");
		return id ? `${harness}:${id.slice(0, 8)}` : truncate(session, 22);
	}
	const executor = typeof row.executorId === "string" ? row.executorId : "";
	return executor ? truncate(executor, 22) : "held";
}

export function renderWorkItemsTable(
	items: Record<string, unknown>[],
	color: ColorMode,
): string {
	if (items.length === 0) return dim("No work items.", color);
	const lines = [
		dim(
			`${"ID".padEnd(8)}  ${"KIND".padEnd(13)}  ${"DISPOSITION".padEnd(11)}  ${"RISK".padEnd(8)}  ${"HOLDER".padEnd(22)}  TITLE`,
			color,
		),
	];
	for (const item of items) {
		const id = shortId(item.id).padEnd(8);
		const kind = String(item.workKind ?? "—").padEnd(13);
		const rawDisposition = String(item.disposition ?? "—");
		const disposition = padCell(
			rawDisposition,
			dispositionPaint(rawDisposition, color),
			11,
		);
		const risk = String(item.riskLevel ?? "—").padEnd(8);
		// PRI was the least useful column here — every row in practice reads
		// "medium" — and "who is holding this right now" is the question a
		// second agent actually arrives with. Priority is still in --json.
		const holder = padEnd(workItemHolderLabel(item.activeAttempt), 22);
		const title = truncate(String(item.title ?? ""), 44);
		lines.push(`${id}  ${kind}  ${disposition}  ${risk}  ${holder}  ${title}`);
	}
	return lines.join("\n");
}

export function renderContextBrief(
	value: Record<string, unknown>,
	color: ColorMode,
): void {
	const item = isRecord(value.workItem) ? value.workItem : {};
	const comments = Array.isArray(value.comments)
		? value.comments.filter(isRecord)
		: [];
	const projections = Array.isArray(value.projections)
		? value.projections.filter(isRecord)
		: [];

	console.log(
		`${cyan(String(item.title ?? "(untitled)"), color)}  ${dim(shortId(item.id), color)}`,
	);
	console.log(
		`  ${String(item.workKind ?? "—")} · ${dispositionPaint(String(item.disposition ?? "—"), color)} · ${String(
			item.priority ?? "—",
		)} · owner ${shortId(item.accountableOwnerId)} · steward ${shortId(item.stewardId)}`,
	);
	if (item.reviewerId) {
		const lease =
			typeof item.reviewerLeaseExpiresAt === "string"
				? item.reviewerLeaseExpiresAt
				: "no lease";
		console.log(
			`  reviewer ${String(item.reviewerType ?? "?")}:${shortId(item.reviewerId)} · lease ${lease}`,
		);
	}
	if (typeof item.description === "string" && item.description.trim()) {
		console.log(`\n${item.description.trim()}`);
	}

	if (projections.length > 0) {
		console.log(dim("\nLinked / projections:", color));
		for (const p of projections) {
			const ref = p.externalUrl || p.externalId || "";
			console.log(`  · ${String(p.provider ?? "?")}: ${String(ref)}`);
		}
	}

	const recent = comments.slice(-5);
	if (recent.length > 0) {
		console.log(
			dim(`\nRecent comments (${recent.length} of ${comments.length}):`, color),
		);
		for (const c of recent) {
			const when =
				typeof c.createdAt === "string" ? c.createdAt.slice(0, 16) : "";
			console.log(
				`  ${dim(`[${String(c.eventType ?? "comment")}]`, color)} ${truncate(String(c.body ?? ""), 100)} ${dim(when, color)}`,
			);
		}
	}
}

/**
 * Compact machine brief for `work context --json` — the SAME selection the
 * concise terminal renderer shows, as data. The raw board payload carries the
 * full description, metadata, provenance, and every comment — materially more
 * than the renderer shows for identical information. Agents wanting the raw row can call
 * `work.get_work_items_by_id` through native transport directly.
 */
export function contextBriefJson(value: Record<string, unknown>): unknown {
	const item = isRecord(value.workItem) ? value.workItem : {};
	const comments = Array.isArray(value.comments)
		? value.comments.filter(isRecord)
		: [];
	const projections = Array.isArray(value.projections)
		? value.projections.filter(isRecord)
		: [];
	const project = isRecord(value.project) ? value.project : null;
	return {
		id: item.id ?? null,
		orgId: item.orgId ?? null,
		workKind: item.workKind ?? null,
		disposition: item.disposition ?? null,
		riskLevel: item.riskLevel ?? null,
		priority: item.priority ?? null,
		title: item.title ?? null,
		projectId: item.projectId ?? null,
		projectName: project?.name ?? null,
		projectBrief:
			typeof project?.description === "string"
				? project.description.trim()
				: null,
		accountableOwnerId: item.accountableOwnerId ?? null,
		stewardId: item.stewardId ?? null,
		reviewerId: item.reviewerId ?? null,
		// Read-only now. Nothing binds or enforces a reviewer since the review
		// plane was retired (decisions/minimal-gates-over-pre-proof.md);
		// these three are surfaced so an operator reading a Work Item accepted
		// before that still sees what its stored row says.
		reviewerType: item.reviewerType ?? null,
		reviewerLeaseExpiresAt: item.reviewerLeaseExpiresAt ?? null,
		description:
			typeof item.description === "string" ? item.description.trim() : null,
		acceptanceContract: item.acceptanceContract ?? null,
		links: projections.map((p) => ({
			provider: p.provider ?? null,
			ref: p.externalUrl ?? p.externalId ?? null,
		})),
		commentCount: comments.length,
		recentComments: comments.slice(-5).map((c) => ({
			eventType: c.eventType ?? "comment",
			body: truncate(String(c.body ?? ""), 400),
			createdAt: c.createdAt ?? null,
		})),
	};
}

/** Short, column-friendly principal label: `agent:1a2b3c4d`. */
export function principalLabel(type: unknown, id: unknown): string {
	const rawId = typeof id === "string" ? id.trim() : "";
	if (!rawId) return "—";
	const rawType = typeof type === "string" ? type.trim() : "";
	const kind = rawType === "external_agent" ? "agent" : rawType || "?";
	return `${kind}:${rawId.length > 8 ? rawId.slice(0, 8) : rawId}`;
}

/** Evidence dispositions paint differently from Work Item dispositions. */
function evidencePaint(disposition: string, color: ColorMode): string {
	if (disposition === "accepted") return green(disposition, color);
	if (disposition === "rejected") return red(disposition, color);
	if (disposition === "pending") return yellow(disposition, color);
	return dim(disposition, color);
}

/**
 * Client-side evidence filters.
 *
 * `work.list_work_item_evidence` takes only `{ id, cursor, limit }` — the board
 * exposes NO server-side claim-key or disposition filter — so these narrow the
 * page that was already fetched. Documented in `work --help` so nobody reads a
 * filtered page as an authoritative whole-ledger query.
 */
export function filterEvidenceRows(
	rows: Record<string, unknown>[],
	filters: { claimKey?: string; disposition?: string },
): Record<string, unknown>[] {
	const claimKey = filters.claimKey?.trim();
	const disposition = filters.disposition?.trim();
	return rows.filter((row) => {
		if (claimKey && String(row.claimKey ?? "") !== claimKey) return false;
		if (disposition && String(row.disposition ?? "") !== disposition)
			return false;
		return true;
	});
}

export function renderWorkEvidenceTable(
	rows: Record<string, unknown>[],
	color: ColorMode,
): string {
	if (rows.length === 0) return dim("No evidence.", color);
	const lines = [
		dim(
			`${"ID".padEnd(8)}  ${"CLAIM".padEnd(19)}  ${"KIND".padEnd(13)}  ${"DISPOSITION".padEnd(11)}  ${"SUBMITTED BY".padEnd(16)}  ${"REVIEWED BY".padEnd(16)}  URI`,
			color,
		),
	];
	for (const row of rows) {
		const id = shortId(row.id).padEnd(8);
		const claim = truncate(String(row.claimKey ?? "—"), 19).padEnd(19);
		const kind = truncate(String(row.kind ?? "—"), 13).padEnd(13);
		const rawDisposition = String(row.disposition ?? "—");
		const disposition = padCell(
			rawDisposition,
			evidencePaint(rawDisposition, color),
			11,
		);
		const submitter = truncate(
			principalLabel(row.submittedByType, row.submittedById),
			16,
		).padEnd(16);
		const reviewer = truncate(
			principalLabel(row.reviewedByType, row.reviewedById),
			16,
		).padEnd(16);
		const uri = truncate(String(row.uri ?? "—"), 60);
		lines.push(
			`${id}  ${claim}  ${kind}  ${disposition}  ${submitter}  ${reviewer}  ${uri}`,
		);
	}
	return lines.join("\n");
}

/**
 * The session that ran an attempt. `externalSessionKey` is the human-meaningful
 * one (`<harness>:<session-id>`); `executorSessionId` is its uuid. Prefer the
 * key, fall back to the uuid, and say so plainly when neither is present.
 */
export function attemptSessionLabel(row: Record<string, unknown>): string {
	const key = row.externalSessionKey;
	if (typeof key === "string" && key.trim()) return key.trim();
	const id = row.executorSessionId;
	if (typeof id === "string" && id.trim()) return shortId(id);
	return "—";
}

export function renderWorkAttemptsTable(
	rows: Record<string, unknown>[],
	color: ColorMode,
): string {
	if (rows.length === 0) return dim("No attempts.", color);
	const lines = [
		dim(
			`${"ID".padEnd(8)}  ${"#".padEnd(3)}  ${"STATE".padEnd(10)}  ${"OUTCOME".padEnd(10)}  ${"EXECUTOR".padEnd(16)}  ${"SESSION".padEnd(20)}  ${"STARTED".padEnd(16)}  HEARTBEAT`,
			color,
		),
	];
	for (const row of rows) {
		const id = shortId(row.id).padEnd(8);
		const number = String(row.attemptNumber ?? "—").padEnd(3);
		const state = String(row.runtimeState ?? "—").padEnd(10);
		const outcome = String(row.outcome ?? "—").padEnd(10);
		const executor = truncate(
			principalLabel(row.executorType, row.executorId),
			16,
		).padEnd(16);
		// Several agent sessions share one external-agent principal, so EXECUTOR
		// alone cannot say WHO ran an attempt — five orphaned attempts were
		// unattributable for exactly this reason. The row already carries the
		// answer; it just was not shown.
		const session = truncate(attemptSessionLabel(row), 20).padEnd(20);
		const started = timestampCell(row.startedAt).padEnd(16);
		const heartbeat = timestampCell(row.heartbeatAt);
		lines.push(
			`${id}  ${number}  ${state}  ${outcome}  ${executor}  ${session}  ${started}  ${heartbeat}`,
		);
	}
	return lines.join("\n");
}

export function renderWorkEventsTable(
	rows: Record<string, unknown>[],
	color: ColorMode,
): string {
	if (rows.length === 0) return dim("No events.", color);
	const lines = [
		dim(
			`${"SEQ".padEnd(6)}  ${"EVENT".padEnd(28)}  ${"ACTOR".padEnd(16)}  ${"ATTEMPT".padEnd(8)}  OCCURRED`,
			color,
		),
	];
	for (const row of rows) {
		const sequence = String(row.sequence ?? "—").padEnd(6);
		const eventType = truncate(String(row.eventType ?? "—"), 28).padEnd(28);
		const actor = truncate(
			principalLabel(row.actorType, row.actorId),
			16,
		).padEnd(16);
		const attempt = shortId(row.attemptId).padEnd(8);
		lines.push(
			`${sequence}  ${eventType}  ${actor}  ${attempt}  ${timestampCell(row.occurredAt)}`,
		);
	}
	return lines.join("\n");
}

/** `2026-08-28T18:00:00.000Z` → `2026-08-28 18:00` (16 visible columns). */
function timestampCell(value: unknown): string {
	if (typeof value !== "string" || value.length < 16) return "—";
	return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}
