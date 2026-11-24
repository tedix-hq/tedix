import {
	PoppyIdSchema,
	PoppyPostSchema,
} from "@tedix/api-contract/schemas/personal-agent-conversation";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	closePoppyDesk,
	closePoppyDesks,
	escalatePoppyRequests,
	findPoppyDesk,
	findPoppyEventSequence,
	findPoppyRequest,
	getPoppyConversation,
	hasPendingPoppyRequest,
	insertPoppyEvent,
	insertPoppyRequest,
	listPendingPoppyConversations,
	listPoppyDesks,
	listPoppyEventsAfter,
	listRecentPoppyEvents,
	nextPoppyRequest,
	openPoppyDesk,
	savePoppyConversation,
	settlePoppyRequests,
} from "@tedix/db/queries/durable-sqlite/poppy-conversations";
import { type PoppyStoreDb, openPoppyStore } from "@tedix/db/poppy-store/store";

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
	private readonly db: PoppyStoreDb;
	private readonly atomic: <T>(operation: () => T) => T;
	constructor(storage: DurableObjectStorage) {
		this.db = openPoppyStore(storage);
		this.atomic = (operation) => storage.transactionSync(operation);
	}
	private load(conversationId: string): Conversation {
		const value = getPoppyConversation(this.db, conversationId);
		if (value === undefined)
			throw new ProtocolError("conversation_not_found", 404);
		return JSON.parse(value) as Conversation;
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
		savePoppyConversation(this.db, { id: c.id, value: JSON.stringify(c) });
	}
	private event(c: Conversation, value: Record<string, JsonValue>) {
		const e = { ...value, id: id(), created_at: new Date().toISOString() };
		insertPoppyEvent(this.db, {
			conversation: c.id,
			id: e.id,
			value: JSON.stringify(e),
		});
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
		openPoppyDesk(this.db, {
			id: crypto.randomUUID(),
			conversation: c.id,
			root: c.parent ?? c.id,
			includesNewRequest,
		});
	}
	private close(c: Conversation) {
		if (c.closed) return;
		if (c.direct) this.close(this.load(c.direct));
		c.closed = true;
		c.handoff = "none";
		closePoppyDesks(this.db, c.id);
		c.direct = null;
		settlePoppyRequests(this.db, { conversation: c.id });
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
		const old = findPoppyRequest(this.db, { owner: ownerId, id: input.id });
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
				closePoppyDesks(this.db, c.id);
				this.state(c);
			}
		}
		const status = parts.length ? 202 : 201;
		insertPoppyRequest(this.db, {
			owner: ownerId,
			id: input.id,
			conversation: c!.id,
			path,
			body: fingerprint,
			status,
			pending,
			context: JSON.stringify(c!.context),
			acceptedAt: Date.now(),
		});
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
				const sequence = findPoppyEventSequence(this.db, {
					conversation: c.id,
					id: cursor,
				});
				if (sequence === undefined)
					throw new ProtocolError("invalid_cursor", 400);
				after = sequence;
			}
			const events = listPoppyEventsAfter(this.db, {
				conversation: c.id,
				afterSequence: after,
				limit: 101,
			});
			const page = events
				.slice(0, 100)
				.map((value) => JSON.parse(value) as Event);
			const working = !c.closed && hasPendingPoppyRequest(this.db, c.id);
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
		return listPendingPoppyConversations(this.db);
	}
	nextJob(conversationId?: string): PoppyJob | null {
		const r = nextPoppyRequest(this.db, conversationId);
		if (!r) return null;
		const c = this.load(r.conversation);
		const history = listRecentPoppyEvents(this.db, {
			conversation: c.id,
			throughSequence: r.throughSequence,
			limit: 100,
		}).map((value) => JSON.parse(value) as Event);
		const parentHistory = c.parent
			? listRecentPoppyEvents(this.db, {
					conversation: c.parent,
					limit: 100,
				}).map((value) => JSON.parse(value) as Event)
			: [];
		return {
			owner: r.owner,
			id: r.id,
			conversation: c.id,
			acceptedAt: r.acceptedAt,
			context: JSON.parse(r.context) as JsonValue,
			history: [...parentHistory, ...history],
			publicInstructions: c.publicInstructions,
		};
	}
	finish(job: PoppyJob, text: string) {
		this.atomic(() => {
			const r = findPoppyRequest(this.db, { owner: job.owner, id: job.id });
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
			settlePoppyRequests(this.db, { owner: job.owner, id: job.id });
		});
	}
	desks(owner: Owner, conversationId: string): PoppyDesk[] {
		const c = this.owned(conversationId, owner);
		return listPoppyDesks(this.db, c.id).map((row) => ({
			conversationId: row.conversation,
			interactionId: row.id,
			pending: row.pending === 1,
			transcript: {
				events: listRecentPoppyEvents(this.db, {
					conversation: row.conversation,
					messagesOnly: true,
					limit: 20,
				}).map((event) => JSON.parse(event) as JsonValue),
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
			const desk = findPoppyDesk(this.db, {
				id: interactionId,
				conversation: c.id,
			});
			if (c.closed || !desk?.pending) return;
			closePoppyDesk(this.db, interactionId);
			settlePoppyRequests(this.db, {
				conversation: c.id,
				throughSequence: desk.throughSequence,
			});
			c.handoff = "none";
			c.responder = text === null ? "agent" : "human";
			this.state(c);
			if (text !== null && hasPendingPoppyRequest(this.db, c.id)) {
				escalatePoppyRequests(this.db, c.id);
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
