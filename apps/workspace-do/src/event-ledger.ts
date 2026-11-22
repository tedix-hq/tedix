/**
 * Append-only event ledger in the workspace's own SQLite. Every frame the UI
 * sees lands here first, so a subscriber that connects late or reconnects
 * replays from any sequence number, per conversation or object-wide.
 */
import type { WorkspaceStorage } from "./runtime";
import type { UsageTotals, WireEvent, WireEventBody } from "./wire";

export const EVENT_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	conversation_id TEXT NOT NULL,
	turn_id TEXT,
	at TEXT NOT NULL,
	type TEXT NOT NULL,
	body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_conversation ON events(conversation_id, seq);
CREATE INDEX IF NOT EXISTS events_turn_at ON events(turn_id, at);
CREATE INDEX IF NOT EXISTS events_reply_usage ON events(conversation_id) WHERE type = 'assistant.done';
`;

/** Retain this many events; older rows are trimmed when the object is idle. */
export const EVENT_RETENTION = 100_000;

/**
 * The most event-body characters one replay or history page carries. A write
 * step keeps the whole written file in its event, so a busy chat reaches tens
 * of megabytes; loading that in one read exceeds the object's memory.
 */
export const EVENT_PAGE_CHARS = 4_000_000;

export interface EventPage {
	events: WireEvent[];
	/** Events remain beyond this page, in the direction it was read. */
	more: boolean;
}

interface EventRow {
	seq: number;
	conversation_id: string;
	turn_id: string | null;
	at: string;
	type: string;
	body: string;
}

function rowToEvent(row: EventRow): WireEvent {
	const body = JSON.parse(row.body) as WireEventBody;
	return {
		seq: row.seq,
		at: row.at,
		conversationId: row.conversation_id,
		...(row.turn_id ? { turnId: row.turn_id } : {}),
		...body,
	} as WireEvent;
}

export class SqlEventLedger {
	constructor(
		private readonly storage: WorkspaceStorage,
		private readonly push: (event: WireEvent) => void,
		private readonly now: () => Date = () => new Date(),
	) {
		storage.run(EVENT_LEDGER_SCHEMA);
	}

	append(conversationId: string, body: WireEventBody): WireEvent {
		const at = this.now().toISOString();
		const turnId = "turnId" in body ? body.turnId : null;
		const [row] = this.storage.exec<EventRow>(
			"INSERT INTO events (conversation_id, turn_id, at, type, body) VALUES (?, ?, ?, ?, ?) RETURNING *",
			conversationId,
			turnId,
			at,
			body.type,
			JSON.stringify(body),
		);
		if (!row) throw new Error("event insert returned no row");
		const event = rowToEvent(row);
		this.push(event);
		return event;
	}

	/**
	 * Events after `afterSeq`, oldest first; one conversation or all. Stops at
	 * `EVENT_PAGE_CHARS`, so a caller that needs the rest asks again from the
	 * last seq it received.
	 */
	replay(
		afterSeq: number,
		conversationId: string | null,
		limit = 1_000,
	): WireEvent[] {
		return this.replayPage(afterSeq, conversationId, limit).events;
	}

	/** One bounded step of a replay; `more` says events remain after it. */
	replayPage(
		afterSeq: number,
		conversationId: string | null,
		limit = 1_000,
		maxChars = EVENT_PAGE_CHARS,
	): EventPage {
		return this.#page("after", afterSeq, conversationId, limit, maxChars);
	}

	/** The newest events before `beforeSeq` (history paging), oldest first. */
	history(
		conversationId: string,
		beforeSeq: number | null,
		limit = 500,
	): WireEvent[] {
		return this.historyPage(conversationId, beforeSeq, limit).events;
	}

	/** One bounded history page; `more` says older events remain before it. */
	historyPage(
		conversationId: string,
		beforeSeq: number | null,
		limit = 500,
		maxChars = EVENT_PAGE_CHARS,
	): EventPage {
		return this.#page(
			"before",
			beforeSeq ?? Number.MAX_SAFE_INTEGER,
			conversationId,
			limit,
			maxChars,
		);
	}

	/**
	 * Sizes are read first, so only the bodies that fit are loaded. A single
	 * event larger than the budget is still returned, alone.
	 */
	#page(
		direction: "after" | "before",
		seq: number,
		conversationId: string | null,
		limit: number,
		maxChars: number,
	): EventPage {
		const bounded = Math.min(Math.max(limit, 1), 5_000);
		const scope = conversationId ? "conversation_id = ? AND " : "";
		const scopeParams = conversationId ? [conversationId] : [];
		const sizes = this.storage.exec<{ seq: number; size: number }>(
			direction === "after"
				? `SELECT seq, LENGTH(body) AS size FROM events WHERE ${scope}seq > ? ORDER BY seq ASC LIMIT ?`
				: `SELECT seq, LENGTH(body) AS size FROM events WHERE ${scope}seq < ? ORDER BY seq DESC LIMIT ?`,
			...scopeParams,
			seq,
			bounded + 1,
		);
		let taken = 0;
		let chars = 0;
		for (const row of sizes) {
			if (taken === bounded || (taken > 0 && chars + row.size > maxChars))
				break;
			chars += row.size;
			taken += 1;
		}
		const edge = sizes[taken - 1]?.seq;
		if (edge === undefined) return { events: [], more: false };
		const rows = this.storage.exec<EventRow>(
			`SELECT * FROM events WHERE ${scope}seq >= ? AND seq <= ? ORDER BY seq ASC`,
			...scopeParams,
			direction === "after" ? seq + 1 : edge,
			direction === "after" ? edge : seq - 1,
		);
		return { events: rows.map(rowToEvent), more: taken < sizes.length };
	}

	/** One turn's events of one type, oldest first. */
	ofTurn(turnId: string, type: WireEventBody["type"]): WireEvent[] {
		return this.storage
			.exec<EventRow>(
				"SELECT * FROM events WHERE turn_id = ? AND type = ? ORDER BY seq ASC",
				turnId,
				type,
			)
			.map(rowToEvent);
	}

	hasChatFile(conversationId: string, resourceId: string): boolean {
		return (
			this.storage.exec<{ present: number }>(
				`SELECT 1 AS present FROM events, json_each(events.body, '$.attachments') AS file
			 WHERE events.conversation_id = ? AND events.type IN ('turn.started', 'message.queued', 'message.read', 'message.returned')
			   AND json_extract(file.value, '$.chatOnly') = 1
			   AND json_extract(file.value, '$.outputId') = ?
			 LIMIT 1`,
				conversationId,
				resourceId,
			).length > 0
		);
	}

	latestSeq(): number {
		const [row] = this.storage.exec<{ seq: number | null }>(
			"SELECT MAX(seq) AS seq FROM events",
		);
		return row?.seq ?? 0;
	}

	/**
	 * Usage of every finished reply still in the ledger, per conversation.
	 * Replies older than `EVENT_RETENTION` events are no longer counted.
	 */
	usageByConversation(): Map<string, UsageTotals> {
		const rows = this.storage.exec<{
			conversation_id: string;
			input_tokens: number;
			output_tokens: number;
			cost_usd: number | null;
			unpriced: number;
		}>(
			`SELECT conversation_id,
				SUM(input) AS input_tokens,
				SUM(output) AS output_tokens,
				SUM(cost) AS cost_usd,
				SUM(cost IS NULL) AS unpriced
			FROM (
				SELECT conversation_id,
					coalesce(json_extract(body, '$.usage.inputTokens'), 0) AS input,
					coalesce(json_extract(body, '$.usage.outputTokens'), 0) AS output,
					json_extract(body, '$.usage.costUsd') AS cost
				FROM events
				WHERE type = 'assistant.done' AND json_type(body, '$.usage') = 'object'
			)
			-- Older runtimes wrote zero usage when the provider reported none.
			WHERE input + output > 0 OR cost IS NOT NULL
			GROUP BY conversation_id`,
		);
		return new Map(
			rows.map((row) => [
				row.conversation_id,
				{
					inputTokens: row.input_tokens,
					outputTokens: row.output_tokens,
					...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
					...(row.unpriced > 0 ? { unpricedReplies: row.unpriced } : {}),
				},
			]),
		);
	}

	trim(): void {
		this.storage.run(
			"DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?",
			EVENT_RETENTION,
		);
	}
}

/** The most characters of a write payload an event keeps inline. */
export const EVENT_INPUT_CHARS = 2_000;

/**
 * A write payload for an event. The full arguments live in the approvals
 * table, so a large payload is replaced by its size and top-level keys
 * instead of being stored again in every event that mentions it.
 */
export function boundedEventInput(input: unknown): unknown {
	if (input === undefined) return undefined;
	const text = JSON.stringify(input) ?? "";
	if (text.length <= EVENT_INPUT_CHARS) return input;
	return {
		truncated: true,
		chars: text.length,
		...(input && typeof input === "object" && !Array.isArray(input)
			? { keys: Object.keys(input).slice(0, 20) }
			: {}),
	};
}

/** The most characters of a step's code or result an event keeps. */
export const EVENT_TEXT_CHARS = 4_000;

/** Code or a result for an event: the start of it, and how much was left out. */
export function boundedEventText(text: string, max = EVENT_TEXT_CHARS): string {
	return text.length <= max
		? text
		: `${text.slice(0, max)}\n… ${text.length - max} more characters not shown`;
}

/** Adds conversation totals together; `undefined` when there is nothing to add. */
export function sumUsageTotals(
	totals: Iterable<UsageTotals>,
): UsageTotals | undefined {
	let sum: UsageTotals | undefined;
	for (const item of totals) {
		const costUsd =
			item.costUsd === undefined
				? sum?.costUsd
				: (sum?.costUsd ?? 0) + item.costUsd;
		const unpricedReplies =
			(sum?.unpricedReplies ?? 0) + (item.unpricedReplies ?? 0);
		sum = {
			inputTokens: (sum?.inputTokens ?? 0) + item.inputTokens,
			outputTokens: (sum?.outputTokens ?? 0) + item.outputTokens,
			...(costUsd === undefined ? {} : { costUsd }),
			...(unpricedReplies > 0 ? { unpricedReplies } : {}),
		};
	}
	return sum;
}
