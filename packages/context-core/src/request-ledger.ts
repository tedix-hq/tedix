/**
 * Request ledger: the observer and reflector for a person's own local agent
 * sessions (Claude Code, Codex), in the shape of the tedi observer/reflector.
 *
 * The observer reads one message the person sent and extracts each distinct
 * request, question or decision as a ledger row. The reflector reads the
 * agent's turn, with a digest of its activity (tool failures, delegated
 * subagents and their reports), moves the open rows it touched, and records
 * the agent's own promises and open loops (a lane started with no report back)
 * as new rows. Completion needs evidence,
 * as the tedi observer's rule 10 does: a row only becomes `done` with a commit
 * SHA, a link, or a quote that appears in the turn itself
 * ({@link acceptedDoneEvidence}); anything else stays `in_progress`.
 *
 * Runtime-neutral: callers own the model call and persistence.
 */

export type LedgerRequestKind =
	| "request"
	| "question"
	| "decision"
	| "promise"
	| "open_loop";
export type LedgerRequestStatus =
	| "open"
	| "in_progress"
	| "waiting_on_user"
	| "dropped_risk"
	| "done"
	| "cancelled";

/** Most requests one message may yield. */
export const LEDGER_MAX_REQUESTS_PER_MESSAGE = 8;
/** Longest request text kept, in characters. */
export const LEDGER_REQUEST_TEXT_LIMIT = 300;
/** Longest evidence kept, in characters. */
export const LEDGER_EVIDENCE_LIMIT = 300;

/** A ledger row as the models see it: a short reference and its words. */
export interface LedgerRowRef {
	ref: string;
	text: string;
	status: LedgerRequestStatus;
}

export const REQUEST_OBSERVER_SYSTEM_PROMPT = `You watch a person's messages to their coding agent and keep a ledger of what they asked for, so no request is lost.

Read the NEW MESSAGE. Extract each distinct thing the person wants the agent to do, answer or honor:
- "request": work to do (build, fix, change, check, send, write, deploy, report, remember).
- "question": something the person wants answered.
- "decision": a choice or rule the person set that the agent must follow ("use X, not Y", "never do Z").

Rules:
1. One row per distinct request. Split a message that asks for several things. Never merge unrelated asks.
2. Write each row in plain words, imperative, self-contained, at most 25 words, keeping exact names, paths, ids and numbers. Example: "Add a changeset for the CLI hook change".
3. Skip acknowledgements and steering with no new ask ("ok", "yes", "continue", "thanks", "go on"), greetings, pasted logs, and context that asks nothing.
4. A follow-up that only restates an OPEN ROW is not a new row. If it changes the row's scope, write the new scope as a new row and list the old ref in "cancelled".
5. When the person withdraws an open row ("forget X", "skip that", "no need for X"), list its ref in "cancelled".
6. At most ${LEDGER_MAX_REQUESTS_PER_MESSAGE} rows. Most messages have 0 to 3.

Return ONLY this JSON object:
{"requests":[{"kind":"request"|"question"|"decision","text":"..."}],"cancelled":["ref", ...]}`;

