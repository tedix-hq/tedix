import type {
	AgentEvent,
	AgentEventInput,
	AgentEventListener,
	AgentEvents,
	AgentJson,
	AgentSubscribeOptions,
} from "./index";
import type { SqliteAgentStorage } from "./sql-storage";

/** The WebSocket side of a Durable Object this module uses. */
export interface WebSocketHost {
	acceptWebSocket(ws: WebSocket, tags?: string[]): void;
	getWebSockets(tag?: string): WebSocket[];
}

/** A client asks for the stored events after a cursor (after a reconnect). */
export interface AgentReplayRequest {
	readonly kind: "replay";
	readonly after: number;
}

const EVENTS_TABLE = "agent_runtime_events";
const SOCKET_TAG = "agent-events";
const DEFAULT_RETAINED = 10_000;
const DEFAULT_REPLAY_LIMIT = 1_000;

type EventRow = {
	event_cursor: number;
	event_type: string;
	event_payload: string;
	event_at: number;
};

function rowToEvent(row: EventRow): AgentEvent {
	return {
		cursor: row.event_cursor,
		type: row.event_type,
		payload: JSON.parse(row.event_payload) as AgentJson,
		at: row.event_at,
	};
}

export interface SqliteAgentEventsOptions {
	/** Oldest events are dropped past this many. */
	readonly retained?: number;
}

/**
 * The event feed, stored in the object's SQLite so a cursor survives
 * restarts and hibernation. Live delivery goes to in-object listeners and to
 * every accepted WebSocket; replay reads the table.
 */
export class SqliteAgentEvents implements AgentEvents {
	private readonly listeners = new Set<AgentEventListener>();
	private readonly retained: number;

	constructor(
		private readonly storage: SqliteAgentStorage,
		private readonly sockets: WebSocketHost,
		options: SqliteAgentEventsOptions = {},
	) {
		this.retained = options.retained ?? DEFAULT_RETAINED;
		void storage.exec(
			`CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (` +
				"event_cursor INTEGER PRIMARY KEY AUTOINCREMENT, " +
				"event_type TEXT NOT NULL, " +
				"event_payload TEXT NOT NULL, " +
				"event_at INTEGER NOT NULL)",
		);
	}

	async publish(input: AgentEventInput): Promise<AgentEvent> {
		if (!input.type.trim()) throw new Error("An event needs a type");
		const at = Date.now();
		const payload = JSON.stringify(input.payload ?? null);
		await this.storage.exec(
			`INSERT INTO ${EVENTS_TABLE} (event_type, event_payload, event_at) VALUES (?, ?, ?)`,
			[input.type, payload, at],
		);
		const [row] = await this.storage.query<{ last_cursor: number }>(
			"SELECT last_insert_rowid() AS last_cursor",
		);
		const cursor = row?.last_cursor ?? 0;
		await this.storage.exec(
			`DELETE FROM ${EVENTS_TABLE} WHERE event_cursor <= ?`,
			[cursor - this.retained],
		);
		const event: AgentEvent = {
			cursor,
			type: input.type,
			payload: input.payload ?? null,
			at,
		};
		this.deliver(event);
		return event;
	}

	async subscribe(
		listener: AgentEventListener,
		options: AgentSubscribeOptions = {},
	): Promise<() => void> {
		if (options.after !== undefined) {
			for (const event of await this.replay(options.after)) listener(event);
		}
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async replay(
		after: number,
		limit = DEFAULT_REPLAY_LIMIT,
	): Promise<AgentEvent[]> {
		const rows = await this.storage.query<EventRow>(
			`SELECT event_cursor, event_type, event_payload, event_at FROM ${EVENTS_TABLE} ` +
				"WHERE event_cursor > ? ORDER BY event_cursor ASC LIMIT ?",
			[after, limit],
		);
		return rows.map(rowToEvent);
	}

	async head(): Promise<number> {
		const [row] = await this.storage.query<{ head_cursor: number | null }>(
			`SELECT MAX(event_cursor) AS head_cursor FROM ${EVENTS_TABLE}`,
		);
		return row?.head_cursor ?? 0;
	}

	async connect(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade", { status: 426 });
		}
		const after = Number(new URL(request.url).searchParams.get("after") ?? "");
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.sockets.acceptWebSocket(server, [SOCKET_TAG]);
		if (Number.isFinite(after)) await this.send(server, after);
		return new Response(null, { status: 101, webSocket: client });
	}

	connections(): number {
		return this.sockets.getWebSockets(SOCKET_TAG).length;
	}

	/**
	 * The object's `webSocketMessage` hands client messages here. The only
	 * message a client sends is a replay request.
	 */
	async handleMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		if (typeof message !== "string") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(message);
		} catch {
			return;
		}
		const request = parsed as Partial<AgentReplayRequest> | null;
		if (
			request?.kind === "replay" &&
			typeof request.after === "number" &&
			Number.isFinite(request.after)
		) {
			await this.send(ws, request.after);
		}
	}

	private async send(ws: WebSocket, after: number): Promise<void> {
		for (const event of await this.replay(after)) {
			ws.send(JSON.stringify({ kind: "event", ...event }));
		}
	}

	private deliver(event: AgentEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// One listener's failure must not hide the event from the others.
			}
		}
		const message = JSON.stringify({ kind: "event", ...event });
		for (const ws of this.sockets.getWebSockets(SOCKET_TAG)) {
			try {
				ws.send(message);
			} catch {
				// A closing socket drops out of getWebSockets on its own.
			}
		}
	}
}
