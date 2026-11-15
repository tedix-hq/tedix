import {
	PoppyIdSchema,
	PoppyPostSchema,
} from "@tedix/api-contract/schemas/personal-agent-conversation";
import type { JsonValue } from "@tedix/api-contract/schemas/common";

type Owner = {
	organizationId: string;
	clientId: string;
	userId: string;
	version: string;
};
type Conversation = {
	id: string;
	owner: string;
	version: string;
	parent: string | null;
	direct: string | null;
	closed: boolean;
	handoff: "none" | "pending";
	responder: "agent" | "human";
	context: Record<string, JsonValue>;
	publicInstructions: string;
};
type Event = { id: string; type: string; created_at: string } & Record<
	string,
	JsonValue
>;
type StoredRequest = {
	id: string;
	conversation: string;
	path: string;
	body: string;
	status: number;
	pending: number;
	context: string;
	through_sequence: number;
	accepted_at: number;
};
export type PoppyReply = { httpStatus: number; body: JsonValue };
export type PoppyJob = {
	owner: string;
	id: string;
	conversation: string;
	acceptedAt: number;
	context: JsonValue;
	history: JsonValue[];
	publicInstructions: string;
};
type PoppyDesk = {
	conversationId: string;
	interactionId: string;
	pending: boolean;
	transcript: JsonValue;
};
export interface PoppySql {
	exec<T extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: SqlStorageValue[]
	): { toArray(): T[] };
}
class ProtocolError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		readonly details: Record<string, string> = {},
	) {
		super(code);
	}
}
const id = () => crypto.randomUUID().replaceAll("-", "");
const ownerKey = (owner: Owner) =>
	JSON.stringify([owner.organizationId, owner.clientId, owner.userId]);
