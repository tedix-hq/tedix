/**
 * One object per workspace. It owns the workspace's rows (TenantStore), its
 * conversations, the event ledger and the change record, and it runs the
 * agent turn itself: the model streams here, its code runs in a no-network
 * sandbox whose `env` loops straight back into this object's wrapped bindings.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Message } from "@earendil-works/pi-ai";
import { createDbClient } from "@tedix/db/client";
import { createDbQueryClient } from "@tedix/db/query-client";
import type { TenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import {
	executeOutputQuery,
	type OutputQuery,
	type OutputQueryResult,
} from "@tedix/db/queries/durable-sqlite/output-rpc";
import { getTediById } from "@tedix/db/queries/tedis";
import * as coreOutputs from "@tedix/db/queries/os-workspaces/outputs";
import { retireWorkspaceOutputIndex } from "@tedix/db/queries/workspace-feed/read";
import { publishOutputProjection } from "@tedix/db/queries/workspace-feed/output-publication";
import {
	TenantStore,
	tenantStoreDefinition,
} from "@tedix/db/tenant-store/store";
import { tenantStoreName } from "@tedix/db/tenant-store/router";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import type {
	Actor,
	ChangeRecord,
	Source,
} from "@tedix/agent-governance/types";
import { CallRefusedError } from "@tedix/agent-governance/wrap-binding";
import { SqlAccountabilityAdapter, SqlComplianceAdapter } from "./adapters";
import { buildWorkspaceBindings } from "./bindings";
import { TenantDataPort } from "./data-port-tenant";
import { BINDING_NAMES, type BindingName } from "./declarations";
import { SqlEventLedger } from "./event-ledger";
import type {
	ActorKind,
	TurnRequest,
	WorkspaceEnv,
	WorkspaceScope,
} from "./env";
import { handleMcpRequest } from "./mcp";
import {
	azureGatewayConfigured,
	createAzureGatewayModel,
	type ModelPort,
} from "./model";
import { buildSystemPrompt } from "./prompt";
import type { WorkspaceStorage } from "./runtime";
import { createLoaderSandbox } from "./sandbox";
import { runTurn, type TurnResult } from "./turn-loop";
import {
	type ClientFrame,
	type ConversationSummary,
	stepLabel,
	type WireControlFrame,
	type WireEvent,
	type WireEventBody,
} from "./wire";

export const COMPATIBILITY_DATE = "2026-05-14";
/** Turns with more history than this run in their own facet. */
export const ISOLATE_AFTER_MESSAGES = 40;
const KEEPALIVE_MS = 60_000;

const CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
	id TEXT PRIMARY KEY,
	title TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_turn_at TEXT,
	archived_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	conversation_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	at TEXT NOT NULL,
	message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS turns (
	turn_id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	started_at TEXT NOT NULL,
	finished_at TEXT,
	status TEXT NOT NULL,
	actor_id TEXT NOT NULL,
	actor_kind TEXT NOT NULL,
	tedi_id TEXT,
	text TEXT,
	error TEXT,
	first_seq INTEGER
);
CREATE TABLE IF NOT EXISTS approvals (
	approval_id TEXT PRIMARY KEY,
	turn_id TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	step_id TEXT NOT NULL,
	binding TEXT NOT NULL,
	method TEXT NOT NULL,
	args TEXT NOT NULL,
	resource TEXT NOT NULL,
	args_hash TEXT NOT NULL,
	actor_id TEXT NOT NULL,
	actor_kind TEXT NOT NULL,
	tedi_id TEXT,
	status TEXT NOT NULL,
	decided_by TEXT,
	decided_at TEXT
);
`;

type TurnStatus = "running" | "finished" | "failed";

interface TurnRow {
	turn_id: string;
	conversation_id: string;
	status: TurnStatus;
	actor_id: string;
	actor_kind: ActorKind;
	tedi_id: string | null;
	text: string | null;
	error: string | null;
	first_seq: number | null;
	started_at: string;
	finished_at: string | null;
}

interface ApprovalRow {
	approval_id: string;
	turn_id: string;
	conversation_id: string;
	step_id: string;
	binding: string;
	method: string;
	args: string;
	resource: string;
	args_hash: string;
	actor_id: string;
	actor_kind: ActorKind;
	tedi_id: string | null;
	status: "pending" | "approved" | "denied" | "applied" | "failed";
}

/** Thin `WorkspaceStorage` over the object's synchronous SQLite and KV. */
function sqlStorage(storage: DurableObjectStorage): WorkspaceStorage {
	return {
		exec<T>(sql: string, ...params: unknown[]) {
			return storage.sql
				.exec(sql, ...(params as SqlStorageValue[]))
				.toArray() as T[];
		},
		run(sql: string, ...params: unknown[]) {
			storage.sql.exec(sql, ...(params as SqlStorageValue[]));
		},
		get<T>(key: string) {
			return storage.kv.get<T>(key);
		},
		put<T>(key: string, value: T) {
			storage.kv.put(key, value);
		},
		delete(key: string) {
			storage.kv.delete(key);
		},
	};
}

export interface GuestProfile {
	systemPrompt: string;
	addenda: string;
}

/** What one turn needs that does not change while it runs. */
export interface TurnPlan {
	scope: WorkspaceScope;
	turnId: string;
	conversationId: string;
	actor: Actor;
	actorKind: ActorKind;
	systemPrompt: string;
	history: Message[];
	userText: string;
}

/** What the loop reports while it runs; the object turns it into wire events. */
export type LoopEvent = { type: string; data?: Record<string, unknown> };

/** Migration: walk one table in rowid order. */
export interface ExportRowsInput {
	table: string;
	after: string | null;
	limit: number;
}

export class WorkspaceDO extends TenantStore<WorkspaceEnv> {
	readonly #store: WorkspaceStorage;
	readonly #events: SqlEventLedger;
	readonly #ledger: SqlAccountabilityAdapter;
	readonly #compliance: SqlComplianceAdapter;
	#outputSerial: Promise<void> = Promise.resolve();
	readonly #running = new Map<string, AbortController>();
	readonly #waiters = new Map<string, Array<() => void>>();

	constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
		super(ctx, env, tenantStoreDefinition);
		this.#store = sqlStorage(ctx.storage);
		this.#store.run(CHAT_SCHEMA);
		this.#events = new SqlEventLedger(this.#store, (event) =>
			this.#push(event),
		);
		this.#ledger = new SqlAccountabilityAdapter(this.#store);
		this.#compliance = new SqlComplianceAdapter(this.#store, {
			writesNeedApproval: true,
		});
		// A turn interrupted by eviction is marked failed; the user sees it at once.
		const now = new Date().toISOString();
		for (const row of this.#store.exec<TurnRow>(
			"SELECT * FROM turns WHERE status = 'running'",
		)) {
			this.#store.run(
				"UPDATE turns SET status = 'failed', error = 'interrupted', finished_at = ? WHERE turn_id = ?",
				now,
				row.turn_id,
			);
			this.#events.append(row.conversation_id, {
				type: "turn.finished",
				turnId: row.turn_id,
				status: "error",
				error: "interrupted",
				durationMs: Date.parse(now) - Date.parse(row.started_at),
			});
		}
	}

	// ------------------------------------------------------------------ RPC

	async outputQuery<K extends OutputQuery["op"]>(
		scope: WorkspaceScope,
		query: OutputQuery<K>,
	): Promise<OutputQueryResult<K>> {
		this.bindScope(scope);
		const operation = query as OutputQuery;
		const outputId =
			operation.op === "create"
				? operation.output.id
				: operation.op === "revise"
					? operation.params.outputId
					: operation.op === "update" || operation.op === "delete"
						? operation.outputId
						: null;
		const write = () =>
			executeOutputQuery(this.db as TenantStoreDb, scope, query);
		return outputId ? this.#commitOutput(scope, outputId, write) : write();
	}

	/** Start a turn. Returns at once; follow it through the event stream. */
	async sendTurn(
		scope: WorkspaceScope,
		input: TurnRequest,
		displayText?: string,
	): Promise<{ turnId: string; conversationId: string; seq: number }> {
		this.bindScope(scope);
		const turnId = input.turnId ?? crypto.randomUUID();
		const existing = this.#turn(turnId);
		if (existing) {
			return {
				turnId,
				conversationId: existing.conversation_id,
				seq: existing.first_seq ?? this.#events.latestSeq(),
			};
		}
		const text = input.text.trim();
		if (!text) throw new Error("A turn needs text");
		const now = new Date().toISOString();
		const conversationId = this.#ensureConversation(
			input.conversationId ?? null,
			text,
			now,
		);
		this.#store.run(
			"INSERT INTO turns (turn_id, conversation_id, started_at, status, actor_id, actor_kind, tedi_id) VALUES (?, ?, ?, 'running', ?, ?, ?)",
			turnId,
			conversationId,
			now,
			input.actorId,
			input.actorKind,
			input.tediId ?? null,
		);
		const started = this.#events.append(conversationId, {
			type: "turn.started",
			turnId,
			text,
			...(displayText ? { displayText } : {}),
			authorId: input.tediId ?? input.actorId,
			authorKind:
				input.tediId || input.actorKind === "tedi" ? "tedi" : "person",
		});
		this.#store.run(
			"UPDATE turns SET first_seq = ? WHERE turn_id = ?",
			started.seq,
			turnId,
		);
		const controller = new AbortController();
		this.#running.set(turnId, controller);
		await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
		this.ctx.waitUntil(
			this.#execute(
				scope,
				turnId,
				conversationId,
				{ ...input, text },
				controller,
			),
		);
		return { turnId, conversationId, seq: started.seq };
	}

	async cancelTurn(scope: WorkspaceScope, turnId: string): Promise<boolean> {
		this.bindScope(scope);
		const controller = this.#running.get(turnId);
		if (!controller) return false;
		controller.abort(new Error("cancelled by user"));
		return true;
	}

	/** Live replay: events after a cursor, one conversation or the whole object. */
	readEvents(
		scope: WorkspaceScope,
		input: {
			conversationId?: string | null;
			after?: number;
			limit?: number;
		} = {},
	): WireEvent[] {
		this.bindScope(scope);
		return this.#events.replay(
			input.after ?? 0,
			input.conversationId ?? null,
			input.limit,
		);
	}

	/** History paging for one conversation: the newest events before a cursor. */
	readLedger(
		scope: WorkspaceScope,
		conversationId: string,
		input: { before?: number | null; limit?: number } = {},
	): WireEvent[] {
		this.bindScope(scope);
		return this.#events.history(
			conversationId,
			input.before ?? null,
			input.limit,
		);
	}

	listConversations(scope: WorkspaceScope): ConversationSummary[] {
		this.bindScope(scope);
		return this.#store
			.exec<{
				id: string;
				title: string | null;
				updated_at: string;
				last_turn_at: string | null;
			}>(
				"SELECT id, title, updated_at, last_turn_at FROM conversations WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 200",
			)
			.map((row) => ({
				id: row.id,
				title: row.title,
				updatedAt: row.updated_at,
				lastTurnAt: row.last_turn_at,
			}));
	}

	readTurn(scope: WorkspaceScope, turnId: string) {
		this.bindScope(scope);
		const row = this.#turn(turnId);
		if (!row) return null;
		return {
			turnId,
			conversationId: row.conversation_id,
			status: row.status,
			text: row.text,
			error: row.error,
			startedAt: row.started_at,
			finishedAt: row.finished_at,
			firstSeq: row.first_seq,
		};
	}

	/** Resolve when the turn is no longer running, or after `timeoutMs`. */
	async awaitTurn(scope: WorkspaceScope, turnId: string, timeoutMs: number) {
		this.bindScope(scope);
		const row = this.#turn(turnId);
		if (!row) throw new Error("Unknown turn");
		if (row.status !== "running" || timeoutMs <= 0)
			return this.#turnOutcome(row);
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			const waiters = this.#waiters.get(turnId) ?? [];
			waiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
			this.#waiters.set(turnId, waiters);
		});
		return this.#turnOutcome(this.#turn(turnId) ?? row);
	}

	/** The accountability ledger: one record per binding call. */
	readChangeRecords(
		scope: WorkspaceScope,
		query: { afterSequence?: number; limit?: number; resource?: string } = {},
	): Promise<ChangeRecord[]> {
		this.bindScope(scope);
		return this.#ledger.list(query);
	}

	readMessages(
		scope: WorkspaceScope,
		conversationId: string,
		limit = 200,
	): Message[] {
		this.bindScope(scope);
		return this.#history(conversationId, limit);
	}

	/**
	 * A person decides a held write. On approve the same call runs again with
	 * the receipt, lands as a second change record, and the turn continues so
	 * the model can finish its answer; on deny the hold is recorded and the
	 * conversation moves on.
	 */
	async decideApproval(
		scope: WorkspaceScope,
		input: {
			approvalId: string;
			decision: "approve" | "deny";
			by: string;
			note?: string;
		},
	): Promise<{ applied: boolean; turnId?: string }> {
		this.bindScope(scope);
		const [approval] = this.#store.exec<ApprovalRow>(
			"SELECT * FROM approvals WHERE approval_id = ?",
			input.approvalId,
		);
		if (!approval) throw new Error("Unknown approval");
		if (approval.status !== "pending")
			return (
				this.#store.get<{ applied: boolean; turnId?: string }>(
					`approval-result:${input.approvalId}`,
				) ?? { applied: approval.status === "applied" }
			);
		const now = new Date().toISOString();
		const state = input.decision === "approve" ? "approved" : "denied";
		this.#compliance.recordApproval(input.approvalId, state, input.by, {
			resource: approval.resource,
			operation: approval.method,
			argsHash: approval.args_hash,
		});
		this.#store.run(
			"UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE approval_id = ?",
			state,
			input.by,
			now,
			input.approvalId,
		);
		this.#events.append(approval.conversation_id, {
			type: "approval.decided",
			approvalId: input.approvalId,
			decision: input.decision,
			by: input.by,
			at: now,
		});
		let summary: string;
		let applied = false;
		if (input.decision === "approve") {
			const outcome = await this.#invokeBinding(
				scope,
				{
					turnId: approval.turn_id,
					conversationId: approval.conversation_id,
					actor: { id: approval.actor_id, kind: approval.actor_kind },
				},
				approval.binding,
				approval.method,
				JSON.parse(approval.args) as unknown[],
			).catch((error: unknown) => ({
				ok: false as const,
				error: error instanceof Error ? error.message : String(error),
			}));
			applied = outcome.ok;
			const status = applied ? "applied" : "failed";
			this.#store.run(
				"UPDATE approvals SET status = ? WHERE approval_id = ?",
				status,
				input.approvalId,
			);
			this.#events.append(approval.conversation_id, {
				type: "approval.executed",
				approvalId: input.approvalId,
				status,
				...(!outcome.ok ? { error: outcome.error } : {}),
			});
			summary = outcome.ok
				? `Approved by ${input.by}; ${approval.binding}.${approval.method} applied: ${JSON.stringify(outcome.value).slice(0, 2_000)}`
				: `Approved by ${input.by} but ${approval.binding}.${approval.method} failed: ${outcome.error}`;
		} else {
			summary = `Denied by ${input.by}${input.note ? `: ${input.note}` : ""}. Do not retry this action.`;
		}
		this.#store.put(`approval-result:${input.approvalId}`, { applied });
		const { turnId } = await this.sendTurn(
			scope,
			{
				conversationId: approval.conversation_id,
				actorId: input.by,
				actorKind: "user",
				text: summary,
				...(approval.tedi_id ? { tediId: approval.tedi_id } : {}),
			},
			input.decision === "approve"
				? "Approved the requested action."
				: "Denied the requested action.",
		);
		const result = { applied, turnId };
		this.#store.put(`approval-result:${input.approvalId}`, result);
		return result;
	}

	/**
	 * Called by the sandbox loopback: run one method of one wrapped binding
	 * for a turn that is running. A held write is stored as a pending approval
	 * and comes back as "Approval required: …" so the model stops.
	 */
	async callBinding(
		scope: WorkspaceScope,
		input: { turnId: string; binding: string; method: string; args: unknown[] },
	): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
		this.bindScope(scope);
		const turn = this.#turn(input.turnId);
		if (!turn || turn.status !== "running")
			return { ok: false, error: "This turn is no longer running" };
		return this.#invokeBinding(
			scope,
			{
				turnId: input.turnId,
				conversationId: turn.conversation_id,
				actor: {
					id: turn.tedi_id ?? turn.actor_id,
					kind: turn.tedi_id ? "tedi" : turn.actor_kind,
				},
				tediId: turn.tedi_id,
			},
			input.binding,
			input.method,
			input.args,
		);
	}

	/** Facet callback: an event produced while the turn ran elsewhere. */
	appendTurnEvent(
		scope: WorkspaceScope,
		turnId: string,
		event: LoopEvent,
	): void {
		this.bindScope(scope);
		const turn = this.#turn(turnId);
		if (!turn) return;
		this.#emitLoopEvent(turn.conversation_id, turnId, event);
	}

	/** Migration: rows of one tenant table after an opaque cursor (rowid). */
	exportRows(
		scope: WorkspaceScope,
		input: ExportRowsInput,
	): { rows: Record<string, unknown>[]; next: string | null } {
		this.bindScope(scope);
		if (!Object.hasOwn(tenantStoreDefinition.importTables, input.table))
			throw new Error(`Unknown tenant table ${input.table}`);
		const limit = Math.min(Math.max(input.limit, 1), 1_000);
		const after = input.after ? Number(input.after) : 0;
		const rows = this.#store.exec<Record<string, unknown> & { rowid: number }>(
			`SELECT rowid AS rowid, * FROM "${input.table}" WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
			Number.isFinite(after) ? after : 0,
			limit,
		);
		const last = rows.at(-1)?.rowid;
		return {
			rows: rows.map(({ rowid: _rowid, ...row }) =>
				Object.fromEntries(
					Object.entries(row).map(([key, value]) => [
						key,
						value instanceof ArrayBuffer
							? { $b64: btoa(String.fromCharCode(...new Uint8Array(value))) }
							: value,
					]),
				),
			),
			next: rows.length === limit && last !== undefined ? String(last) : null,
		};
	}

	// ----------------------------------------------------------------- HTTP

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const scope = this.#scopeFromHeaders(request);
		if (url.pathname.endsWith("/subscribe")) {
			if (request.headers.get("Upgrade") !== "websocket")
				return new Response("Expected WebSocket", { status: 426 });
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];
			this.ctx.acceptWebSocket(server);
			// The caller (OS worker) authenticated the person and names them here.
			server.serializeAttachment({
				scope,
				conversationId: null,
				actorId:
					request.headers.get("X-Workspace-Actor-Id") ??
					request.headers.get("X-Tedix-Person") ??
					"person",
			});
			const cursor = Number(url.searchParams.get("after") ?? "");
			if (Number.isFinite(cursor) && url.searchParams.has("after")) {
				this.#subscribe(
					server,
					scope,
					url.searchParams.get("conversation"),
					cursor,
				);
			}
			return new Response(null, { status: 101, webSocket: client });
		}
		if (url.pathname.endsWith("/mcp") && request.method === "POST") {
			const actorId =
				request.headers.get("X-Workspace-Actor-Id") ?? "anonymous";
			const actorKind = (request.headers.get("X-Workspace-Actor-Kind") ??
				"external_agent") as ActorKind;
			const body = await request.json().catch(() => null);
			const reply = await handleMcpRequest(
				{
					sendTurn: async (input) => this.sendTurn(scope, input),
					awaitTurn: (turnId, timeoutMs) =>
						this.awaitTurn(scope, turnId, timeoutMs),
					readChangeRecords: (query) => this.readChangeRecords(scope, query),
					readEvents: async (input) => this.readEvents(scope, input),
				},
				{ actorId, actorKind },
				body,
			);
			return Response.json(reply);
		}
		return new Response("Not found", { status: 404 });
	}

	override async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	) {
		if (typeof message !== "string") return;
		let frame: ClientFrame | null = null;
		try {
			frame = JSON.parse(message) as ClientFrame;
		} catch {
			this.#control(ws, {
				type: "error",
				code: "bad_frame",
				message: "Frames are JSON",
			});
			return;
		}
		const attachment = ws.deserializeAttachment() as {
			scope: WorkspaceScope;
			conversationId: string | null;
		};
		const { scope } = attachment;
		try {
			switch (frame?.type) {
				case "subscribe":
					this.#subscribe(ws, scope, frame.conversationId, frame.cursor ?? 0);
					return;
				case "send_turn": {
					const started = await this.sendTurn(scope, {
						turnId: frame.clientTurnId,
						conversationId: frame.conversationId,
						actorId: ws.deserializeAttachment()?.actorId ?? "person",
						actorKind: "user",
						text: frame.text,
						...(frame.tediId ? { tediId: frame.tediId } : {}),
					});
					this.#control(ws, {
						type: "turn.accepted",
						clientTurnId: frame.clientTurnId,
						turnId: started.turnId,
						conversationId: started.conversationId,
					});
					return;
				}
				case "decide_approval":
					await this.decideApproval(scope, {
						approvalId: frame.approvalId,
						decision: frame.decision,
						by: ws.deserializeAttachment()?.actorId ?? "person",
						...(frame.note ? { note: frame.note } : {}),
					});
					return;
				case "cancel_turn":
					await this.cancelTurn(scope, frame.turnId);
					return;
				case "read_ledger": {
					const limit = frame.limit ?? 500;
					const page = this.readLedger(scope, frame.conversationId, {
						before: frame.before,
						limit: limit + 1,
					});
					const hasMore = page.length > limit;
					this.#control(ws, {
						type: "ledger.page",
						conversationId: frame.conversationId,
						events: hasMore ? page.slice(1) : page,
						hasMore,
					});
					return;
				}
				case "ping":
					this.#control(ws, { type: "pong" });
					return;
				default:
					this.#control(ws, {
						type: "error",
						code: "unknown_frame",
						message: "Unknown frame type",
					});
			}
		} catch (error) {
			this.#control(ws, {
				type: "error",
				code: "failed",
				message: error instanceof Error ? error.message : String(error),
				...(frame && "clientTurnId" in frame
					? { clientTurnId: frame.clientTurnId }
					: {}),
			});
		}
	}

	override async webSocketClose(ws: WebSocket) {
		ws.close();
	}

	override async alarm() {
		await this.#serializeOutput(() => this.#flushOutputProjections());
		if (
			this.#running.size > 0 ||
			Object.keys(this.#pendingOutputProjections()).length > 0
		) {
			await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
			return;
		}
		this.#events.trim();
	}

	// ------------------------------------------------------------- internals

	#pendingOutputProjections() {
		return (
			this.#store.get<
				Record<string, { scope: WorkspaceScope; generation: string }>
			>("pending-output-projections") ?? {}
		);
	}

	#serializeOutput<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.#outputSerial.then(operation);
		this.#outputSerial = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	async #commitOutput<T>(
		scope: WorkspaceScope,
		outputId: string,
		write: () => Promise<T>,
	): Promise<T> {
		return this.#serializeOutput(async () => {
			// Persist retry before mutation; deletion and publication share this queue.
			this.#store.put("pending-output-projections", {
				...this.#pendingOutputProjections(),
				[outputId]: { scope, generation: crypto.randomUUID() },
			});
			await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
			try {
				return await write();
			} finally {
				await this.#flushOutputProjections();
			}
		});
	}

	refreshOutputProjection(
		scope: WorkspaceScope,
		outputId: string,
	): Promise<void> {
		this.bindScope(scope);
		return this.#commitOutput(scope, outputId, async () => {});
	}

	async #flushOutputProjections() {
		for (const [outputId, pending] of Object.entries(
			this.#pendingOutputProjections(),
		)) {
			try {
				await this.projectOutput(pending.scope, outputId);
				const current = this.#pendingOutputProjections();
				if (current[outputId]?.generation === pending.generation) {
					delete current[outputId];
					this.#store.put("pending-output-projections", current);
				}
			} catch (error) {
				console.error("Workspace output projection queued for retry", error);
			}
		}
	}

	protected async projectOutput(scope: WorkspaceScope, outputId: string) {
		const core = createDbQueryClient(this.env.DB);
		const legacy = await coreOutputs.getOsOutput(core, { ...scope, outputId });
		const row =
			legacy ??
			(await executeOutputQuery(this.db as TenantStoreDb, scope, {
				op: "get",
				outputId,
			}));
		if (!row) {
			await retireWorkspaceOutputIndex(core, {
				organizationId: scope.organizationId,
				outputId,
			});
			return;
		}
		if (row.workspaceId !== scope.workspaceId || !row.currentRevisionId) return;
		const revision = legacy
			? await coreOutputs.getOsOutputRevision(core, {
					...scope,
					revisionId: row.currentRevisionId,
				})
			: await executeOutputQuery(this.db as TenantStoreDb, scope, {
					op: "revision",
					revisionId: row.currentRevisionId,
				});
		if (revision) await publishOutputProjection(core, row, revision);
	}

	#subscribe(
		ws: WebSocket,
		scope: WorkspaceScope,
		conversationId: string | null,
		cursor: number,
	) {
		const current = ws.deserializeAttachment() as Record<string, unknown>;
		ws.serializeAttachment({ ...current, scope, conversationId });
		const latest = this.#events.latestSeq();
		this.#control(ws, {
			type: "hello",
			cursor: latest,
			serverTime: new Date().toISOString(),
			conversations: this.listConversations(scope),
		});
		for (const event of this.#events.replay(cursor, conversationId)) {
			ws.send(JSON.stringify(event));
		}
		this.#control(ws, { type: "caught_up", cursor: latest, conversationId });
	}

	#control(ws: WebSocket, frame: WireControlFrame) {
		try {
			ws.send(JSON.stringify(frame));
		} catch {
			/* a closed socket is dropped by the runtime */
		}
	}

	#push(event: WireEvent) {
		const frame = JSON.stringify(event);
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment() as {
				conversationId?: string | null;
			} | null;
			if (
				attachment?.conversationId &&
				attachment.conversationId !== event.conversationId
			)
				continue;
			try {
				ws.send(frame);
			} catch {
				/* a closed socket is dropped by the runtime */
			}
		}
	}

	#scopeFromHeaders(request: Request): WorkspaceScope {
		const organizationId = request.headers.get("X-Workspace-Org");
		const workspaceId = request.headers.get("X-Workspace-Id");
		if (!organizationId || !workspaceId)
			throw new Error(
				"X-Workspace-Org and X-Workspace-Id headers are required",
			);
		const scope = { organizationId, workspaceId };
		this.bindScope(scope);
		return scope;
	}

	#ensureConversation(
		conversationId: string | null,
		firstText: string,
		now: string,
	): string {
		if (conversationId) {
			const [row] = this.#store.exec<{ id: string }>(
				"SELECT id FROM conversations WHERE id = ?",
				conversationId,
			);
			if (!row) throw new Error("Unknown conversation");
			this.#store.run(
				"UPDATE conversations SET updated_at = ?, last_turn_at = ? WHERE id = ?",
				now,
				now,
				conversationId,
			);
			return conversationId;
		}
		const id = crypto.randomUUID();
		const title = firstText.replace(/\s+/g, " ").slice(0, 80);
		this.#store.run(
			"INSERT INTO conversations (id, title, created_at, updated_at, last_turn_at) VALUES (?, ?, ?, ?, ?)",
			id,
			title,
			now,
			now,
			now,
		);
		this.#events.append(id, {
			type: "conversation.updated",
			conversationId: id,
			title,
		});
		return id;
	}

	#turn(turnId: string): TurnRow | undefined {
		return this.#store.exec<TurnRow>(
			"SELECT * FROM turns WHERE turn_id = ?",
			turnId,
		)[0];
	}

	#turnOutcome(row: TurnRow) {
		return {
			status: row.status,
			conversationId: row.conversation_id,
			...(row.text !== null ? { text: row.text } : {}),
			...(row.error !== null ? { error: row.error } : {}),
		};
	}

	#history(conversationId: string, limit: number): Message[] {
		return this.#store
			.exec<{ message: string }>(
				"SELECT message FROM (SELECT seq, message FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC",
				conversationId,
				limit,
			)
			.map((row) => JSON.parse(row.message) as Message);
	}

	#dataPort(scope: WorkspaceScope, actorKind: ActorKind) {
		return new TenantDataPort({
			...scope,
			tenant: this.db as TenantStoreDb,
			core: createDbQueryClient(this.env.DB),
			bucket: this.env.R2_BUCKET,
			actorKind,
			commitOutput: (outputId, write) =>
				this.#commitOutput(scope, outputId, write),
		});
	}

	#bindings(
		scope: WorkspaceScope,
		turn: {
			turnId: string;
			conversationId: string;
			actor: { id: string; kind: ActorKind };
		},
	) {
		const source: Source = {
			surface: "workspace_object",
			traceId: turn.turnId,
		};
		const actor: Actor = {
			id: turn.actor.id,
			kind: turn.actor.kind === "external_agent" ? "agent" : turn.actor.kind,
			organizationId: scope.organizationId,
		};
		return buildWorkspaceBindings({
			data: this.#dataPort(scope, turn.actor.kind),
			compliance: this.#compliance,
			accountability: this.#ledger,
			actor,
			source,
		});
	}

	async #invokeBinding(
		scope: WorkspaceScope,
		turn: {
			turnId: string;
			conversationId: string;
			actor: { id: string; kind: ActorKind };
			tediId?: string | null;
		},
		binding: string,
		method: string,
		args: unknown[],
	): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
		if (!(BINDING_NAMES as readonly string[]).includes(binding))
			return { ok: false, error: `Unknown binding ${binding}` };
		const target = this.#bindings(scope, turn)[
			binding as BindingName
		] as Record<string, unknown>;
		const fn = target[method];
		if (typeof fn !== "function")
			return { ok: false, error: `${binding}.${method} is not a method` };
		const stepId = crypto.randomUUID();
		const { label, kind } = stepLabel(binding, method);
		const started = Date.now();
		this.#events.append(turn.conversationId, {
			type: "step.started",
			turnId: turn.turnId,
			stepId,
			label,
			kind,
			tool: `${binding}.${method}`,
			...(kind === "write" ? { input: args[0] } : {}),
		});
		try {
			const value = await (fn as (...a: unknown[]) => Promise<unknown>)(
				...args,
			);
			this.#events.append(turn.conversationId, {
				type: "step.finished",
				turnId: turn.turnId,
				stepId,
				status: "ok",
				durationMs: Date.now() - started,
			});
			return {
				ok: true,
				value: value === undefined ? null : JSON.parse(JSON.stringify(value)),
			};
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (
				error instanceof CallRefusedError &&
				error.decision.verdict === "needs_approval"
			) {
				const approvalId = error.record.id;
				this.#store.run(
					"INSERT OR IGNORE INTO approvals (approval_id, turn_id, conversation_id, step_id, binding, method, args, resource, args_hash, actor_id, actor_kind, tedi_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
					approvalId,
					turn.turnId,
					turn.conversationId,
					stepId,
					binding,
					method,
					JSON.stringify(args),
					error.record.resource,
					error.record.argsHash,
					turn.actor.id,
					turn.actor.kind,
					turn.tediId ?? null,
				);
				const request = args[0];
				const outputId =
					request && typeof request === "object" && "outputId" in request
						? request.outputId
						: null;
				const target =
					typeof outputId === "string"
						? await this.#dataPort(scope, turn.actor.kind)
								.getOutput(outputId)
								.catch(() => null)
						: null;
				this.#events.append(turn.conversationId, {
					type: "approval.requested",
					turnId: turn.turnId,
					stepId,
					approvalId,
					title: label,
					reason: error.decision.reason,
					policy: error.decision.gate,
					input: args[0],
					...(target ? { target: { id: target.id, title: target.title } } : {}),
				});
			}
			this.#events.append(turn.conversationId, {
				type: "step.finished",
				turnId: turn.turnId,
				stepId,
				status: "error",
				durationMs: Date.now() - started,
				error: message,
			});
			return { ok: false, error: message };
		}
	}

	#emitLoopEvent(conversationId: string, turnId: string, event: LoopEvent) {
		const data = event.data ?? {};
		let body: WireEventBody | null = null;
		switch (event.type) {
			case "text_delta":
				body = {
					type: "assistant.delta",
					turnId,
					messageId: turnId,
					text: String(data.text ?? ""),
				};
				break;
			case "code_started":
				body = {
					type: "step.started",
					turnId,
					stepId: String(data.toolCallId),
					label: "Running code against the workspace",
					kind: "code",
					tool: "run_code",
				};
				break;
			case "code_finished":
			case "approval_required":
				body = {
					type: "step.finished",
					turnId,
					stepId: String(data.toolCallId),
					status: data.ok ? "ok" : "error",
					durationMs: Number(data.durationMs ?? 0),
					...(data.error ? { error: String(data.error) } : {}),
				};
				break;
			case "compacting":
				body = {
					type: "step.started",
					turnId,
					stepId: `${turnId}:compaction`,
					label: "Summarising earlier conversation",
					kind: "think",
				};
				break;
			case "compacted":
				body = {
					type: "step.finished",
					turnId,
					stepId: `${turnId}:compaction`,
					status: "ok",
					durationMs: 0,
				};
				break;
			default:
				body = null;
		}
		if (body) this.#events.append(conversationId, body);
	}

	/** Sandbox `env`: one loopback stub per binding, valid for this turn only. */
	sandboxEnv(scope: WorkspaceScope, turnId: string): Record<string, unknown> {
		const env: Record<string, unknown> = {};
		for (const binding of BINDING_NAMES) {
			env[binding] = this.ctx.exports.WorkspaceBindingLoopback({
				props: { objectName: tenantStoreName(scope), scope, turnId, binding },
			});
		}
		return env;
	}

	async #guestProfile(
		scope: WorkspaceScope,
		tediId: string,
		userText: string,
	): Promise<GuestProfile> {
		const tedi = await getTediById(createDbClient(this.env.DB), tediId);
		if (
			!tedi ||
			tedi.organizationId !== scope.organizationId ||
			!tedi.isolateAgentId
		)
			throw new Error("Guest tedi is not in this organization");
		const stub = durableObjectStubByName(
			this.env.TEDI_AGENT,
			this.env,
			tedi.isolateAgentId,
		) as unknown as {
			guestProfile(input: {
				tediId: string;
				organizationId: string;
				sessionKey: string;
				userText: string;
			}): Promise<GuestProfile>;
		};
		return stub.guestProfile({
			tediId,
			organizationId: scope.organizationId,
			sessionKey: `workspace:${scope.workspaceId}`,
			userText,
		});
	}

	async #plan(
		scope: WorkspaceScope,
		turnId: string,
		conversationId: string,
		input: TurnRequest,
	): Promise<TurnPlan> {
		const data = this.#dataPort(scope, input.actorKind);
		const [workspace, guest] = await Promise.all([
			data.workspace(),
			input.tediId ? this.#guestProfile(scope, input.tediId, input.text) : null,
		]);
		const history = this.#history(conversationId, 200);
		const systemPrompt = buildSystemPrompt({
			workspaceName: workspace.name,
			workspaceDescription: workspace.description,
			tediPrompt: guest
				? `${guest.systemPrompt}\n\n${guest.addenda}`.trim()
				: null,
			nowIso: new Date().toISOString(),
			priorSummary:
				this.#store.get<string>(`compaction:${conversationId}`) ?? null,
		});
		const actorKind: ActorKind = input.tediId ? "tedi" : input.actorKind;
		return {
			scope,
			turnId,
			conversationId,
			actor: {
				id: input.tediId ?? input.actorId,
				kind: actorKind === "external_agent" ? "agent" : actorKind,
				organizationId: scope.organizationId,
			},
			actorKind,
			systemPrompt,
			history,
			userText:
				input.actorKind === "user"
					? input.text
					: wrapUntrustedInput(input.text, input.actorKind),
		};
	}

	/** The model a turn streams from; a test subclass returns a scripted one. */
	protected modelFor(
		scope: WorkspaceScope,
		turnId: string,
		actorId: string,
	): ModelPort {
		if (!azureGatewayConfigured(this.env))
			throw new Error(
				"No model configured for this workspace (set the Azure OpenAI and AI Gateway variables)",
			);
		return createAzureGatewayModel(this.env, {
			workspaceId: scope.workspaceId,
			turnId,
			actorId,
		});
	}

	async #execute(
		scope: WorkspaceScope,
		turnId: string,
		conversationId: string,
		input: TurnRequest,
		controller: AbortController,
	) {
		const startedAt = Date.now();
		try {
			const plan = await this.#plan(scope, turnId, conversationId, input);
			const isolate =
				input.isolate ?? plan.history.length > ISOLATE_AFTER_MESSAGES;
			const result = isolate
				? await this.#runIsolated(plan)
				: await executeTurn(plan, {
						env: this.env,
						model: this.modelFor(scope, turnId, plan.actor.id),
						sandboxEnv: this.sandboxEnv(scope, turnId),
						emit: (event) => this.#emitLoopEvent(conversationId, turnId, event),
						signal: controller.signal,
					});
			this.#persist(conversationId, turnId, result);
			this.#events.append(conversationId, {
				type: "assistant.done",
				turnId,
				messageId: turnId,
				text: result.text,
				usage: {
					inputTokens: result.usage?.input ?? 0,
					outputTokens: result.usage?.output ?? 0,
					...(result.usage?.cacheRead
						? { cachedInputTokens: result.usage.cacheRead }
						: {}),
				},
			});
			this.#events.append(conversationId, {
				type: "turn.finished",
				turnId,
				status: result.stopReason === "aborted" ? "cancelled" : "done",
				durationMs: Date.now() - startedAt,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#store.run(
				"UPDATE turns SET status = 'failed', error = ?, finished_at = ? WHERE turn_id = ?",
				message,
				new Date().toISOString(),
				turnId,
			);
			this.#events.append(conversationId, {
				type: "turn.finished",
				turnId,
				status: controller.signal.aborted ? "cancelled" : "error",
				error: message,
				durationMs: Date.now() - startedAt,
			});
		} finally {
			this.#running.delete(turnId);
			for (const wake of this.#waiters.get(turnId) ?? []) wake();
			this.#waiters.delete(turnId);
		}
	}

	async #runIsolated(plan: TurnPlan): Promise<TurnResult> {
		const facet = this.ctx.facets.get(`turn:${plan.turnId}`, () => ({
			class: this.ctx.exports.TurnFacet,
		})) as unknown as {
			run(plan: TurnPlan, objectName: string): Promise<TurnResult>;
		};
		try {
			return await facet.run(plan, tenantStoreName(plan.scope));
		} finally {
			this.ctx.facets.delete(`turn:${plan.turnId}`);
		}
	}

	#persist(conversationId: string, turnId: string, result: TurnResult) {
		const now = new Date().toISOString();
		if (result.compaction) {
			this.#store.put(
				`compaction:${conversationId}`,
				result.compaction.summary,
			);
			this.#store.run(
				"DELETE FROM messages WHERE seq IN (SELECT seq FROM messages WHERE conversation_id = ? ORDER BY seq ASC LIMIT ?)",
				conversationId,
				result.compaction.droppedMessages,
			);
		}
		for (const message of result.appended) {
			this.#store.run(
				"INSERT INTO messages (conversation_id, turn_id, at, message) VALUES (?, ?, ?, ?)",
				conversationId,
				turnId,
				now,
				JSON.stringify(message),
			);
		}
		this.#store.run(
			"UPDATE turns SET status = 'finished', text = ?, finished_at = ? WHERE turn_id = ?",
			result.text,
			now,
			turnId,
		);
		this.#store.run(
			"UPDATE conversations SET updated_at = ? WHERE id = ?",
			now,
			conversationId,
		);
	}
}