export const REQUEST_REFLECTOR_SYSTEM_PROMPT = `You keep a ledger of a person's requests to their coding agent honest. You read the agent's latest TURN, an ACTIVITY digest of what it did during the turn (tool failures, subagents or other agents it started, their reports), and the OPEN ROWS.

1. Say which OPEN ROWS the turn moved, in "updates":
- "in_progress": the turn worked on the row but did not finish it.
- "done": the turn finished the row. Give "evidence": a commit SHA, a URL, or a SHORT EXACT QUOTE copied from the TURN or ACTIVITY that shows it finished (for a question, the quote that answers it; for an open loop, the quote of the report that came back). No evidence, not done. A question the turn answers, an explanation it gives, a choice it confirms, or a request it reports finished IS done: quote the sentence that answers or reports it. Check every OPEN ROW against the turn; most turns finish at least the latest message's rows.
- "waiting_on_user": the turn needs something from the person to continue (a decision, an approval, a credential, a click).
- "dropped_risk": the turn claims the work is complete, or moves on, while this row was clearly not done, or the turn promised to do it later without doing it.
Only list rows the turn actually touched. Never mark done from topic drift or a plan. Copy the ref exactly.

2. Record what the agent now owes, in "new":
- "promise": the agent committed to a concrete follow-up it has not done yet ("I'll report the result", "next I will check X", "I'll send the list").
- "open_loop": the agent started a lane that must report back and has not yet (a background subagent, a delegated Codex run, a deploy or CI run it is waiting on).
Write each in plain words, at most 25 words, keeping exact names. Skip anything an OPEN ROW already covers, anything finished in this same turn, and routine steps. Most turns have none.

Keep evidence under 200 characters. Return ONLY this JSON object:
{"updates":[{"ref":"...","status":"in_progress"|"done"|"waiting_on_user"|"dropped_risk","evidence":"..."}],"new":[{"kind":"promise"|"open_loop","text":"..."}]}`;

function rowsBlock(rows: readonly LedgerRowRef[]): string {
	if (!rows.length) return "OPEN ROWS: none";
	return `OPEN ROWS:\n${rows
		.map((row) => `- ref=${row.ref} [${row.status}] ${row.text}`)
		.join("\n")}`;
}

export function requestObserverInput(
	message: string,
	openRows: readonly LedgerRowRef[],
): string {
	return `${rowsBlock(openRows)}\n\nNEW MESSAGE:\n<<<\n${message}\n>>>`;
}

export function requestReflectorInput(
	turn: string,
	openRows: readonly LedgerRowRef[],
	activity = "",
): string {
	return `${rowsBlock(openRows)}\n\nACTIVITY:\n<<<\n${activity || "none recorded"}\n>>>\n\nTURN:\n<<<\n${turn}\n>>>`;
}

/** The first JSON object in a model reply, or null. */
function jsonObject(raw: string | null): Record<string, unknown> | null {
	if (!raw) return null;
	const text = raw
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "");
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const value: unknown = JSON.parse(text.slice(start, end + 1));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function oneLine(value: unknown, limit: number): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

const KINDS = new Set<LedgerRequestKind>(["request", "question", "decision"]);
const OWED = new Set<LedgerRequestKind>(["promise", "open_loop"]);

/** The reflector's new promise and open-loop rows; empty on a bad reply. */
export function parseReflectedNewRows(
	raw: string | null,
): Array<{ kind: LedgerRequestKind; text: string }> {
	const value = jsonObject(raw);
	if (!value || !Array.isArray(value.new)) return [];
	const seen = new Set<string>();
	const rows: Array<{ kind: LedgerRequestKind; text: string }> = [];
	for (const item of value.new) {
		if (!item || typeof item !== "object") continue;
		const { kind, text } = item as { kind?: unknown; text?: unknown };
		const words = oneLine(text, LEDGER_REQUEST_TEXT_LIMIT);
		const key = words.toLowerCase();
		if (words.length < 3 || seen.has(key)) continue;
		if (!OWED.has(kind as LedgerRequestKind)) continue;
		seen.add(key);
		rows.push({ kind: kind as LedgerRequestKind, text: words });
		if (rows.length >= LEDGER_MAX_REQUESTS_PER_MESSAGE) break;
	}
	return rows;
}

