/**
 * Append-only event ledger in the workspace's own SQLite. Every frame the UI
 * sees lands here first, so a subscriber that connects late or reconnects
 * replays from any sequence number, per conversation or object-wide.
 */
import type { WorkspaceStorage } from "./runtime";
import type { WireEvent, WireEventBody } from "./wire";

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
`;

/** Retain this many events; older rows are trimmed when the object is idle. */
export const EVENT_RETENTION = 100_000;

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

	/** Events after `afterSeq`, oldest first; one conversation or all. */
	replay(
		afterSeq: number,
		conversationId: string | null,
		limit = 1_000,
	): WireEvent[] {
		const bounded = Math.min(Math.max(limit, 1), 5_000);
		const rows = conversationId
			? this.storage.exec<EventRow>(
					"SELECT * FROM events WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
					conversationId,
					afterSeq,
					bounded,
				)
			: this.storage.exec<EventRow>(
					"SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?",
					afterSeq,
					bounded,
				);
		return rows.map(rowToEvent);
	}

	/** The newest events before `beforeSeq` (history paging), oldest first. */
	history(
		conversationId: string,
		beforeSeq: number | null,
		limit = 500,
	): WireEvent[] {
		const bounded = Math.min(Math.max(limit, 1), 5_000);
		return this.storage
			.exec<EventRow>(
				"SELECT * FROM (SELECT * FROM events WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC",
				conversationId,
				beforeSeq ?? Number.MAX_SAFE_INTEGER,
				bounded,
			)
			.map(rowToEvent);
	}

	latestSeq(): number {
		const [row] = this.storage.exec<{ seq: number | null }>(
			"SELECT MAX(seq) AS seq FROM events",
		);
		return row?.seq ?? 0;
	}

	trim(): void {
		this.storage.run(
			"DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?",
			EVENT_RETENTION,
		);
	}
}