/** The RPC surface other workers call; typed by hand so callers avoid deep stub inference. */
export interface WorkspaceRpc {
	refreshOutputProjection(
		scope: WorkspaceScope,
		outputId: string,
	): Promise<void>;
	outputQuery<K extends OutputQuery["op"]>(
		scope: WorkspaceScope,
		query: OutputQuery<K>,
	): Promise<OutputQueryResult<K>>;
	sendTurn(
		scope: WorkspaceScope,
		input: TurnRequest,
	): Promise<{ turnId: string; conversationId: string; seq: number }>;
	cancelTurn(scope: WorkspaceScope, turnId: string): Promise<boolean>;
	readEvents(
		scope: WorkspaceScope,
		input?: { conversationId?: string | null; after?: number; limit?: number },
	): Promise<WireEvent[]>;
	readLedger(
		scope: WorkspaceScope,
		conversationId: string,
		input?: { before?: number | null; limit?: number },
	): Promise<WireEvent[]>;
	listConversations(scope: WorkspaceScope): Promise<ConversationSummary[]>;
	readTurn(
		scope: WorkspaceScope,
		turnId: string,
	): Promise<ReturnType<WorkspaceDO["readTurn"]>>;
	awaitTurn(
		scope: WorkspaceScope,
		turnId: string,
		timeoutMs: number,
	): Promise<{
		status: TurnStatus;
		conversationId: string;
		text?: string;
		error?: string;
	}>;
	readChangeRecords(
		scope: WorkspaceScope,
		query?: { afterSequence?: number; limit?: number; resource?: string },
	): Promise<ChangeRecord[]>;
	readMessages(
		scope: WorkspaceScope,
		conversationId: string,
		limit?: number,
	): Promise<Message[]>;
	decideApproval(
		scope: WorkspaceScope,
		input: {
			approvalId: string;
			decision: "approve" | "deny";
			by: string;
			note?: string;
		},
	): Promise<{ applied: boolean; turnId?: string }>;
	describe(scope: WorkspaceScope): Promise<{
		organizationId: string;
		workspaceId: string;
		createdAt: string;
		migrations: string[];
	}>;
	importRows(
		scope: WorkspaceScope,
		batch: { batchId: string; table: string; rows: Record<string, unknown>[] },
	): Promise<{
		batchId: string;
		table: string;
		rowCount: number;
		status: "imported" | "duplicate";
	}>;
	exportRows(
		scope: WorkspaceScope,
		input: ExportRowsInput,
	): Promise<{ rows: Record<string, unknown>[]; next: string | null }>;
	fetch(request: Request): Promise<Response>;
}