/** Observer output, or null when the reply is not the expected JSON. */
export function parseObservedRequests(
	raw: string | null,
	refs: ReadonlySet<string>,
): {
	requests: Array<{ kind: LedgerRequestKind; text: string }>;
	cancelled: string[];
} | null {
	const value = jsonObject(raw);
	if (!value || !Array.isArray(value.requests)) return null;
	const seen = new Set<string>();
	const requests: Array<{ kind: LedgerRequestKind; text: string }> = [];
	for (const item of value.requests) {
		if (!item || typeof item !== "object") continue;
		const { kind, text } = item as { kind?: unknown; text?: unknown };
		const words = oneLine(text, LEDGER_REQUEST_TEXT_LIMIT);
		const key = words.toLowerCase();
		if (words.length < 3 || seen.has(key)) continue;
		seen.add(key);
		requests.push({
			kind: KINDS.has(kind as LedgerRequestKind)
				? (kind as LedgerRequestKind)
				: "request",
			text: words,
		});
		if (requests.length >= LEDGER_MAX_REQUESTS_PER_MESSAGE) break;
	}
	const cancelled = Array.isArray(value.cancelled)
		? [
				...new Set(
					value.cancelled.filter(
						(ref): ref is string => typeof ref === "string" && refs.has(ref),
					),
				),
			]
		: [];
	return { requests, cancelled };
}

const REFLECTED = new Set<LedgerRequestStatus>([
	"in_progress",
	"done",
	"waiting_on_user",
	"dropped_risk",
]);

const SHA = /\b[0-9a-f]{7,40}\b/i;
const URL = /\bhttps?:\/\/[^\s)>\]]+/i;

function squash(text: string): string {
	return text
		.toLowerCase()
		.replace(/[`*_"'“”‘’]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Evidence that may close a row: a commit SHA or URL that appears in the turn,
 * or a quote of at least 12 characters found verbatim (ignoring case,
 * whitespace and markdown emphasis) in the turn. Null otherwise.
 */
export function acceptedDoneEvidence(
	evidence: unknown,
	turn: string,
): string | null {
	const text = oneLine(evidence, LEDGER_EVIDENCE_LIMIT);
	if (!text) return null;
	const haystack = squash(turn);
	const sha = SHA.exec(text)?.[0];
	if (sha && /\d/.test(sha) && haystack.includes(sha.toLowerCase()))
		return text;
	const url = URL.exec(text)?.[0];
	if (url && haystack.includes(url.toLowerCase().replace(/[.,;:]+$/, "")))
		return text;
	const quote = squash(text.replace(/^…|…$/g, ""));
	if (quote.length >= 12 && haystack.includes(quote)) return text;
	// A lightly trimmed quote still counts: at least four of its words, and
	// nearly all of them, appear in the turn.
	const words = quote.split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
	const present = new Set(haystack.split(/[^a-z0-9]+/));
	const found = words.filter((word) => present.has(word)).length;
	return words.length >= 4 && found >= Math.ceil(words.length * 0.85)
		? text
		: null;
}

/**
 * Reflector output as status changes, or null when the reply is not the
 * expected JSON. A `done` without accepted evidence becomes `in_progress`.
 */
export function parseReflectedUpdates(
	raw: string | null,
	refs: ReadonlySet<string>,
	turn: string,
): Array<{
	ref: string;
	status: LedgerRequestStatus;
	evidence: string | null;
}> | null {
	const value = jsonObject(raw);
	if (!value || !Array.isArray(value.updates)) return null;
	const byRef = new Map<
		string,
		{ ref: string; status: LedgerRequestStatus; evidence: string | null }
	>();
	for (const item of value.updates) {
		if (!item || typeof item !== "object") continue;
		const { ref, status, evidence } = item as Record<string, unknown>;
		if (typeof ref !== "string" || !refs.has(ref)) continue;
		if (!REFLECTED.has(status as LedgerRequestStatus)) continue;
		if (status === "done") {
			const proof = acceptedDoneEvidence(evidence, turn);
			byRef.set(
				ref,
				proof
					? { ref, status: "done", evidence: proof }
					: { ref, status: "in_progress", evidence: null },
			);
			continue;
		}
		byRef.set(ref, {
			ref,
			status: status as LedgerRequestStatus,
			evidence: oneLine(evidence, LEDGER_EVIDENCE_LIMIT) || null,
		});
	}
	return [...byRef.values()];
}