function canonical(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k]!)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/** Owns only protocol state in the tedi's local SQLite; no shared D1 statements. */
export class PoppyConversations {
	constructor(
		private readonly sql: PoppySql,
		private readonly atomic: <T>(operation: () => T) => T,
	) {
		sql.exec(
			"CREATE TABLE IF NOT EXISTS poppy_conversations (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS poppy_requests (sequence INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, id TEXT NOT NULL, conversation TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL, status INTEGER NOT NULL, pending INTEGER NOT NULL, context TEXT NOT NULL, through_sequence INTEGER NOT NULL, accepted_at INTEGER NOT NULL, UNIQUE(owner,id))",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS poppy_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation TEXT NOT NULL, id TEXT NOT NULL UNIQUE, value TEXT NOT NULL)",
		);
		sql.exec(
			"CREATE INDEX IF NOT EXISTS poppy_events_conversation ON poppy_events(conversation,sequence)",
		);
		sql.exec(
			"CREATE INDEX IF NOT EXISTS poppy_pending ON poppy_requests(pending,sequence)",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS poppy_desks (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, root TEXT NOT NULL, pending INTEGER NOT NULL, through_sequence INTEGER NOT NULL)",
		);
	}
	private load(conversationId: string): Conversation {
		const row = this.sql
			.exec<{ value: string }>(
				"SELECT value FROM poppy_conversations WHERE id=?",
				conversationId,
			)
			.toArray()[0];
		if (!row) throw new ProtocolError("conversation_not_found", 404);
		return JSON.parse(row.value) as Conversation;
	}
	private owned(conversationId: string, owner: Owner): Conversation {
		const c = this.load(conversationId);
		if (c.owner !== ownerKey(owner))
			throw new ProtocolError("conversation_not_found", 404);
		if (c.version !== owner.version)
			throw new ProtocolError("version_mismatch", 409, {
				protocol_version: c.version,
			});
		return c;
	}
	private save(c: Conversation) {
		this.sql.exec(
			"INSERT INTO poppy_conversations(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
			c.id,
			JSON.stringify(c),
		);
	}
	private event(c: Conversation, value: Record<string, JsonValue>) {
		const e = { ...value, id: id(), created_at: new Date().toISOString() };
		this.sql.exec(
			"INSERT INTO poppy_events(conversation,id,value) VALUES (?,?,?)",
			c.id,
			e.id,
			JSON.stringify(e),
		);
		return e.id;
	}
	private state(c: Conversation) {
		this.event(c, {
			type: "state",
			handoff: c.handoff,
			responder: c.responder,
			closed: c.closed,
		});
		this.save(c);
	}
	private openDesk(c: Conversation, includesNewRequest = true) {
		const interactionId = crypto.randomUUID();
		this.sql.exec(
			"INSERT INTO poppy_desks(id,conversation,root,pending,through_sequence) SELECT ?,?,?,1,COALESCE(MAX(sequence),0)+? FROM poppy_requests",
			interactionId,
			c.id,
			c.parent ?? c.id,
			includesNewRequest ? 1 : 0,
		);
	}
	private close(c: Conversation) {
		if (c.closed) return;
		if (c.direct) this.close(this.load(c.direct));
		c.closed = true;
		c.handoff = "none";
		this.sql.exec(
			"UPDATE poppy_desks SET pending=0 WHERE conversation=?",
			c.id,
		);
		c.direct = null;
		this.sql.exec(
			"UPDATE poppy_requests SET pending=0 WHERE conversation=?",
			c.id,
		);
		this.state(c);
		if (c.parent) {
			const p = this.load(c.parent);
			p.direct = null;
			this.save(p);
			this.event(p, { type: "direct_closed", conversation_id: c.id });
		}
	}
	private message(
		c: Conversation,
		requestId: string,
		raw: NonNullable<ReturnType<typeof PoppyPostSchema.parse>["message"]>,
	) {
		const human = raw.author.type === "human";
		const m: Record<string, JsonValue> = {
			id: requestId,
			role: "user",
			author: { type: human ? "human" : "agent" },
		};
		for (const key of ["text", "data", "context"] as const)
			if (raw[key] !== undefined) m[key] = raw[key]!;
		// No extensions are advertised or negotiated by this signed-out implementation.
		if (!human && raw.as_of_cursor) m.as_of_cursor = raw.as_of_cursor;
		if (raw.context)
			for (const [key, value] of Object.entries(raw.context)) {
				if (value === null) delete c.context[key];
				else c.context[key] = value;
			}
		this.event(c, { type: "message", message: m });
		this.save(c);
	}
	request(
		owner: Owner,
		method: string,
		path: string,
		body?: JsonValue,
		publicInstructions = "",
	): PoppyReply {
		try {
			return this.atomic(() =>
				this.accept(owner, method, path, body, publicInstructions),
			);
		} catch (error) {
			if (error instanceof ProtocolError)
				return {
					httpStatus: error.status,
					body: { error: error.code, ...error.details },
				};
			throw error;
		}
	}
	private accept(
		owner: Owner,
		method: string,
		path: string,
		body?: JsonValue,
		publicInstructions = "",
	): PoppyReply {
		const parts = path.split("/").filter(Boolean);
		if (method !== "POST" || parts.length > 3)
			throw new ProtocolError("invalid_request", 400);
		const parsed = PoppyPostSchema.safeParse(body);
		if (!parsed.success) throw new ProtocolError("invalid_request", 400);
		const input = parsed.data;
		const ownerId = ownerKey(owner);
		const old = this.sql
			.exec<StoredRequest>(
				"SELECT id,conversation,path,body,status,pending,context,through_sequence,accepted_at FROM poppy_requests WHERE owner=? AND id=?",
				ownerId,
				input.id,
			)
			.toArray()[0];
		const fingerprint = canonical(body!);
		if (old) {
			this.owned(old.conversation, owner);
			if (old.path !== path || old.body !== fingerprint)
				throw new ProtocolError("request_id_conflict", 409);
			return {
				httpStatus: old.status,
				body: { conversation_id: old.conversation },
			};
		}
		let c: Conversation | undefined;
		if (parts.length) c = this.owned(parts[0]!, owner);
		let pending = 0;
		const action = parts.slice(1).join("/");
		if (!parts.length) {
			if (!input.message || input.user_requested_event_id)
				throw new ProtocolError("invalid_request", 400);
			let parent: Conversation | undefined;
			if (input.parent_conversation_id) {
				parent = this.owned(input.parent_conversation_id, owner);
				if (parent.closed) throw new ProtocolError("conversation_closed", 409);
				if (parent.parent) throw new ProtocolError("invalid_request", 400);
				if (parent.direct)
					throw new ProtocolError("direct_conversation_open", 409, {
						conversation_id: parent.direct,
					});
			}
			c = {
				id: id(),
				owner: ownerId,
				version: owner.version,
				parent: parent?.id ?? null,
				direct: null,
				closed: false,
				handoff: "none",
				responder: "agent",
				context: { ...parent?.context },
				publicInstructions,
			};
			this.save(c);
			if (parent) {
				parent.direct = c.id;
				this.save(parent);
				this.event(parent, { type: "direct_opened", conversation_id: c.id });
			}
			this.message(c, input.id, input.message);
			pending = 1;
		} else {
			if (
				!c ||
				!["messages", "handoff", "handoff/cancel", "close"].includes(action) ||
				input.parent_conversation_id ||
				input.user_requested_event_id
			)
				throw new ProtocolError("invalid_request", 400);
			if (action !== "close" && c.closed)
				throw new ProtocolError("conversation_closed", 409);
			if (action !== "close" && c.direct)
				throw new ProtocolError("direct_conversation_open", 409, {
					conversation_id: c.direct,
				});
			if (action === "messages") {
				if (!input.message) throw new ProtocolError("invalid_request", 400);
				this.message(c, input.id, input.message);
				pending = c.responder === "agent" ? 1 : 2;
				if (c.responder === "human") this.openDesk(c);
			} else if (input.message) throw new ProtocolError("invalid_request", 400);
			else if (action === "close") this.close(c);
			else if (
				action === "handoff" &&
				c.handoff === "none" &&
				c.responder !== "human"
			) {
				c.handoff = "pending";
				this.openDesk(c);
				this.state(c);
			} else if (action === "handoff/cancel" && c.handoff === "pending") {
				c.handoff = "none";
				this.sql.exec(
					"UPDATE poppy_desks SET pending=0 WHERE conversation=?",
					c.id,
				);
				this.state(c);
			}
		}
		const status = parts.length ? 202 : 201;
		this.sql.exec(
			"INSERT INTO poppy_requests(owner,id,conversation,path,body,status,pending,context,through_sequence,accepted_at) VALUES (?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sequence),0) FROM poppy_events WHERE conversation=?),?)",
			ownerId,
			input.id,
			c!.id,
			path,
			fingerprint,
			status,
			pending,
			JSON.stringify(c!.context),
			c!.id,
			Date.now(),
		);
		return { httpStatus: status, body: { conversation_id: c!.id } };
	}
	read(
		owner: Owner,
		conversationId: string,
		cursor: string | null,
	): PoppyReply {
		try {
			const c = this.owned(conversationId, owner);
			let after = 0;
			if (cursor !== null) {
				if (!PoppyIdSchema.safeParse(cursor).success)
					throw new ProtocolError("invalid_cursor", 400);
				const row = this.sql
					.exec<{ sequence: number }>(
						"SELECT sequence FROM poppy_events WHERE conversation=? AND id=?",
						c.id,
						cursor,
					)
					.toArray()[0];
				if (!row) throw new ProtocolError("invalid_cursor", 400);
				after = row.sequence;
			}
			const events = this.sql
				.exec<{ value: string }>(
					"SELECT value FROM poppy_events WHERE conversation=? AND sequence>? ORDER BY sequence LIMIT 101",
					c.id,
					after,
				)
				.toArray();
			const page = events
				.slice(0, 100)
				.map((row) => JSON.parse(row.value) as Event);
			const working =
				!c.closed &&
				this.sql
					.exec(
						"SELECT id FROM poppy_requests WHERE conversation=? AND pending>0 LIMIT 1",
						c.id,
					)
					.toArray().length > 0;
			return {
				httpStatus: 200,
				body: {
					conversation_id: c.id,
					events: page,
					cursor: page.at(-1)?.id ?? cursor,
					has_more: events.length > 100,
					working,
					handoff: c.handoff,
					responder: c.responder,
					closed: c.closed,
				},
			};
		} catch (error) {
			if (error instanceof ProtocolError)
				return {
					httpStatus: error.status,
					body: { error: error.code, ...error.details },
				};
			throw error;
		}
	}
	pendingConversations(): string[] {
		return this.sql
			.exec<{ conversation: string }>(
				"SELECT DISTINCT conversation FROM poppy_requests WHERE pending=1",
			)
			.toArray()
			.map((row) => row.conversation);
	}
	nextJob(conversationId?: string): PoppyJob | null {
		const r = this.sql
			.exec<StoredRequest & { owner: string }>(
				"SELECT owner,id,conversation,path,body,status,pending,context,through_sequence,accepted_at FROM poppy_requests WHERE pending=1 AND (? IS NULL OR conversation=?) ORDER BY sequence LIMIT 1",
				conversationId ?? null,
				conversationId ?? null,
			)
			.toArray()[0];
		if (!r) return null;
		const c = this.load(r.conversation);
		const history = this.sql
			.exec<{ value: string }>(
				"SELECT value FROM poppy_events WHERE conversation=? AND (sequence<=? OR json_extract(value,'$.message.role')='company') ORDER BY sequence DESC LIMIT 100",
				c.id,
				r.through_sequence,
			)
			.toArray()
			.reverse()
			.map((row) => JSON.parse(row.value) as Event);
		const parentHistory = c.parent
			? this.sql
					.exec<{ value: string }>(
						"SELECT value FROM poppy_events WHERE conversation=? ORDER BY sequence DESC LIMIT 100",
						c.parent,
					)
					.toArray()
					.reverse()
					.map((row) => JSON.parse(row.value) as Event)
			: [];
		return {
			owner: r.owner,
			id: r.id,
			conversation: c.id,
			acceptedAt: r.accepted_at,
			context: JSON.parse(r.context) as JsonValue,
			history: [...parentHistory, ...history],
			publicInstructions: c.publicInstructions,
		};
	}
	finish(job: PoppyJob, text: string) {
		this.atomic(() => {
			const r = this.sql
				.exec<{ pending: number }>(
					"SELECT pending FROM poppy_requests WHERE owner=? AND id=?",
					job.owner,
					job.id,
				)
				.toArray()[0];
			if (!r?.pending) return;
			const c = this.load(job.conversation);
			if (!c.closed)
				this.event(c, {
					type: "message",
					message: {
						id: id(),
						role: "company",
						author: { type: "agent" },
						as_of_request: job.id,
						text,
					},
				});
			this.sql.exec(
				"UPDATE poppy_requests SET pending=0 WHERE owner=? AND id=?",
				job.owner,
				job.id,
			);
		});
	}
	desks(owner: Owner, conversationId: string): PoppyDesk[] {
		const c = this.owned(conversationId, owner);
		return this.sql
			.exec<{ id: string; conversation: string; pending: number }>(
				"SELECT id,conversation,pending FROM poppy_desks WHERE root=? OR conversation=?",
				c.id,
				c.id,
			)
			.toArray()
			.map((row) => ({
				conversationId: row.conversation,
				interactionId: row.id,
				pending: row.pending === 1,
				transcript: {
					events: this.sql
						.exec<{ value: string }>(
							"SELECT value FROM poppy_events WHERE conversation=? AND json_extract(value,'$.type')='message' ORDER BY sequence DESC LIMIT 20",
							row.conversation,
						)
						.toArray()
						.reverse()
						.map((event) => JSON.parse(event.value) as JsonValue),
				},
			}));
	}
	humanReply(
		owner: Owner,
		conversationId: string,
		interactionId: string,
		text: string | null,
	) {
		this.atomic(() => {
			const c = this.owned(conversationId, owner);
			const desk = this.sql
				.exec<{ pending: number; through_sequence: number }>(
					"SELECT pending,through_sequence FROM poppy_desks WHERE id=? AND conversation=?",
					interactionId,
					c.id,
				)
				.toArray()[0];
			if (c.closed || !desk?.pending) return;
			this.sql.exec(
				"UPDATE poppy_desks SET pending=0 WHERE id=?",
				interactionId,
			);
			this.sql.exec(
				"UPDATE poppy_requests SET pending=0 WHERE conversation=? AND sequence<=?",
				c.id,
				desk.through_sequence,
			);
			c.handoff = "none";
			c.responder = text === null ? "agent" : "human";
			this.state(c);
			if (
				text !== null &&
				this.sql
					.exec(
						"SELECT id FROM poppy_requests WHERE conversation=? AND pending>0 LIMIT 1",
						c.id,
					)
					.toArray().length
			) {
				this.sql.exec(
					"UPDATE poppy_requests SET pending=2 WHERE conversation=? AND pending>0",
					c.id,
				);
				this.openDesk(c, false);
			}
			this.event(c, {
				type: "message",
				message: {
					id: id(),
					role: "company",
					author: { type: text === null ? "agent" : "human" },
					text:
						text ??
						"No person is available to join this conversation right now.",
				},
			});
		});
	}
}