/** Everything a turn needs from the host, whichever object runs it. */
export interface ExecuteTurnHost {
	env: WorkspaceEnv;
	sandboxEnv: Record<string, unknown>;
	emit: (event: LoopEvent) => void;
	signal?: AbortSignal;
	model: ModelPort;
}

export async function executeTurn(
	plan: TurnPlan,
	host: ExecuteTurnHost,
): Promise<TurnResult> {
	const sandbox = createLoaderSandbox(host.env.LOADER, COMPATIBILITY_DATE);
	return runTurn(
		{
			model: host.model,
			runCode: (code) => sandbox.run({ code, env: host.sandboxEnv }),
			emit: host.emit,
			signal: host.signal,
			summarize: async (messages) => {
				const stream = host.model.stream({
					systemPrompt:
						"Summarise this conversation for an agent that continues it: goal, constraints, progress, decisions, open items. Be concrete. Do not continue the conversation.",
					messages: [
						...messages,
						{
							role: "user",
							content: "Write the summary now.",
							timestamp: Date.now(),
						},
					],
				});
				const summary = await stream.result();
				return summary.content
					.filter(
						(block): block is { type: "text"; text: string } =>
							block.type === "text",
					)
					.map((block) => block.text)
					.join("");
			},
		},
		{
			turnId: plan.turnId,
			systemPrompt: plan.systemPrompt,
			history: plan.history,
			userText: plan.userText,
		},
	);
}

/**
 * Runs one turn beside the workspace object, so a long model exchange or a
 * heavy sandbox never holds the object's own event loop. Events and binding
 * calls go back to the parent object over RPC.
 */
export class TurnFacet extends DurableObject<WorkspaceEnv> {
	/** The model this facet streams from; a test subclass returns a scripted one. */
	protected async modelFor(plan: TurnPlan): Promise<ModelPort> {
		return createAzureGatewayModel(this.env, {
			workspaceId: plan.scope.workspaceId,
			turnId: plan.turnId,
			actorId: plan.actor.id,
		});
	}

	async run(plan: TurnPlan, objectName: string): Promise<TurnResult> {
		const parent = durableObjectStubByName(
			this.env.WORKSPACE,
			this.env,
			objectName,
		) as unknown as {
			appendTurnEvent(
				scope: WorkspaceScope,
				turnId: string,
				event: LoopEvent,
			): Promise<void>;
		};
		const sandboxEnv: Record<string, unknown> = {};
		for (const binding of BINDING_NAMES) {
			sandboxEnv[binding] = this.ctx.exports.WorkspaceBindingLoopback({
				props: { objectName, scope: plan.scope, turnId: plan.turnId, binding },
			});
		}
		return executeTurn(plan, {
			env: this.env,
			model: await this.modelFor(plan),
			sandboxEnv,
			emit: (event) => {
				void parent.appendTurnEvent(plan.scope, plan.turnId, event);
			},
		});
	}
}

interface LoopbackProps {
	objectName: string;
	scope: WorkspaceScope;
	turnId: string;
	binding: BindingName;
}

/**
 * The stub the sandbox sees as `env.<binding>`. Every method forwards to the
 * workspace object, where the wrapped binding checks, runs and records it.
 */
export class WorkspaceBindingLoopback extends WorkerEntrypoint<
	WorkspaceEnv,
	LoopbackProps
> {
	async #call(method: string, args: unknown[]) {
		const props = this.ctx.props;
		const parent = durableObjectStubByName(
			this.env.WORKSPACE,
			this.env,
			props.objectName,
		) as unknown as {
			callBinding(
				scope: WorkspaceScope,
				input: {
					turnId: string;
					binding: string;
					method: string;
					args: unknown[];
				},
			): Promise<{ ok: boolean; value?: unknown; error?: string }>;
		};
		// Returned, not thrown: a refusal is an ordinary answer here, and the
		// sandbox harness turns it into the throw the model's code sees.
		return parent.callBinding(props.scope, {
			turnId: props.turnId,
			binding: props.binding,
			method,
			args,
		});
	}
	list(...args: unknown[]) {
		return this.#call("list", args);
	}
	listOpen(...args: unknown[]) {
		return this.#call("listOpen", args);
	}
	get(...args: unknown[]) {
		return this.#call("get", args);
	}
	create(...args: unknown[]) {
		return this.#call("create", args);
	}
	revise(...args: unknown[]) {
		return this.#call("revise", args);
	}
	read(...args: unknown[]) {
		return this.#call("read", args);
	}
	replace(...args: unknown[]) {
		return this.#call("replace", args);
	}
	edit(...args: unknown[]) {
		return this.#call("edit", args);
	}
}
