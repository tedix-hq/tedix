import type {
	OsWorkspaceChangeRecordsQuery,
	OsWorkspaceChangeRecordsExport,
} from "@tedix/api-contract/schemas/os-workspace-change-records";
import type { ChangeRecordQuery } from "./adapters";
/**
 * One object per workspace. It owns the workspace's rows (TenantStore), its
 * conversations, the event ledger and the change record, and it runs the
 * agent turn itself: the model streams here, its code runs in a no-network
 * sandbox whose `env` loops straight back into this object's wrapped bindings.
 */
import {
	WorkspaceChangeActorSchema,
	type WorkspaceChangeInput,
} from "@tedix/api-contract/schemas/workspace-feed";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Message } from "@earendil-works/pi-ai";
import { createDbClient } from "@tedix/db/client";
import { createDbQueryClient } from "@tedix/db/query-client";
import type { TenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import {
	executeOutputQuery,
	type OutputQuery,
	type OutputQueryResult,
	type OutputTransferResult,
	type DocumentTransfer,
	type DocumentTransferPackage,
	type DocumentTransferRuntime,
} from "@tedix/db/queries/durable-sqlite/output-rpc";
import {
	purgeWorkspaceDocuments,
	adoptWorkspaceDirectory,
	initializeWorkspaceDirectory,
	hasWorkspaceOutputAuthority,
	importOutput,
	snapshotOutput,
	type OutputTransferSnapshot,
} from "@tedix/db/queries/durable-sqlite/os-outputs";
import { listAllOsWorkspaceResourceRows } from "@tedix/db/queries/os-workspaces/resources";
import {
	getOsWorkspace,
	hasSharedWorkspaceOutputs,
	readSharedOutputForAdoption,
} from "@tedix/db/queries/os-workspaces/workspaces";
import { getTediById } from "@tedix/db/queries/tedis";
import {
	getSkillEntryBySlug,
	isSkillReadableByTedi,
} from "@tedix/db/queries/cognitive/skill-crud";
import { parseSkillReferences } from "@tedix/api-contract/utils/skill-reference";
import {
	retireWorkspaceOutputIndex,
	getWorkspaceOutputIndexCurrent,
	getWorkspaceOutputIndexRevision,
} from "@tedix/db/queries/workspace-feed/read";
import {
	hasWorkspaceActionProjection,
	publishWorkspaceAction,
} from "@tedix/db/queries/workspace-feed/action-publication";
import { publishOutputProjection } from "@tedix/db/queries/workspace-feed/output-publication";
import {
	applyOsWorkspaceObjectUsage,
	type OsWorkspaceRunStatusSummary,
	type OsWorkspaceUsageSummary,
} from "@tedix/db/queries/os-workspaces/summaries";
import { repointDocumentTransferIndex } from "@tedix/db/queries/workspace-feed/document-transfer";
import { unreferencedObjectOutputRevisions } from "@tedix/db/queries/os-workspaces/output-revision-thinning";
import { continuesOutputAutosaveBurst } from "@tedix/api-contract/utils/os-output-autosave";
import type { ModelCatalogEntry } from "@tedix/api-contract/schemas/model-catalog";
import { getModelCatalogConfig } from "@tedix/db/queries/model-catalog";
import {
	TenantStore,
	tenantStoreDefinition,
	type TenantStoreImportBatch,
	type TenantStoreDeltaBatch,
	type TenantStoreImportRow,
} from "@tedix/db/tenant-store/store";
import type { TenantScope } from "@tedix/db/tenant-scope";
import { tenantStoreName } from "@tedix/db/tenant-store/router";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import type {
	Actor,
	ChangeRecord,
	Source,
} from "@tedix/agent-governance/types";
import { CallRefusedError } from "@tedix/agent-governance/wrap-binding";
import { hashArguments } from "@tedix/agent-governance/hash";
import { SqlAccountabilityAdapter, SqlComplianceAdapter } from "./adapters";
import { buildWorkspaceBindings, type ConnectionRequest } from "./bindings";
import {
	AccountReadHeld,
	listLinkedAccounts,
	workspaceAccounts,
	type AccountService,
} from "./accounts";
import { SqlMemoryAdapter } from "./memory-adapter";
import { callFailureText, unsavableTextError } from "./call-failure";
import type { WorkspaceSnapshot } from "./data-port";
import { MAX_VIEWS_PER_TURN } from "./views";
import {
	createWebPort,
	type FetchFn,
	WEB_SCHEMA,
	webApprovalTitle,
} from "./web";
import { resolveAttachments } from "./attachments";
import {
	outputRevisionBodyKey,
	readOutputBody,
	TenantDataPort,
} from "./data-port-tenant";
import { notifyOutputRevision } from "@tedix/workspace-feed/output-revision-notice";
import { BINDING_NAMES, type BindingName } from "./declarations";
import {
	boundedEventInput,
	boundedEventText,
	EVENT_INPUT_CHARS,
	SqlEventLedger,
	sumUsageTotals,
} from "./event-ledger";
import { migrateMovedChat } from "./moved-chat";
import { SqlActivityRecords } from "./activity-records";
import type {
	ActorKind,
	TurnRequest,
	WorkspaceEnv,
	WorkspaceScope,
} from "./env";
import {
	assertWorkspaceGuestTedi,
	workspaceSessionAllowed,
	type WorkspaceSession,
} from "./session-access";
import { workspaceLog, type WorkspaceLogFields } from "./log";
import { apiInferenceAdmission } from "./admission";
import { handleMcpRequest } from "./mcp";
import {
	catalogWorkspaceModels,
	createWorkspaceModel,
	type ModelPort,
} from "./model";
import {
	buildSystemPrompt,
	type PendingApproval,
	type ReferencedSkill,
} from "./prompt";
import { fileWriteAppliesAtOnce } from "./auto-approval";
import type { WorkspaceStorage } from "./runtime";
import {
	createLoaderSandbox,
	SANDBOX_TIMEOUT_MS,
	validateWorkspaceAppSource,
} from "./sandbox";
import {
	type AddedMessage,
	runTurn,
	toTurnUsage,
	type TurnProgress,
	type TurnResult,
} from "./turn-loop";
import { priceTurn } from "./pricing";
import {
	type ClientFrame,
	type ConversationSummary,
	type WaitingApproval,
	stepLabel,
	type TurnUsage,
	type UsageTotals,
	type WireControlFrame,
	type WireEvent,
	type WireEventBody,
} from "./wire";

export const COMPATIBILITY_DATE = "2026-05-14";
/** Turns with more history than this run in their own facet. */
export const ISOLATE_AFTER_MESSAGES = 40;
const KEEPALIVE_MS = 60_000;
/**
 * How long a save waits for its file to reach the workspace feed. A slow or
 * failing feed must not hold the save: the file stays pending, publishing
 * carries on in the background and the alarm retries it.
 */
const PROJECTION_WAIT_MS = 250;
/** Client frame types a diagnostic line may name; anything else is "unknown". */
const FRAME_TYPES = new Set([
	"subscribe",
	"send_turn",
	"decide_approval",
	"decide_approvals",
	"cancel_turn",
	"rename_conversation",
	"archive_conversation",
	"delete_conversation",
	"read_ledger",
	"ping",
]);
const TURN_IDLE_TIMEOUT_MS = 15 * 60_000;
/** How long an object reuses the published model catalog before rereading it. */
const MODEL_CATALOG_TTL_MS = 60_000;

interface ActivityPageInput {
	afterSequence?: number;
	limit?: number;
	source?: "bindings" | "events";
}

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
CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id);
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
CREATE TABLE IF NOT EXISTS queued_messages (
	message_id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	at TEXT NOT NULL,
	status TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	actor_id TEXT NOT NULL,
	actor_kind TEXT NOT NULL,
	model_text TEXT NOT NULL,
	request TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS queued_messages_waiting ON queued_messages(conversation_id, status);
`;

type TurnStatus = "running" | "finished" | "failed" | "cancelled" | "waiting";

/** A turn's status as the core's run rollups name it. */
const CORE_RUN_STATUS: Record<TurnStatus, string> = {
	running: "running",
	waiting: "requires_approval",
	finished: "completed",
	failed: "failed",
	cancelled: "canceled",
};

interface WorkspaceUsage {
	usage: OsWorkspaceUsageSummary;
	runStatus: OsWorkspaceRunStatusSummary;
}

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

/** The most waiting requests one hello carries. */
const WAITING_APPROVALS_LIMIT = 200;

/** What one decision did to one waiting request. */
export interface ApprovalResult {
	applied: boolean;
	/** The turn that continues the conversation with the result. */
	turnId?: string;
	/**
	 * Someone else decided this request first. This decision changed nothing;
	 * `applied` says what the first one did.
	 */
	alreadyDecided?: true;
	/**
	 * The run stopped at this request and left the ones after it waiting:
	 * its change failed to apply, or someone decided it the other way.
	 */
	stopped?: { reason: "failed" | "decided_otherwise"; error?: string };
	/** An earlier request stopped the run before this one; it still waits. */
	left?: true;
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

/**
 * A message sent while a turn was working. `queued` until that turn reads it
 * (`read`), Stop hands it back (`returned`) or, when the turn ended first, it
 * starts the next turn (`started`).
 */
interface QueuedMessageRow {
	message_id: string;
	conversation_id: string;
	at: string;
	status: "queued" | "read" | "returned" | "started";
	/** The turn it waited for, then the turn that read it. */
	turn_id: string;
	seq: number;
	actor_id: string;
	actor_kind: ActorKind;
	/** What the model reads: the message and its attached files. */
	model_text: string;
	/** JSON `QueuedRequest`. */
	request: string;
}

/** What a queued message needs to start a turn of its own. */
interface QueuedRequest {
	input: TurnRequest;
	displayText?: string;
	shown: Pick<
		Extract<WireEventBody, { type: "message.queued" }>,
		"text" | "displayText" | "attachments" | "authorId" | "authorKind"
	>;
}

/** Results of decisions the person made while a turn was still working. */
interface DecisionNote {
	by: string;
	tediId: string | null;
	/** What the model reads: each decision and the call's result. */
	text: string;
	/** What the chat shows, e.g. "Approved the requested action." */
	displayText: string;
}

/**
 * The file an approved write saved, read from the write's result, so the
 * chat can take the change back later. Revision 1 means the write created it.
 */
function changedOutput(
	value: unknown,
): { outputId: string; revision: number } | null {
	if (!value || typeof value !== "object") return null;
	const { id, revision, kind } = value as Record<string, unknown>;
	if (typeof id !== "string" || typeof kind !== "string") return null;
	if (typeof revision !== "number" || !Number.isInteger(revision)) return null;
	return { outputId: id, revision };
}

/** The app an approved `env.apps.create` saved, read from its result. */
function createdApp(value: unknown): { appId: string; name: string } | null {
	if (!value || typeof value !== "object") return null;
	const { id, name } = value as Record<string, unknown>;
	if (typeof id !== "string" || typeof name !== "string") return null;
	return { appId: id, name: name.slice(0, 120) };
}

/**
 * What the card for a new app shows: its name, what it is for and the size
 * of each file. The source itself stays with the held call, so the card
 * never loses the name to a large file.
 */
function newAppCardInput(request: unknown): unknown {
	if (!request || typeof request !== "object") return request;
	const { name, description, files } = request as Record<string, unknown>;
	return {
		...(typeof name === "string" ? { name: name.slice(0, 120) } : {}),
		...(typeof description === "string"
			? { description: description.slice(0, 2_000) }
			: {}),
		files:
			files && typeof files === "object" && !Array.isArray(files)
				? Object.fromEntries(
						Object.entries(files)
							.slice(0, 50)
							.map(([path, text]) => [
								path.slice(0, 80),
								`${typeof text === "string" ? text.length : 0} characters`,
							]),
					)
				: {},
	};
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
	/** The guest tedi the turn runs as; its monthly credit cap applies. */
	tediId?: string;
	/**
	 * Sign-in subject of the member who sent the turn; their monthly credit
	 * cap applies. Absent when a tedi, an agent or a service sent it.
	 */
	memberId?: string;
	systemPrompt: string;
	history: Message[];
	userText: string;
	modelId?: string;
}

/**
 * The turn's model, with every call admitted against the organization's
 * credits and the tedi and member caps before it is sent.
 */
function admittedTurnModel(env: WorkspaceEnv, plan: TurnPlan): ModelPort {
	if (!env.API_SERVICE)
		throw new Error(
			"Workspace chat cannot reserve credits: the API service binding is missing",
		);
	return createWorkspaceModel(
		env,
		{
			organizationId: plan.scope.organizationId,
			workspaceId: plan.scope.workspaceId,
			turnId: plan.turnId,
			tediId: plan.tediId ?? null,
			userId: plan.memberId ?? null,
		},
		apiInferenceAdmission(env.API_SERVICE),
		plan.modelId,
	);
}

/** What the loop reports while it runs; the object turns it into wire events. */
export type LoopEvent = { type: string; data?: Record<string, unknown> };

/** Migration: walk one table in rowid order. */
export interface ExportRowsInput {
	table: string;
	after: string | null;
	limit: number;
}

interface PendingOutputTransfer {
	scope: WorkspaceScope;
	targetWorkspaceId: string;
	transferId: string;
}

interface DocumentTransferReceipt {
	transfer: DocumentTransfer;
	snapshot: DocumentTransferPackage["snapshot"];
	payloadSha256: string;
}

function sameDocumentTransfer(a: DocumentTransfer, b: DocumentTransfer) {
	return (
		a.transferId === b.transferId &&
		a.outputId === b.outputId &&
		a.sourceWorkspaceId === b.sourceWorkspaceId &&
		a.targetWorkspaceId === b.targetWorkspaceId
	);
}

export class WorkspaceDO extends TenantStore<WorkspaceEnv> {
	readonly #store: WorkspaceStorage;
	readonly #memory: SqlMemoryAdapter;
	readonly #events: SqlEventLedger;
	readonly #ledger: SqlAccountabilityAdapter;
	readonly #activityRecords: SqlActivityRecords;
	readonly #compliance: SqlComplianceAdapter;
	/**
	 * Decisions still being applied, each resolving when it lands, so a second
	 * decision on the same request can wait and report what the first did.
	 */
	readonly #deciding = new Map<string, Promise<void>>();
	#outputSerial: Promise<void> = Promise.resolve();
	/** File publishes to the workspace feed, one at a time and apart from writes. */
	#publishSerial: Promise<void> = Promise.resolve();
	#inflightTransfers = new Map<
		string,
		Promise<NonNullable<OutputQueryResult<"get">>>
	>();
	#activitySerial: Promise<void> = Promise.resolve();
	#pushSerial: Promise<void> = Promise.resolve();
	#movedChatReady = false;
	#workspaceRead: Promise<WorkspaceSnapshot> | null = null;
	#modelCatalog: {
		entries: readonly ModelCatalogEntry[];
		readAt: number;
	} | null = null;
	readonly #running = new Map<string, AbortController>();
	/** The code run each running turn is waiting for; no entry between runs. */
	readonly #codeRuns = new Map<string, string>();
	/** Views each running turn has put in its answer. */
	readonly #viewsShown = new Map<string, number>();
	readonly #waiters = new Map<string, Array<() => void>>();

	constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
		super(ctx, env, tenantStoreDefinition);
		this.#store = sqlStorage(ctx.storage);
		this.#store.delete("auto-approval-rules");
		this.#memory = new SqlMemoryAdapter(this.#store);
		this.#store.run(CHAT_SCHEMA);
		this.#activityRecords = new SqlActivityRecords(this.#store);
		this.#events = new SqlEventLedger(this.#store, (event) => {
			this.#recordConversationActivity(event);
			this.#pushSerial = this.#pushSerial.then(() => this.#push(event));
			this.ctx.waitUntil(this.#pushSerial);
			// Unread badges and chat notifications read the activity feed. A
			// post, a finished turn and a question go there now instead of
			// waiting for the next keepalive alarm.
			if (
				event.type === "turn.started" ||
				event.type === "turn.finished" ||
				event.type === "approval.requested"
			)
				this.ctx.waitUntil(this.#flushActivity());
		});
		this.#ledger = new SqlAccountabilityAdapter(this.#store);
		this.#compliance = new SqlComplianceAdapter(this.#store, {
			writesNeedApproval: true,
		});
		// A turn interrupted by eviction is marked failed; the user sees it at once.
		const now = new Date().toISOString();
		let interrupted = 0;
		for (const row of this.#store.exec<TurnRow>(
			"SELECT * FROM turns WHERE status = 'running'",
		)) {
			interrupted += 1;
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
		// Repeated wakes with sockets attached and no line after them mean the
		// object is being reset rather than hibernated.
		workspaceLog.info("Workspace object woke", {
			event: "workspace.woke",
			...this.#diagnostics(() => ({ latestSeq: this.#events.latestSeq() })),
			interrupted,
		});
	}

	/** Counts for a diagnostic line; never chat or file content. */
	#diagnostics(more?: () => Partial<WorkspaceLogFields>) {
		const objectId = this.ctx.id.toString();
		try {
			const turns: Record<string, number> = {};
			for (const row of this.#store.exec<{ status: string; total: number }>(
				"SELECT status, COUNT(*) AS total FROM turns GROUP BY status",
			))
				turns[row.status] = row.total;
			return {
				objectId,
				workspaceId:
					this.#store.get<WorkspaceScope>("activity-scope")?.workspaceId,
				sockets: this.ctx.getWebSockets().length,
				turns,
				...more?.(),
			};
		} catch {
			// A line about a failure must not fail on the same storage.
			return { objectId };
		}
	}

	#closeDenied(ws: WebSocket, where: string) {
		workspaceLog.warn("Workspace chat socket closed by its object", {
			event: "workspace.socket_denied",
			where,
			reason: "access_denied",
			closeCode: 1008,
			...this.#diagnostics(),
		});
		ws.close(1008, "Workspace access denied");
	}

	// ------------------------------------------------------------------ RPC

	protected override bindScope(scope: TenantScope) {
		const bound = super.bindScope(scope);
		if (!this.#movedChatReady) {
			this.ctx.storage.transactionSync(() =>
				migrateMovedChat(this.#store, bound),
			);
			this.#movedChatReady = true;
		}
		return bound;
	}

	override async importRows(scope: TenantScope, batch: TenantStoreImportBatch) {
		const bound = this.bindScope(scope);
		return this.#serializeOutput(async () => {
			// Resolve pre-upgrade imports and transfer destinations before staging new rows.
			const owned = await this.#ownsOutputs(bound);
			const result = this.ctx.storage.transactionSync(() => {
				const receipt = this.importRowsSync(scope, batch);
				this.#store.put("output-authority", owned ? "object" : "shared");
				if (receipt.status === "imported")
					this.#store.put(
						"output-import-generation",
						this.#importGeneration() + 1,
					);
				return receipt;
			});
			if (batch.table.startsWith("kernel_")) this.#movedChatReady = false;
			return result;
		});
	}

	async adoptSharedOutputs(
		scope: WorkspaceScope,
		input: { outputIds: string[]; dryRun: boolean },
	): Promise<{
		dryRun: boolean;
		scope: WorkspaceScope;
		writes: OutputTransferSnapshot[];
		unchanged: string[];
	}> {
		// A persisted owner has already bound its identity. Preview needs no claim,
		// directory adoption, or chat migration.
		if (this.#store.get("output-authority") !== "object")
			throw new Error(
				"Adoption requires an initialized or activated workspace store",
			);
		super.bindScope(scope);
		const result = await this.#serializeOutput(async () => {
			const core = createDbQueryClient(this.env.DB);
			const target = await getOsWorkspace(core, scope);
			if (target?.status !== "active" || target.visibility !== "org")
				throw new Error("Adoption requires an active organization workspace");
			const db = this.db as TenantStoreDb;
			const writes: OutputTransferSnapshot[] = [];
			const unchanged: string[] = [];
			for (const outputId of input.outputIds) {
				const source = await readSharedOutputForAdoption(core, {
					organizationId: scope.organizationId,
					outputId,
				});
				if (!source)
					throw new Error(
						`Output ${outputId} is missing from this organization`,
					);
				if (source.output.workspaceId !== null || this.#outputMoving(outputId))
					throw new Error(
						`Output ${outputId} already has a workspace or is moving`,
					);
				const snapshot = {
					output: { ...source.output, workspaceId: scope.workspaceId },
					revisions: source.revisions,
				};
				if (
					!snapshot.revisions.some(
						(row) => row.id === snapshot.output.currentRevisionId,
					)
				)
					throw new Error(
						`Output ${outputId} has no current revision in the source`,
					);
				const current = await getWorkspaceOutputIndexCurrent(core, {
					organizationId: scope.organizationId,
					outputId,
				});
				const existing = await snapshotOutput(db, { ...scope, outputId });
				if (current && (current.workspaceId !== scope.workspaceId || !existing))
					throw new Error(
						`Output ${outputId} already has a workspace in the index`,
					);
				for (const row of snapshot.revisions) {
					if (
						row.content !== "" ||
						!row.contentSha256 ||
						row.bodyR2Key !==
							outputRevisionBodyKey(scope.organizationId, row.contentSha256)
					)
						throw new Error(
							`Revision ${row.id} lacks an organization-scoped external body`,
						);
					await readOutputBody(this.env.R2_BUCKET, row);
				}
				if (!existing) writes.push(snapshot);
				else if (JSON.stringify(existing) === JSON.stringify(snapshot))
					unchanged.push(outputId);
				else
					throw new Error(`Output ${outputId} conflicts with the destination`);
			}
			if (!input.dryRun) {
				for (const snapshot of writes) {
					await this.#markOutputPending(scope, snapshot.output.id);
					await importOutput(db, snapshot);
				}
			}
			return { dryRun: input.dryRun, scope, writes, unchanged };
		});
		if (!input.dryRun && result.writes.length) {
			const outputIds = result.writes.map(({ output }) => output.id);
			await this.#serializePublish(() =>
				this.#flushOutputProjections(outputIds),
			);
		}
		return result;
	}

	async applyImportDelta(
		scope: WorkspaceScope,
		input: TenantStoreDeltaBatch & {
			importGeneration: number;
			freezeRef: string;
		},
	) {
		this.bindScope(scope);
		if (
			!input.freezeRef?.trim() ||
			!Number.isSafeInteger(input.importGeneration) ||
			input.importGeneration < 1 ||
			![
				"os_workspaces",
				"os_outputs",
				"os_output_revisions",
				"os_workspace_resources",
				"kernel_conversations",
				"kernel_runtime_runs",
				"kernel_runtime_events",
				"kernel_tool_results",
				"tedi_artifacts",
			].includes(input.table)
		)
			throw new Error(
				"Delta requires a staged generation, freeze evidence and workspace table",
			);
		return this.#serializeOutput(async () =>
			this.ctx.storage.transactionSync(() => {
				if (this.#store.get("output-authority") !== "shared")
					throw new Error("Delta requires staged shared authority");
				let rebuildChat = false;
				const receipt = this.applyImportDeltaSync(scope, input, () => {
					if (input.importGeneration !== this.#importGeneration())
						throw new Error("Import changed before delta");
					rebuildChat = input.table.startsWith("kernel_");
					if (rebuildChat) {
						const native = this.#store.exec<{
							id: string;
						}>(`SELECT turn_id AS id FROM turns WHERE actor_id != 'workspace_import'
					UNION ALL SELECT c.id FROM conversations c WHERE NOT EXISTS (
					 SELECT 1 FROM kernel_conversations k WHERE k.conversation_id = c.id AND k.title IS c.title AND k.deleted_at IS c.archived_at
					) UNION ALL SELECT k.conversation_id AS id FROM kernel_conversations k WHERE NOT EXISTS (
					 SELECT 1 FROM conversations c WHERE k.conversation_id = c.id
					) LIMIT 1`);
						if (native.length)
							throw new Error(
								"Chat delta conflicts with native workspace activity; review the merge",
							);
						for (const event of this.#store.exec<{ id: string }>(
							"SELECT id FROM kernel_runtime_events",
						))
							this.#store.delete(`moved-chat-event:${event.id}`);
						for (const table of [
							"messages",
							"events",
							"turns",
							"conversations",
						])
							this.#store.run(`DELETE FROM ${table}`);
						this.#store.delete("moved-chat-visible-archives");
					}
				});
				if (receipt.status === "imported") {
					this.#store.put(
						"output-import-generation",
						this.#importGeneration() + 1,
					);
					if (rebuildChat) migrateMovedChat(this.#store, scope);
				}
				return { ...receipt, importGeneration: this.#importGeneration() };
			}),
		);
	}

	#importGeneration(): number {
		return this.#store.get<number>("output-import-generation") ?? 0;
	}

	override describe(scope: TenantScope) {
		return {
			...super.describe(scope),
			outputAuthority:
				this.#store.get<string>("output-authority") ?? "unresolved",
			importGeneration: this.#importGeneration(),
		};
	}

	/** Operator attestation after reconciliation under a write freeze; never called by import. */
	async activateOutputAuthority(
		scope: WorkspaceScope,
		input: { importGeneration: number; reconciliationRef: string },
	) {
		this.bindScope(scope);
		if (
			!Number.isSafeInteger(input.importGeneration) ||
			input.importGeneration < 1 ||
			typeof input.reconciliationRef !== "string" ||
			!input.reconciliationRef.trim()
		)
			throw new Error(
				"Activation requires an import generation and reconciliation evidence",
			);
		return this.#serializeOutput(async () => {
			if (input.importGeneration !== this.#importGeneration())
				throw new Error("Import changed; reconcile again before activation");
			const previous = this.#store.get<typeof input>("output-activation");
			if (
				previous &&
				previous.importGeneration === input.importGeneration &&
				previous.reconciliationRef === input.reconciliationRef
			)
				return previous;
			if (this.#store.get("output-authority") !== "shared")
				throw new Error("Workspace is not staged on shared authority");
			this.ctx.storage.transactionSync(() => {
				this.#store.put("output-activation", input);
				this.#store.put("output-authority", "object");
			});
			return input;
		});
	}

	async #ownsOutputs(scope: WorkspaceScope): Promise<boolean> {
		const authority = this.#store.get("output-authority");
		if (authority === "object" || authority === "shared")
			return authority === "object";
		const owned = await hasWorkspaceOutputAuthority(
			this.db as TenantStoreDb,
			scope,
			createDbQueryClient(this.env.DB),
		);
		// An import or activation may have committed while the legacy check read D1.
		const resolved = this.#store.get("output-authority");
		if (resolved === "object" || resolved === "shared")
			return resolved === "object";
		if (owned) this.#store.put("output-authority", "object");
		return owned;
	}

	/**
	 * A workspace that has never been imported and has no files in the shared
	 * database has nothing to move: it keeps its files here from the start.
	 */
	async #claimOutputs(scope: WorkspaceScope): Promise<boolean> {
		const authority = this.#store.get("output-authority");
		if (
			authority !== "object" &&
			authority !== "shared" &&
			this.#importGeneration() === 0 &&
			!(await hasSharedWorkspaceOutputs(
				createDbQueryClient(this.env.DB),
				scope,
			))
		)
			this.#store.put("output-authority", "object");
		return this.#ownsOutputs(scope);
	}

	/**
	 * Once per store, before its first resource request: copy the workspace
	 * row and its resources from the shared database, which held the only
	 * copy until resources moved here. Without the workspace row every
	 * resource write in this store is refused.
	 */
	async #adoptDirectory(scope: WorkspaceScope): Promise<void> {
		if (this.#store.get("directory-adopted")) return;
		const core = createDbQueryClient(this.env.DB);
		const workspace = await getOsWorkspace(core, scope);
		if (!workspace) throw new Error("Workspace directory is missing");
		const resources = await listAllOsWorkspaceResourceRows(core, scope);
		this.ctx.storage.transactionSync(() => {
			adoptWorkspaceDirectory(this.db as TenantStoreDb, workspace, resources);
			this.#store.put("directory-adopted", true);
		});
	}

	async outputQuery<K extends OutputQuery["op"]>(
		scope: WorkspaceScope,
		query: OutputQuery<K>,
	): Promise<OutputQueryResult<K>> {
		this.bindScope(scope);
		const operation = query as OutputQuery;
		if (operation.op === "purge")
			return this.#serializeOutput(async () => {
				if (!(await this.#ownsOutputs(scope)))
					throw new Error("Workspace does not own these documents");
				this.ctx.storage.transactionSync(() => {
					purgeWorkspaceDocuments(this.db as TenantStoreDb, scope);
				});
				return undefined as OutputQueryResult<K>;
			});
		if (operation.op === "initialize")
			return this.#serializeOutput(async () => {
				if (this.#store.get("output-authority") === "object")
					return "object" as OutputQueryResult<K>;
				if (this.#importGeneration() > 0)
					throw new Error("Staged workspace requires migration activation");
				const core = createDbQueryClient(this.env.DB);
				const workspace = await getOsWorkspace(core, scope);
				if (!workspace) throw new Error("Workspace directory is missing");
				if (await hasSharedWorkspaceOutputs(core, scope))
					throw new Error("Workspace still has shared documents");
				this.ctx.storage.transactionSync(() => {
					initializeWorkspaceDirectory(this.db as TenantStoreDb, workspace);
					this.#store.put("output-authority", "object");
					this.#store.put("directory-adopted", true);
				});
				return "object" as OutputQueryResult<K>;
			});
		if (operation.op === "placementPlan")
			return this.#serializeOutput(async () => {
				if (!(await this.#ownsOutputs(scope)))
					throw new Error("Document placement requires an object owner");
				const key = `document-placement:${operation.planId}`;
				const previous = this.#store.get<DocumentTransfer[]>(key) ?? [];
				if (
					operation.documents.some(
						(document) =>
							document.targetWorkspaceId !== scope.workspaceId ||
							document.sourceWorkspaceId === scope.workspaceId,
					)
				)
					throw new Error("Document placement scope mismatch");
				const documents = [
					...previous,
					...operation.documents.filter(
						(document) =>
							!previous.some((saved) => saved.outputId === document.outputId),
					),
				];
				this.#store.put(key, documents);
				return documents as OutputQueryResult<K>;
			});
		if (operation.op === "authority")
			return (
				(await this.#ownsOutputs(scope)) ? "object" : "shared"
			) as OutputQueryResult<K>;
		if (operation.op === "claim")
			return (
				(await this.#claimOutputs(scope)) ? "object" : "shared"
			) as OutputQueryResult<K>;
		if (operation.op === "resources")
			return this.#serializeOutput(async () => {
				if (!(await this.#ownsOutputs(scope)))
					throw new Error("Workspace does not own these resources");
				await this.#adoptDirectory(scope);
				return executeOutputQuery(this.db as TenantStoreDb, scope, query);
			});
		if (operation.op === "thin" && !(await this.#ownsOutputs(scope)))
			throw new Error("Workspace does not own these outputs");
		if (operation.op === "snapshot" || operation.op === "import")
			throw new Error("Use the output transfer RPC");
		let outputId =
			operation.op === "create"
				? operation.output.id
				: operation.op === "mergeProposal"
					? operation.proposal.documentId
					: operation.op === "revise"
						? operation.params.outputId
						: operation.op === "update" ||
							  operation.op === "delete" ||
							  operation.op === "thin"
							? operation.outputId
							: null;
		if (operation.op === "rebody") {
			const revision = await executeOutputQuery(
				this.db as TenantStoreDb,
				scope,
				{ op: "revision", revisionId: operation.revisionId },
			);
			outputId = revision?.outputId ?? null;
		}
		// The writer knows the body's searchable text; publish it with this save.
		const excerpt =
			operation.op === "create" || operation.op === "revise"
				? operation.excerpt
				: undefined;
		const excerptRevisionId = !excerpt
			? undefined
			: operation.op === "create"
				? operation.revision.id
				: (operation as OutputQuery<"revise">).params.id;
		if (excerptRevisionId)
			this.#store.put(`output-excerpt:${excerptRevisionId}`, excerpt);
		const write = async () => {
			if (operation.op === "mergeProposal" && !(await this.#ownsOutputs(scope)))
				throw new Error(
					"Collaboration output merges require an activated workspace object",
				);
			const authorizedQuery: OutputQuery =
				operation.op === "thin"
					? {
							...operation,
							revisionIds: await unreferencedObjectOutputRevisions(
								createDbQueryClient(this.env.DB),
								{ ...scope, outputId: operation.outputId },
								operation.revisionIds,
							),
						}
					: operation;
			const result = await executeOutputQuery(
				this.db as TenantStoreDb,
				scope,
				authorizedQuery,
			);
			if (operation.op === "update" && result) {
				const row = result as OutputQueryResult<"update">;
				if (row?.currentRevisionId) {
					// This RPC carries no requesting actor; attribute execution to the service.
					this.#activityRecords.append({
						...scope,
						kind: "run",
						id: operation.outputId,
						revision: 1,
						actor: { kind: "service", id: "workspace_object" },
						changeRecordId: crypto.randomUUID(),
						at: row.updatedAt,
						summary: {
							action: {
								resource: "outputs",
								operation:
									operation.patch.status === "archived"
										? "archive"
										: operation.patch.status === "active"
											? "restore"
											: "update_metadata",
								outcome: "applied",
								surface: "workspace_object",
								revisionId: row.currentRevisionId,
							},
						},
					});
				}
			}
			return result as OutputQueryResult<K>;
		};
		const committed = outputId
			? this.#commitOutput(scope, outputId, write)
			: write();
		if (!excerptRevisionId) return committed;
		// Publishing a revision clears its text. A save that stored no revision
		// under this id is never published, so its text is cleared here.
		const dropUnsavedExcerpt = async () => {
			const saved = await executeOutputQuery(this.db as TenantStoreDb, scope, {
				op: "revision",
				revisionId: excerptRevisionId,
			});
			if (!saved) this.#store.delete(`output-excerpt:${excerptRevisionId}`);
		};
		try {
			const result = await committed;
			if (operation.op === "revise") {
				const revised = result as OutputQueryResult<"revise">;
				if (!revised.ok || revised.revision.id !== excerptRevisionId)
					await dropUnsavedExcerpt();
			}
			return result;
		} catch (error) {
			await dropUnsavedExcerpt();
			throw error;
		}
	}

	#outputTransfers() {
		return (
			this.#store.get<Record<string, PendingOutputTransfer>>(
				"output-transfers",
			) ?? {}
		);
	}

	async prepareDocumentTransfer(
		scope: WorkspaceScope,
		transfer: DocumentTransfer,
	): Promise<DocumentTransferPackage> {
		this.bindScope(scope);
		return this.#serializeOutput(async () => {
			if (!(await this.#ownsOutputs(scope)))
				throw new Error(
					"Document transfer requires activated workspace objects",
				);
			if (
				!transfer.transferId.trim() ||
				transfer.sourceWorkspaceId !== scope.workspaceId ||
				transfer.targetWorkspaceId === scope.workspaceId
			)
				throw new Error("Invalid document transfer scope");
			const key = `document-transfer:${transfer.transferId}`;
			const saved = this.#store.get<DocumentTransferPackage>(key);
			if (saved) {
				if (!sameDocumentTransfer(saved.transfer, transfer))
					throw new Error("Document transfer id conflicts with its receipt");
				return this.#store.get(
					`document-transfer-removed:${transfer.transferId}`,
				)
					? { ...saved, completed: true }
					: saved;
			}
			if (
				this.#store.get(`document-transfer-owner:${transfer.outputId}`) ||
				(this.#outputTransfers()[transfer.outputId] &&
					this.#outputTransfers()[transfer.outputId]!.transferId !==
						transfer.transferId) ||
				this.#store.get(`incoming-output:${transfer.outputId}`)
			)
				throw new Error("Output transfer already in progress");
			const snapshot = await executeOutputQuery(
				this.db as TenantStoreDb,
				scope,
				{ op: "snapshot", outputId: transfer.outputId },
			);
			if (!snapshot) throw new Error("Document transfer source not found");
			if (
				!snapshot.revisions.length ||
				!snapshot.revisions.some(
					(row) => row.id === snapshot.output.currentRevisionId,
				) ||
				snapshot.revisions.some((row) => !row.bodyR2Key)
			)
				throw new Error("Document transfer requires all revision bodies in R2");
			const outputRows = this.#store
				.exec<TenantStoreImportRow>(
					"SELECT * FROM os_outputs WHERE id = ?",
					transfer.outputId,
				)
				.map((row) => ({ ...row, workspace_id: transfer.targetWorkspaceId }));
			const revisions = this.#store.exec<TenantStoreImportRow>(
				"SELECT * FROM os_output_revisions WHERE output_id = ? ORDER BY revision",
				transfer.outputId,
			);
			const batches: DocumentTransferPackage["batches"] = [];
			for (const [table, rows] of [
				["os_outputs", outputRows],
				["os_output_revisions", revisions],
			] as const)
				for (let offset = 0; offset < rows.length; offset += 1000)
					batches.push({
						batchId: `document-transfer:${transfer.transferId}:${table}:${offset}`,
						table,
						rows: rows.slice(offset, offset + 1000),
					});
			const payload = {
				transfer,
				snapshot: {
					...snapshot,
					output: {
						...snapshot.output,
						workspaceId: transfer.targetWorkspaceId,
					},
				},
				batches,
			};
			this.ctx.storage.transactionSync(() => {
				this.#store.put(key, payload);
				this.#store.put(
					`document-transfer-owner:${transfer.outputId}`,
					transfer.transferId,
				);
			});
			return payload;
		});
	}

	async importDocumentTransfer(
		scope: WorkspaceScope,
		payload: DocumentTransferPackage,
	) {
		this.bindScope(scope);
		return this.#serializeOutput(async () => {
			if (!(await this.#ownsOutputs(scope)))
				throw new Error(
					"Document transfer requires activated workspace objects",
				);
			const { transfer, snapshot, batches } = payload;
			if (
				transfer.targetWorkspaceId !== scope.workspaceId ||
				snapshot.output.workspaceId !== scope.workspaceId ||
				snapshot.output.organizationId !== scope.organizationId ||
				snapshot.output.id !== transfer.outputId
			)
				throw new Error("Document transfer scope mismatch");
			const key = `document-transfer-import:${transfer.transferId}`;
			const payloadSha256 = await sha256Hex(JSON.stringify(payload));
			const receipt = { transfer, snapshot, payloadSha256 };
			const saved = this.#store.get<
				DocumentTransferReceipt | DocumentTransferPackage
			>(key);
			if (saved) {
				const savedHash =
					"payloadSha256" in saved
						? saved.payloadSha256
						: await sha256Hex(JSON.stringify(saved));
				if (savedHash !== payloadSha256)
					throw new Error("Document transfer id conflicts with its receipt");
				this.#store.put(key, receipt);
				return;
			}
			if (
				this.#store.get(`incoming-output:${transfer.outputId}`) ||
				this.#store.get(`document-transfer-owner:${transfer.outputId}`) ||
				this.#outputTransfers()[transfer.outputId]
			)
				throw new Error("Output transfer already in progress");
			this.ctx.storage.transactionSync(() => {
				for (const batch of batches) {
					if (
						!["os_outputs", "os_output_revisions"].includes(batch.table) ||
						!batch.batchId.startsWith(
							`document-transfer:${transfer.transferId}:`,
						)
					)
						throw new Error("Invalid document transfer batch");
					this.importRowsSync(scope, batch);
				}
				this.#store.put(
					`incoming-output:${transfer.outputId}`,
					transfer.transferId,
				);
				this.#store.delete(`transferred-output:${transfer.outputId}`);
				this.#store.put(key, receipt);
			});
		});
	}

	async confirmDocumentTransfer(
		scope: WorkspaceScope,
		transfer: DocumentTransfer,
	) {
		this.bindScope(scope);
		if (!(await this.#ownsOutputs(scope)))
			throw new Error("Document transfer requires activated workspace objects");
		const saved = this.#store.get<DocumentTransferReceipt>(
			`document-transfer-import:${transfer.transferId}`,
		);
		if (!saved || !sameDocumentTransfer(saved.transfer, transfer))
			throw new Error("Document transfer is not confirmed");
		const current = await executeOutputQuery(this.db as TenantStoreDb, scope, {
			op: "snapshot",
			outputId: transfer.outputId,
		});
		if (JSON.stringify(current) !== JSON.stringify(saved.snapshot))
			throw new Error("Document transfer destination changed after import");
		return saved.snapshot;
	}

	async removeDocumentTransfer(
		scope: WorkspaceScope,
		transfer: DocumentTransfer,
	) {
		this.bindScope(scope);
		if (!(await this.#ownsOutputs(scope)))
			throw new Error("Document transfer requires activated workspace objects");
		const saved = this.#store.get<DocumentTransferPackage>(
			`document-transfer:${transfer.transferId}`,
		);
		if (!saved || !sameDocumentTransfer(saved.transfer, transfer))
			throw new Error("Document transfer source receipt mismatch");
		const target = {
			organizationId: scope.organizationId,
			workspaceId: transfer.targetWorkspaceId,
		};
		const destination = durableObjectStubByName(
			this.env.WORKSPACE,
			this.env,
			tenantStoreName(target),
		) as unknown as WorkspaceRpc;
		if (this.#store.get(`document-transfer-removed:${transfer.transferId}`)) {
			await destination.completeOutputTransfer(
				target,
				transfer.outputId,
				transfer.transferId,
			);
			return;
		}
		const confirmed = await destination.confirmDocumentTransfer(
			target,
			transfer,
		);
		if (JSON.stringify(confirmed) !== JSON.stringify(saved.snapshot))
			throw new Error("Document transfer confirmation mismatch");
		for (const revision of confirmed.revisions) {
			const indexed = await getWorkspaceOutputIndexRevision(
				createDbQueryClient(this.env.DB),
				{ organizationId: scope.organizationId, revisionId: revision.id },
			);
			if (indexed?.workspaceId !== target.workspaceId)
				throw new Error("Document transfer index is not repointed");
		}
		await this.#serializeOutput(async () => {
			if (
				!this.#store.get(`document-transfer-removed:${transfer.transferId}`)
			) {
				if (
					this.#store.get(`document-transfer-owner:${transfer.outputId}`) !==
					transfer.transferId
				)
					throw new Error("Document transfer source owner changed");
				this.ctx.storage.transactionSync(() => {
					this.#store.run(
						"DELETE FROM os_output_revisions WHERE output_id = ?",
						transfer.outputId,
					);
					this.#store.run(
						"DELETE FROM os_outputs WHERE id = ?",
						transfer.outputId,
					);
					this.#store.put(`transferred-output:${transfer.outputId}`, true);
					this.#store.delete(`document-transfer-owner:${transfer.outputId}`);
					const projections = this.#pendingOutputProjections();
					delete projections[transfer.outputId];
					this.#store.put("pending-output-projections", projections);
					this.#store.put(
						`document-transfer-removed:${transfer.transferId}`,
						true,
					);
					this.#store.put(`document-transfer:${transfer.transferId}`, {
						...saved,
						batches: [],
					});
				});
			}
		});
		await destination.completeOutputTransfer(
			target,
			transfer.outputId,
			transfer.transferId,
		);
	}

	async transferOutput(
		scope: WorkspaceScope,
		outputId: string,
		targetWorkspaceId: string,
	): Promise<OutputTransferResult> {
		this.bindScope(scope);
		if (scope.workspaceId === targetWorkspaceId) {
			const output = await executeOutputQuery(this.db as TenantStoreDb, scope, {
				op: "get",
				outputId,
			});
			return output ? { ok: true, output } : { ok: false, reason: "not_found" };
		}
		const prepared = await this.#serializeOutput(async () => {
			let pending = this.#outputTransfers()[outputId];
			const owner = this.#store.get<string>(
				`document-transfer-owner:${outputId}`,
			);
			if (
				(pending && pending.targetWorkspaceId !== targetWorkspaceId) ||
				(owner && owner !== pending?.transferId) ||
				this.#store.get(`incoming-output:${outputId}`)
			)
				return { ok: false as const, reason: "conflict" as const };
			if (!pending) {
				const snapshot = await executeOutputQuery(
					this.db as TenantStoreDb,
					scope,
					{ op: "snapshot", outputId },
				);
				if (!snapshot)
					return { ok: false as const, reason: "not_found" as const };
				pending = {
					scope,
					targetWorkspaceId,
					transferId: crypto.randomUUID(),
				};
				await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
				this.#store.put("output-transfers", {
					...this.#outputTransfers(),
					[outputId]: pending,
				});
			}
			// A publish already running must land before the index is repointed;
			// later ones skip a file that is moving.
			await this.#publishSerial;
			return { pending };
		});
		if (!prepared.pending) return prepared;
		return {
			ok: true,
			output: await this.#runOutputTransfer(outputId, prepared.pending),
		};
	}

	#runOutputTransfer(outputId: string, pending: PendingOutputTransfer) {
		const running = this.#inflightTransfers.get(outputId);
		if (running) return running;
		const next = this.#finishOutputTransfer(outputId, pending).finally(() =>
			this.#inflightTransfers.delete(outputId),
		);
		this.#inflightTransfers.set(outputId, next);
		return next;
	}

	async #finishOutputTransfer(
		outputId: string,
		pending: PendingOutputTransfer,
	) {
		const target = {
			organizationId: pending.scope.organizationId,
			workspaceId: pending.targetWorkspaceId,
		};
		const destination = durableObjectStubByName(
			this.env.WORKSPACE,
			this.env,
			tenantStoreName(target),
		) as unknown as WorkspaceRpc;
		const transfer = {
			transferId: pending.transferId,
			outputId,
			sourceWorkspaceId: pending.scope.workspaceId,
			targetWorkspaceId: pending.targetWorkspaceId,
		};
		const payload = await this.prepareDocumentTransfer(pending.scope, transfer);
		if (!payload.completed) {
			await destination.importDocumentTransfer(target, payload);
			const snapshot = payload.snapshot;
			for (const revision of snapshot.revisions)
				await publishOutputProjection(
					createDbQueryClient(this.env.DB),
					snapshot.output,
					revision,
					{
						historical: revision.id !== snapshot.output.currentRevisionId,
						continuesBurst: continuesOutputAutosaveBurst(
							snapshot.revisions.find(
								(row) => row.revision === revision.revision - 1,
							),
							revision,
						),
					},
				);
			const confirmed = await destination.confirmDocumentTransfer(
				target,
				transfer,
			);
			if (JSON.stringify(confirmed) !== JSON.stringify(payload.snapshot))
				throw new Error("Document transfer confirmation mismatch");
			await repointDocumentTransferIndex(
				createDbQueryClient(this.env.DB),
				pending.scope.organizationId,
				payload,
			);
		}
		await this.removeDocumentTransfer(pending.scope, transfer);
		const transfers = this.#outputTransfers();
		delete transfers[outputId];
		this.#store.put("output-transfers", transfers);
		return payload.snapshot.output;
	}

	completeOutputTransfer(
		scope: WorkspaceScope,
		outputId: string,
		transferId: string,
	) {
		this.bindScope(scope);
		if (this.#store.get(`incoming-output:${outputId}`) === transferId)
			this.#store.delete(`incoming-output:${outputId}`);
	}

	/**
	 * Start a turn. Returns at once; follow it through the event stream.
	 * While a turn is working in the conversation the message does not start
	 * a second one: it is queued for that turn, which reads it before its next
	 * model call. `turnId` is then the working turn and `queued` is set.
	 */
	async sendTurn(
		scope: WorkspaceScope,
		input: TurnRequest,
		displayText?: string,
	): Promise<{
		turnId: string;
		conversationId: string;
		seq: number;
		queued?: true;
	}> {
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
		const waiting = this.#queuedMessage(turnId);
		if (waiting) return queuedReceipt(waiting);
		await this.refreshModelCatalog();
		const models = this.configuredModels();
		const modelId = input.modelId ?? models[0]?.id;
		if (!modelId) throw new Error("No model is configured for workspace chat");
		if (!models.some((model) => model.id === modelId))
			throw new Error("This model is not configured for workspace chat");
		const text = input.text.trim();
		if (!text) throw new Error("A turn needs text");
		const selected = await resolveAttachments(
			this.#dataPort(scope, input.actorKind),
			input.attachments,
		);
		// Resolving file bodies yields; a retried frame may have admitted this id.
		const admitted = this.#turn(turnId);
		if (admitted)
			return {
				turnId,
				conversationId: admitted.conversation_id,
				seq: admitted.first_seq ?? this.#events.latestSeq(),
			};
		const requeued = this.#queuedMessage(turnId);
		if (requeued) return queuedReceipt(requeued);
		const now = new Date().toISOString();
		this.#store.put("activity-scope", scope);
		const author = {
			authorId: input.actorId,
			authorKind:
				input.actorKind === "tedi" ? ("tedi" as const) : ("person" as const),
		};
		const working = input.conversationId
			? this.#runningTurnIn(input.conversationId)
			: undefined;
		if (working) {
			const shown: QueuedRequest["shown"] = {
				text,
				...(displayText ? { displayText } : {}),
				...(selected.attachments.length
					? { attachments: selected.attachments }
					: {}),
				...author,
			};
			const request: QueuedRequest = {
				input: { ...input, modelId },
				...(displayText ? { displayText } : {}),
				shown,
			};
			return queuedReceipt(
				this.#queueMessage(working, turnId, now, {
					actorId: input.actorId,
					actorKind: input.actorKind,
					modelText: text + selected.context,
					request,
				}),
			);
		}
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
		const startEvent = {
			type: "turn.started" as const,
			turnId,
			text,
			...(displayText ? { displayText } : {}),
			...(selected.attachments.length
				? { attachments: selected.attachments }
				: {}),
			...author,
			respondingTediId:
				input.tediId ?? (input.actorKind === "tedi" ? input.actorId : null),
		};
		const started = this.#events.append(conversationId, startEvent);
		this.#store.run(
			"UPDATE turns SET first_seq = ? WHERE turn_id = ?",
			started.seq,
			turnId,
		);
		// Decisions made while an earlier turn worked reach the model with
		// this message; the chat shows only what the person wrote.
		const decisions = this.#takeDecisionNotes(conversationId)
			.map((note) => `${note.text}\n\n`)
			.join("");
		const controller = new AbortController();
		this.#running.set(turnId, controller);
		await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
		this.ctx.waitUntil(
			this.#execute(
				scope,
				turnId,
				conversationId,
				{ ...input, modelId, text: decisions + text + selected.context },
				controller,
			),
		);
		return { turnId, conversationId, seq: started.seq };
	}

	async cancelTurn(scope: WorkspaceScope, turnId: string): Promise<boolean> {
		this.bindScope(scope);
		const turn = this.#turn(turnId);
		if (!turn || turn.status !== "running") return false;
		this.#stopTurn(turn, "cancelled by user", "cancelled");
		return true;
	}

	#stopTurn(turn: TurnRow, reason: string, status: "failed" | "cancelled") {
		this.#running.get(turn.turn_id)?.abort(new Error(reason));
		const now = new Date().toISOString();
		this.#store.run(
			"UPDATE turns SET status = ?, error = ?, finished_at = ? WHERE turn_id = ? AND status = 'running'",
			status,
			reason,
			now,
			turn.turn_id,
		);
		// Stop also takes back what the agent has not read; the chat puts the
		// text back for the person. A failed turn leaves it for the next turn.
		if (status === "cancelled")
			for (const message of this.#queuedMessages(turn.conversation_id))
				this.#returnQueuedMessage(message);
		this.#events.append(turn.conversation_id, {
			type: "turn.finished",
			turnId: turn.turn_id,
			status: status === "failed" ? "error" : "cancelled",
			error: reason,
			durationMs: Math.max(0, Date.parse(now) - Date.parse(turn.started_at)),
		});
		this.#running.delete(turn.turn_id);
		this.#codeRuns.delete(turn.turn_id);
		for (const wake of this.#waiters.get(turn.turn_id) ?? []) wake();
		this.#waiters.delete(turn.turn_id);
	}

	appendAgentRunNotice(
		scope: WorkspaceScope,
		input: { conversationId: string; attemptId: string; content: string },
	): void {
		this.bindScope(scope);
		const noticeId = "agent-run-ended:" + input.attemptId;
		this.ctx.storage.transactionSync(() => {
			if (this.#store.get(noticeId)) return;
			this.#ensureConversation(
				input.conversationId,
				"",
				new Date().toISOString(),
			);
			this.#events.append(input.conversationId, {
				type: "agent_run.ended",
				turnId: noticeId,
				text: input.content,
			});
			this.#store.put(noticeId, true);
		});
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
		return this.#events
			.replay(input.after ?? 0, input.conversationId ?? null, input.limit)
			.map((event) => this.#withTurnAuthors(event));
	}

	/** History paging for one conversation: the newest events before a cursor. */
	readLedger(
		scope: WorkspaceScope,
		conversationId: string,
		input: { before?: number | null; limit?: number } = {},
	): WireEvent[] {
		this.bindScope(scope);
		return this.#events
			.history(conversationId, input.before ?? null, input.limit)
			.map((event) => this.#withTurnAuthors(event));
	}

	#withTurnAuthors(event: WireEvent): WireEvent {
		if (event.type !== "turn.started") return event;
		const turn = this.#turn(event.turnId);
		if (!turn) return event;
		const authors = {
			authorId: turn.actor_id,
			authorKind:
				turn.actor_kind === "tedi" ? ("tedi" as const) : ("person" as const),
			respondingTediId:
				turn.tedi_id ?? (turn.actor_kind === "tedi" ? turn.actor_id : null),
		};
		return { ...event, ...authors };
	}

	listConversations(scope: WorkspaceScope): ConversationSummary[] {
		this.bindScope(scope);
		return this.#listConversations(this.#events.usageByConversation());
	}

	/** The newest 200 conversations of the list, or of the archive. */
	#listConversations(
		usage: Map<string, UsageTotals>,
		archived = false,
	): ConversationSummary[] {
		// Who sent each conversation's first message, read in one pass. With
		// MIN() SQLite takes the other columns from that same earliest turn.
		const starters = new Map(
			this.#store
				.exec<{
					conversation_id: string;
					actor_kind: string;
					actor_id: string;
				}>(
					"SELECT conversation_id, actor_kind, actor_id, MIN(started_at) AS first_at FROM turns GROUP BY conversation_id",
				)
				.filter((turn) => turn.actor_kind !== "user")
				.map((turn) => [
					turn.conversation_id,
					{
						kind:
							turn.actor_kind === "tedi"
								? ("tedi" as const)
								: ("agent" as const),
						id: turn.actor_id,
					},
				]),
		);
		return this.#store
			.exec<{
				id: string;
				title: string | null;
				updated_at: string;
				last_turn_at: string | null;
				archived_at: string | null;
				running: number;
				pending_approvals: number;
			}>(
				`SELECT c.id, c.title, c.updated_at, c.last_turn_at, c.archived_at, EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id = c.id AND t.status = 'running') AS running, (SELECT COUNT(*) FROM approvals a WHERE a.conversation_id = c.id AND a.status = 'pending') AS pending_approvals FROM conversations c WHERE c.archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY c.updated_at DESC LIMIT 200`,
			)
			.map((row) => ({
				id: row.id,
				title: row.title,
				updatedAt: row.updated_at,
				lastTurnAt: row.last_turn_at,
				...(row.running ? { running: true } : {}),
				...(row.pending_approvals
					? { pendingApprovals: row.pending_approvals }
					: {}),
				...(row.archived_at ? { archivedAt: row.archived_at } : {}),
				...(usage.has(row.id) ? { usage: usage.get(row.id) } : {}),
				...(starters.has(row.id) ? { startedBy: starters.get(row.id) } : {}),
			}));
	}

	listConversationTurnIds(scope: WorkspaceScope, conversationId: string) {
		this.bindScope(scope);
		return this.#store
			.exec<{ turn_id: string }>(
				"SELECT turn_id FROM turns WHERE conversation_id = ?",
				conversationId,
			)
			.map((row) => row.turn_id);
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

	async exportChangeRecords(
		scope: WorkspaceScope,
		query: OsWorkspaceChangeRecordsQuery,
	): Promise<OsWorkspaceChangeRecordsExport> {
		const limit = Math.min(Math.max(query.limit, 1), 200);
		// Both queries execute synchronously before yielding, so the count and page agree.
		const pending = this.readChangeRecords(scope, {
			...query,
			limit: limit + 1,
		});
		const count = this.#ledger.countRange(query.from, query.until);
		const records = await pending;
		const page = records.slice(0, limit);
		return {
			workspaceId: scope.workspaceId,
			from: query.from,
			until: query.until,
			exportedAt: new Date().toISOString(),
			count,
			records: page.map((record) => ({ ...record })),
			nextAfterSequence: records.length > limit ? page.at(-1)!.sequence : null,
		};
	}

	/** The accountability ledger: one record per binding call. */
	readChangeRecords(
		scope: WorkspaceScope,
		query: ChangeRecordQuery = {},
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
	): Promise<ApprovalResult> {
		return (
			await this.decideApprovals(scope, {
				approvalIds: [input.approvalId],
				decision: input.decision,
				by: input.by,
				...(input.note ? { note: input.note } : {}),
			})
		)[0]!;
	}

	/**
	 * Decide several held writes together, one at a time in the order given;
	 * they may come from different conversations. The run stops at the first
	 * change that fails to apply, or at a request someone decided the other
	 * way, and leaves the rest waiting: a later change may build on the one
	 * that did not land. Each conversation then continues with one turn that
	 * carries every result, so approving three proposals starts one answer,
	 * not three that run side by side.
	 */
	async decideApprovals(
		scope: WorkspaceScope,
		input: {
			approvalIds: string[];
			decision: "approve" | "deny";
			by: string;
			note?: string;
		},
	): Promise<ApprovalResult[]> {
		this.bindScope(scope);
		const results: ApprovalResult[] = [];
		const approve = input.decision === "approve";
		const rows = input.approvalIds.map((approvalId) => {
			const [approval] = this.#store.exec<ApprovalRow>(
				"SELECT * FROM approvals WHERE approval_id = ?",
				approvalId,
			);
			if (!approval) throw new Error("Unknown approval");
			return approval;
		});
		/** What this run decided, by conversation, in the order it happened. */
		const decided = new Map<
			string,
			{
				first: ApprovalRow;
				settled: Array<{ index: number; approvalId: string; applied: boolean }>;
				summaries: string[];
			}
		>();
		let stopped = false;
		for (const [index, approval] of rows.entries()) {
			if (stopped) {
				results.push({ applied: false, left: true });
				continue;
			}
			const approvalId = approval.approval_id;
			// The rows above were read before the first change was applied, and
			// applying one lets other calls in. So each request is taken here,
			// just before it is applied, and only if it is still waiting.
			const outcome = await this.#settleApproval(scope, approval, input);
			if (!outcome) {
				// Someone else decided it, or is still applying it: wait for that
				// to land and report what it was.
				await this.#deciding.get(approvalId);
				const [current] = this.#store.exec<{ status: ApprovalRow["status"] }>(
					"SELECT status FROM approvals WHERE approval_id = ?",
					approvalId,
				);
				const otherwise = approve
					? current?.status === "denied"
					: current?.status !== "denied";
				stopped = otherwise;
				results.push({
					...(this.#store.get<{ applied: boolean; turnId?: string }>(
						`approval-result:${approvalId}`,
					) ?? { applied: current?.status === "applied" }),
					alreadyDecided: true,
					...(otherwise
						? { stopped: { reason: "decided_otherwise" as const } }
						: {}),
				});
				continue;
			}
			if (outcome.refusal) {
				stopped = true;
				results.push({
					applied: false,
					stopped: { reason: "failed", error: outcome.refusal },
				});
				continue;
			}
			const conversation = decided.get(approval.conversation_id) ?? {
				first: approval,
				settled: [],
				summaries: [],
			};
			decided.set(approval.conversation_id, conversation);
			conversation.settled.push({
				index,
				approvalId,
				applied: outcome.applied,
			});
			conversation.summaries.push(outcome.summary);
			const failed = approve && !outcome.applied;
			stopped = failed;
			results.push({
				applied: outcome.applied,
				...(failed
					? {
							stopped: {
								reason: "failed" as const,
								...(outcome.outcome && !outcome.outcome.ok
									? { error: outcome.outcome.error }
									: {}),
							},
						}
					: {}),
			});
		}
		for (const [conversationId, { first, settled, summaries }] of decided) {
			const note: DecisionNote = {
				by: input.by,
				tediId: first.tedi_id,
				text: summaries.join("\n"),
				displayText:
					settled.length > 1
						? approve
							? `Approved ${settled.length} requested actions.`
							: `Denied ${settled.length} requested actions.`
						: approve
							? "Approved the requested action."
							: "Denied the requested action.",
			};
			// The person kept chatting and a turn is still working: it would race
			// a second answer. The results wait for that turn to finish.
			if (this.#runningTurnIn(conversationId)) {
				this.#queueDecisionNote(conversationId, note);
				continue;
			}
			const { turnId } = await this.sendTurn(
				scope,
				{
					conversationId,
					actorId: note.by,
					actorKind: "user",
					text: note.text,
					...(note.tediId ? { tediId: note.tediId } : {}),
				},
				note.displayText,
			);
			for (const item of settled) {
				this.#store.put(`approval-result:${item.approvalId}`, {
					applied: item.applied,
					turnId,
				});
				results[item.index] = { ...results[item.index]!, turnId };
			}
		}
		return results;
	}

	#runningTurnIn(conversationId: string): TurnRow | undefined {
		return this.#store.exec<TurnRow>(
			"SELECT * FROM turns WHERE conversation_id = ? AND status = 'running' LIMIT 1",
			conversationId,
		)[0];
	}

	/** A message held for a working turn; not one that became a turn itself. */
	#queuedMessage(messageId: string): QueuedMessageRow | undefined {
		return this.#store.exec<QueuedMessageRow>(
			"SELECT * FROM queued_messages WHERE message_id = ? AND status != 'started'",
			messageId,
		)[0];
	}

	/** Messages no turn has read yet, oldest first. */
	#queuedMessages(conversationId: string): QueuedMessageRow[] {
		return this.#store.exec<QueuedMessageRow>(
			"SELECT * FROM queued_messages WHERE conversation_id = ? AND status = 'queued' ORDER BY rowid ASC",
			conversationId,
		);
	}

	/** Hold a message for the turn that is working, and show it as waiting. */
	#queueMessage(
		working: TurnRow,
		messageId: string,
		now: string,
		message: {
			actorId: string;
			actorKind: ActorKind;
			modelText: string;
			request: QueuedRequest;
		},
	): QueuedMessageRow {
		const row: QueuedMessageRow = {
			message_id: messageId,
			conversation_id: working.conversation_id,
			at: now,
			status: "queued",
			turn_id: working.turn_id,
			seq: 0,
			actor_id: message.actorId,
			actor_kind: message.actorKind,
			model_text: message.modelText,
			request: JSON.stringify(message.request),
		};
		// The row comes first: the activity feed names the sender from it.
		this.#store.run(
			"INSERT OR REPLACE INTO queued_messages (message_id, conversation_id, at, status, turn_id, seq, actor_id, actor_kind, model_text, request) VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?)",
			row.message_id,
			row.conversation_id,
			row.at,
			row.turn_id,
			row.actor_id,
			row.actor_kind,
			row.model_text,
			row.request,
		);
		row.seq = this.#events.append(working.conversation_id, {
			type: "message.queued",
			turnId: working.turn_id,
			messageId,
			...message.request.shown,
		}).seq;
		this.#store.run(
			"UPDATE queued_messages SET seq = ? WHERE message_id = ?",
			row.seq,
			messageId,
		);
		this.#store.run(
			"UPDATE conversations SET updated_at = ?, last_turn_at = ? WHERE id = ?",
			now,
			now,
			working.conversation_id,
		);
		return row;
	}

	#returnQueuedMessage(message: QueuedMessageRow) {
		this.#store.run(
			"UPDATE queued_messages SET status = 'returned' WHERE message_id = ?",
			message.message_id,
		);
		this.#events.append(message.conversation_id, {
			type: "message.returned",
			turnId: message.turn_id,
			messageId: message.message_id,
			...(JSON.parse(message.request) as QueuedRequest).shown,
		});
	}

	/**
	 * Hand a working turn the messages sent since its last model call. Each
	 * joins the conversation as the person's message, in this turn, and the
	 * chat stops showing it as unread. Also the facet's callback.
	 */
	takeQueuedMessages(scope: WorkspaceScope, turnId: string): AddedMessage[] {
		this.bindScope(scope);
		const turn = this.#turn(turnId);
		if (!turn || turn.status !== "running") return [];
		const taken: AddedMessage[] = [];
		for (const message of this.#queuedMessages(turn.conversation_id)) {
			const request = JSON.parse(message.request) as QueuedRequest;
			// A message addressed to another tedi needs that tedi's own turn.
			if (request.input.tediId && request.input.tediId !== turn.tedi_id) break;
			const now = new Date().toISOString();
			this.#store.run(
				"UPDATE queued_messages SET status = 'read', turn_id = ? WHERE message_id = ?",
				turnId,
				message.message_id,
			);
			this.#store.run(
				"INSERT INTO messages (conversation_id, turn_id, at, message) VALUES (?, ?, ?, ?)",
				turn.conversation_id,
				turnId,
				now,
				JSON.stringify({
					role: "user",
					content: message.model_text,
					timestamp: Date.parse(now),
				} satisfies Message),
			);
			this.#events.append(turn.conversation_id, {
				type: "message.read",
				turnId,
				messageId: message.message_id,
				...request.shown,
			});
			taken.push({ id: message.message_id, text: message.model_text });
		}
		return taken;
	}

	/**
	 * A turn ended before it read everything sent to it: the oldest unread
	 * message starts the next turn, and that turn reads the rest. True when a
	 * turn started.
	 */
	async #startQueuedMessage(
		scope: WorkspaceScope,
		conversationId: string,
	): Promise<boolean> {
		if (this.#runningTurnIn(conversationId)) return false;
		const [next] = this.#queuedMessages(conversationId);
		if (!next) return false;
		const request = JSON.parse(next.request) as QueuedRequest;
		this.#store.run(
			"UPDATE queued_messages SET status = 'started' WHERE message_id = ?",
			next.message_id,
		);
		try {
			await this.sendTurn(
				scope,
				{ ...request.input, turnId: next.message_id, conversationId },
				request.displayText,
			);
			return true;
		} catch (error) {
			// It cannot start a turn (its model is gone, say). Hand it back so
			// the chat does not show it as unread for ever.
			workspaceLog.warn("A queued message did not start a turn", {
				event: "workspace.queued_message_not_started",
				error,
				...this.#diagnostics(),
			});
			if (!this.#turn(next.message_id)) this.#returnQueuedMessage(next);
			return false;
		}
	}

	#queueDecisionNote(conversationId: string, note: DecisionNote) {
		const key = `decision-notes:${conversationId}`;
		this.#store.put(key, [
			...(this.#store.get<DecisionNote[]>(key) ?? []),
			note,
		]);
	}

	/** Decisions made while a turn was working, taken once. */
	#takeDecisionNotes(conversationId: string): DecisionNote[] {
		const key = `decision-notes:${conversationId}`;
		const notes = this.#store.get<DecisionNote[]>(key) ?? [];
		if (notes.length) this.#store.delete(key);
		return notes;
	}

	/**
	 * After a turn finishes, answer the decisions the person made while it
	 * worked, in one turn. A stopped or failed turn leaves them for the
	 * person's next message, so nothing starts on its own after a Stop.
	 */
	async #continueAfterDecisions(scope: WorkspaceScope, conversationId: string) {
		if (this.#runningTurnIn(conversationId)) return;
		const notes = this.#takeDecisionNotes(conversationId);
		const last = notes.at(-1);
		if (!last) return;
		await this.sendTurn(
			scope,
			{
				conversationId,
				actorId: last.by,
				actorKind: "user",
				text: notes.map((note) => note.text).join("\n"),
				...(notes[0]?.tediId ? { tediId: notes[0].tediId } : {}),
			},
			notes.map((note) => note.displayText).join(" "),
		);
	}

	#conversationRow(conversationId: string) {
		const [row] = this.#store.exec<{ archived_at: string | null }>(
			"SELECT archived_at FROM conversations WHERE id = ?",
			String(conversationId),
		);
		if (!row) throw new Error("Unknown conversation");
		return row;
	}

	/**
	 * A rename or an archive is a ledger event, and the ledger sends an event
	 * only to the chats that follow its conversation. This sends it to the
	 * chats that follow another one, so every open list changes.
	 */
	#announceConversation(event: WireEvent) {
		const frame = JSON.stringify(event);
		this.#pushSerial = this.#pushSerial.then(async () => {
			for (const ws of this.ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as
					| (WorkspaceSession & { conversationId?: string | null })
					| null;
				if (
					!attachment?.conversationId ||
					attachment.conversationId === event.conversationId ||
					!(await workspaceSessionAllowed(this.env.DB, attachment))
				)
					continue;
				try {
					ws.send(frame);
				} catch {
					/* a closed socket is dropped by the runtime */
				}
			}
		});
		this.ctx.waitUntil(this.#pushSerial);
	}

	/** Give a conversation a new name. Every open chat hears it. */
	renameConversation(
		scope: WorkspaceScope,
		input: { conversationId: string; title: string },
	): void {
		this.bindScope(scope);
		const title = String(input.title ?? "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 80);
		if (!title) throw new Error("A conversation needs a name");
		this.#conversationRow(input.conversationId);
		// `updated_at` moves too, so a chat that replays an older name keeps this one.
		this.#store.run(
			"UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
			title,
			new Date().toISOString(),
			input.conversationId,
		);
		this.#announceConversation(
			this.#events.append(input.conversationId, {
				type: "conversation.updated",
				conversationId: input.conversationId,
				title,
			}),
		);
	}

	/**
	 * Archive a conversation, or put it back. An archived conversation keeps
	 * everything; it only leaves the list. Every open chat hears it.
	 */
	archiveConversation(
		scope: WorkspaceScope,
		input: { conversationId: string; archived: boolean },
	): void {
		this.bindScope(scope);
		const row = this.#conversationRow(input.conversationId);
		if (input.archived === (row.archived_at !== null)) return;
		const now = new Date().toISOString();
		const archivedAt = input.archived ? now : null;
		this.#store.run(
			"UPDATE conversations SET archived_at = ?, updated_at = ? WHERE id = ?",
			archivedAt,
			now,
			input.conversationId,
		);
		this.#announceConversation(
			this.#events.append(input.conversationId, {
				type: "conversation.updated",
				conversationId: input.conversationId,
				archivedAt,
			}),
		);
	}

	/**
	 * Delete a conversation with its messages, replies and waiting changes.
	 * This cannot be undone. Files the conversation saved stay in the
	 * workspace. A conversation that is still working is refused, so no reply
	 * writes into a conversation that is gone.
	 */
	deleteConversation(scope: WorkspaceScope, conversationId: string): void {
		this.bindScope(scope);
		this.#conversationRow(conversationId);
		if (this.#runningTurnIn(conversationId))
			throw new Error("Stop the reply before you delete this conversation");
		this.ctx.storage.transactionSync(() => {
			// The web grants table exists only once a turn has used the web.
			this.#store.run(WEB_SCHEMA);
			for (const approval of this.#store.exec<{ approval_id: string }>(
				"SELECT approval_id FROM approvals WHERE conversation_id = ?",
				conversationId,
			))
				this.#store.delete(`approval-result:${approval.approval_id}`);
			// A conversation moved in from before the workspace kept its own chat.
			for (const moved of this.#store.exec<{ id: string }>(
				"SELECT id FROM kernel_runtime_events WHERE conversation_id = ?",
				conversationId,
			))
				this.#store.delete(`moved-chat-event:${moved.id}`);
			for (const table of [
				"approvals",
				"queued_messages",
				"messages",
				"events",
				"turns",
				"web_domain_grants",
				"kernel_tool_results",
				"kernel_runtime_events",
				"kernel_runtime_runs",
				"kernel_conversations",
			])
				this.#store.run(
					`DELETE FROM ${table} WHERE conversation_id = ?`,
					conversationId,
				);
			this.#store.run("DELETE FROM conversations WHERE id = ?", conversationId);
			this.#store.delete(`decision-notes:${conversationId}`);
			this.#store.delete(`compaction:${conversationId}`);
		});
		workspaceLog.info("Workspace conversation deleted", {
			event: "workspace.conversation_deleted",
			...this.#diagnostics(),
		});
		const usage = sumUsageTotals(this.#events.usageByConversation().values());
		const frame = JSON.stringify({
			type: "conversation.deleted",
			conversationId,
			cursor: this.#events.latestSeq(),
			...(usage ? { usage } : {}),
		} satisfies WireControlFrame);
		// After the events already on their way, so no chat sees the
		// conversation come back.
		this.#pushSerial = this.#pushSerial.then(async () => {
			for (const ws of this.ctx.getWebSockets()) {
				if (
					!(await workspaceSessionAllowed(
						this.env.DB,
						ws.deserializeAttachment(),
					))
				)
					continue;
				try {
					ws.send(frame);
				} catch {
					/* a closed socket is dropped by the runtime */
				}
			}
		});
		this.ctx.waitUntil(this.#pushSerial);
	}

	/**
	 * Record one decision and, on approve, run the held call.
	 *
	 * Take the request before awaiting anything. Other decisions wait for the
	 * first caller, including while the API authorizes an account read decision.
	 */
	async #settleApproval(
		scope: WorkspaceScope,
		approval: ApprovalRow,
		input: {
			decision: "approve" | "deny";
			by: string;
			note?: string;
			/** A file write that applies at once, not a decision made by hand. */
			automatic?: boolean;
		},
	): Promise<{
		applied: boolean;
		summary: string;
		refusal?: string;
		outcome?: { ok: true; value: unknown } | { ok: false; error: string };
	} | null> {
		const approvalId = approval.approval_id;
		while (this.#deciding.has(approvalId)) await this.#deciding.get(approvalId);
		const [current] = this.#store.exec<{ status: ApprovalRow["status"] }>(
			"SELECT status FROM approvals WHERE approval_id = ?",
			approvalId,
		);
		if (current?.status !== "pending") return null;
		const now = new Date().toISOString();
		const state = input.decision === "approve" ? "approved" : "denied";
		let landed = () => {};
		this.#deciding.set(
			approvalId,
			new Promise<void>((resolve) => {
				landed = resolve;
			}),
		);
		try {
			if (approval.binding === "accounts" && approval.method === "read") {
				const decision =
					await this.accountService().decideLinkedAccountApproval({
						...scope,
						conversationId: approval.conversation_id,
						approvalRequestId: approvalId,
						by: input.by,
						decision: input.decision,
					});
				if (decision.status === "refused")
					return { applied: false, summary: "", refusal: decision.message };
			}
			return await this.#applyDecision(scope, approval, input, state, now);
		} finally {
			this.#deciding.delete(approvalId);
			landed();
		}
	}

	async #applyDecision(
		scope: WorkspaceScope,
		approval: ApprovalRow,
		input: {
			decision: "approve" | "deny";
			by: string;
			note?: string;
			automatic?: boolean;
		},
		state: "approved" | "denied",
		now: string,
	): Promise<{
		applied: boolean;
		summary: string;
		outcome?: { ok: true; value: unknown } | { ok: false; error: string };
	}> {
		const approvalId = approval.approval_id;
		if (approval.binding !== "accounts")
			this.#compliance.recordApproval(approvalId, state, input.by, {
				resource: approval.resource,
				operation: approval.method,
				argsHash: approval.args_hash,
			});
		this.#store.run(
			"UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE approval_id = ?",
			state,
			input.by,
			now,
			approvalId,
		);
		this.#events.append(approval.conversation_id, {
			type: "approval.decided",
			approvalId,
			decision: input.decision,
			by: input.by,
			at: now,
			...(input.automatic ? { automatic: true as const } : {}),
		});
		let summary: string;
		let applied = false;
		let result:
			| { ok: true; value: unknown }
			| { ok: false; error: string }
			| undefined;
		if (input.decision === "approve") {
			const outcome = await this.#invokeBinding(
				scope,
				{
					turnId: approval.turn_id,
					conversationId: approval.conversation_id,
					actor:
						approval.binding === "memory" && approval.method === "review"
							? { id: input.by, kind: "user" }
							: { id: approval.actor_id, kind: approval.actor_kind },
				},
				approval.binding,
				approval.method,
				JSON.parse(approval.args) as unknown[],
				approval.binding === "accounts" ? approvalId : undefined,
			).catch((error: unknown) => ({
				ok: false as const,
				error: error instanceof Error ? error.message : String(error),
			}));
			applied = outcome.ok;
			result = outcome;
			const status = applied ? "applied" : "failed";
			this.#store.run(
				"UPDATE approvals SET status = ? WHERE approval_id = ?",
				status,
				approvalId,
			);
			const createsApp =
				approval.binding === "apps" && approval.method === "create";
			const accountRead = approval.binding === "accounts";
			const output =
				outcome.ok && !createsApp && !accountRead
					? changedOutput(outcome.value)
					: null;
			const app = outcome.ok && createsApp ? createdApp(outcome.value) : null;
			this.#events.append(approval.conversation_id, {
				type: "approval.executed",
				approvalId,
				status,
				...(!outcome.ok ? { error: outcome.error } : {}),
				...(output ? { output } : {}),
				...(app ? { app } : {}),
			});
			const resultText = outcome.ok ? JSON.stringify(outcome.value) : "";
			summary = outcome.ok
				? accountRead
					? `The approved connected account read returned:\n${wrapUntrustedInput(resultText, "connected_account")}`
					: `Approved by ${input.by}; ${approval.binding}.${approval.method} applied: ${resultText.slice(0, 2_000)}`
				: `Approved by ${input.by} but ${approval.binding}.${approval.method} failed: ${outcome.error}`;
		} else {
			summary = `Denied by ${input.by}${input.note ? `: ${input.note}` : ""}. Do not retry this action.`;
		}
		this.#store.put(`approval-result:${approvalId}`, { applied });
		return { applied, summary, ...(result ? { outcome: result } : {}) };
	}

	/**
	 * Called by the sandbox loopback: run one method of one wrapped binding
	 * for a turn that is running, on behalf of the code run that turn is
	 * waiting for. Code that timed out, failed or finished may still be
	 * executing; its calls are refused here, so it changes nothing after the
	 * model was told how it ended. A held write is stored as a pending approval
	 * and comes back as "Approval required: …"; the model goes on with other
	 * work. The agent's own create or edit of a workspace file is not held:
	 * it is applied here and the call returns its result.
	 */
	async callBinding(
		scope: WorkspaceScope,
		input: {
			turnId: string;
			runId: string;
			binding: string;
			method: string;
			args: unknown[];
		},
	): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
		this.bindScope(scope);
		const turn = this.#turn(input.turnId);
		if (!turn || turn.status !== "running")
			return { ok: false, error: "This turn is no longer running" };
		if (this.#codeRuns.get(input.turnId) !== input.runId)
			return { ok: false, error: ENDED_CODE_RUN_ERROR };
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

	/** Facet callback: messages a turn running elsewhere has finished. */
	saveTurnProgress(
		scope: WorkspaceScope,
		turnId: string,
		progress: TurnProgress,
	): void {
		this.bindScope(scope);
		const turn = this.#turn(turnId);
		if (!turn || turn.status !== "running") return;
		this.#saveProgress(turn.conversation_id, turnId, progress);
	}

	/**
	 * A turn is about to run code: from now on only this run's calls are
	 * accepted for the turn. A turn runs one piece of code at a time.
	 */
	startCodeRun(scope: WorkspaceScope, turnId: string, runId: string): void {
		this.bindScope(scope);
		if (this.#turn(turnId)?.status === "running")
			this.#codeRuns.set(turnId, runId);
	}

	/** The turn stopped waiting for this run: its later calls are refused. */
	endCodeRun(scope: WorkspaceScope, turnId: string, runId: string): void {
		this.bindScope(scope);
		if (this.#codeRuns.get(turnId) === runId) this.#codeRuns.delete(turnId);
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
			const session: WorkspaceSession = {
				scope,
				actorId: request.headers.get("X-Workspace-Actor-Id") ?? "",
				actorKind: "user",
				scopes: null,
			};
			if (!(await workspaceSessionAllowed(this.env.DB, session)))
				return new Response("Workspace access denied", { status: 403 });
			await this.refreshModelCatalog();
			if (request.headers.get("Upgrade") !== "websocket")
				return new Response("Expected WebSocket", { status: 426 });
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];
			this.ctx.acceptWebSocket(server);
			// Keep the verified principal, never its credentials or a cached role.
			server.serializeAttachment({ ...session, conversationId: null });
			const cursor = Number(url.searchParams.get("after") ?? "");
			if (Number.isFinite(cursor) && url.searchParams.has("after")) {
				try {
					await this.#subscribe(
						server,
						scope,
						url.searchParams.get("conversation"),
						cursor,
					);
				} catch (error) {
					// The socket is accepted: say what failed instead of dropping it.
					workspaceLog.warn("Workspace chat frame failed", {
						event: "workspace.frame_failed",
						frameType: "subscribe",
						where: "upgrade",
						error,
						...this.#diagnostics(),
					});
					this.#control(server, {
						type: "error",
						code: "replay_failed",
						message:
							"This chat's history could not be loaded. Reload the page; if it keeps happening, tell your workspace owner.",
					});
				}
			}
			return new Response(null, { status: 101, webSocket: client });
		}
		if (url.pathname.endsWith("/mcp") && request.method === "POST") {
			const actorId =
				request.headers.get("X-Workspace-Actor-Id") ?? "anonymous";
			const actorKind = (request.headers.get("X-Workspace-Actor-Kind") ??
				"external_agent") as ActorKind;
			const session: WorkspaceSession = {
				scope,
				actorId,
				actorKind,
				scopes: (request.headers.get("X-Workspace-Scopes") ?? "")
					.split(/\s+/)
					.filter(Boolean),
			};
			const body = await request.json().catch(() => null);
			const authorize = async (write = false) => {
				if (!(await workspaceSessionAllowed(this.env.DB, session, write)))
					throw new Error("Workspace access denied");
			};
			if (!(await workspaceSessionAllowed(this.env.DB, session)))
				return new Response("Workspace access denied", { status: 403 });
			const reply = await handleMcpRequest(
				{
					sendTurn: async (input) => {
						await authorize(true);
						await assertWorkspaceGuestTedi(this.env.DB, session, input.tediId);
						return this.sendTurn(scope, input);
					},
					awaitTurn: async (turnId, timeoutMs) => {
						await authorize();
						const result = await this.awaitTurn(scope, turnId, timeoutMs);
						await authorize();
						return result;
					},
					readChangeRecords: async (query) => {
						await authorize();
						return this.readChangeRecords(scope, query);
					},
					readEvents: async (input) => {
						await authorize();
						return this.readEvents(scope, input);
					},
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
		const attachment = ws.deserializeAttachment() as WorkspaceSession & {
			conversationId: string | null;
		};
		if (
			!(await workspaceSessionAllowed(
				this.env.DB,
				attachment,
				frame?.type !== "subscribe" &&
					frame?.type !== "read_ledger" &&
					frame?.type !== "ping",
			))
		) {
			this.#control(ws, {
				type: "error",
				code: "access_denied",
				message: "Workspace access denied",
			});
			this.#closeDenied(ws, "frame");
			return;
		}
		const { scope } = attachment;
		const frameType = FRAME_TYPES.has(String(frame?.type))
			? String(frame?.type)
			: "unknown";
		// Written before the work, so a reset names the frame it was handling.
		if (frameType !== "ping")
			workspaceLog.info("Workspace chat frame received", {
				event: "workspace.frame",
				frameType,
				...this.#diagnostics(),
			});
		try {
			switch (frame?.type) {
				case "subscribe":
					await this.refreshModelCatalog();
					await this.#subscribe(
						ws,
						scope,
						frame.conversationId,
						frame.cursor ?? null,
					);
					return;
				case "send_turn": {
					await assertWorkspaceGuestTedi(this.env.DB, attachment, frame.tediId);
					const started = await this.sendTurn(scope, {
						turnId: frame.clientTurnId,
						conversationId: frame.conversationId,
						actorId: attachment.actorId,
						actorKind: "user",
						text: frame.text,
						modelId: frame.modelId,
						attachments: frame.attachments,
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
				case "decide_approvals": {
					const approvalIds =
						frame.type === "decide_approval"
							? [frame.approvalId]
							: frame.approvalIds;
					const results = await this.decideApprovals(scope, {
						approvalIds,
						decision: frame.decision,
						by: attachment.actorId,
						...(frame.type === "decide_approval" && frame.note
							? { note: frame.note }
							: {}),
					});
					// Tell the person who decided how far it got: what their own
					// decision changed, and where and why it stopped.
					const at = results.findIndex((result) => result.stopped);
					const stop = results[at]?.stopped;
					this.#control(ws, {
						type: "approvals.decided",
						...(frame.runId ? { runId: frame.runId } : {}),
						decision: frame.decision,
						total: results.length,
						done: results.filter(
							(result) =>
								!result.alreadyDecided && !result.left && !result.stopped,
						).length,
						alreadyDecided: results.filter((result) => result.alreadyDecided)
							.length,
						...(stop
							? { stopped: { approvalId: approvalIds[at]!, ...stop } }
							: {}),
					});
					return;
				}
				case "cancel_turn":
					await this.cancelTurn(scope, frame.turnId);
					return;
				case "rename_conversation":
					this.renameConversation(scope, {
						conversationId: frame.conversationId,
						title: frame.title,
					});
					return;
				case "archive_conversation":
					this.archiveConversation(scope, {
						conversationId: frame.conversationId,
						archived: frame.archived === true,
					});
					return;
				case "delete_conversation":
					this.deleteConversation(scope, frame.conversationId);
					return;
				case "read_ledger": {
					this.bindScope(scope);
					const page = this.#events.historyPage(
						frame.conversationId,
						frame.before,
						frame.limit ?? 500,
					);
					this.#control(ws, {
						type: "ledger.page",
						conversationId: frame.conversationId,
						events: page.events.map((event) => this.#withTurnAuthors(event)),
						hasMore: page.more,
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
			workspaceLog.warn("Workspace chat frame failed", {
				event: "workspace.frame_failed",
				frameType,
				error,
				...this.#diagnostics(),
			});
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

	override async webSocketClose(
		ws: WebSocket,
		code: number,
		_reason: string,
		wasClean: boolean,
	) {
		workspaceLog.info("Workspace chat socket closed", {
			event: "workspace.socket_closed",
			closeCode: code,
			wasClean,
			...this.#diagnostics(),
		});
		ws.close();
	}

	override async webSocketError(_ws: WebSocket, error: unknown) {
		workspaceLog.warn("Workspace chat socket failed", {
			event: "workspace.socket_error",
			error,
			...this.#diagnostics(),
		});
	}

	override async alarm(alarmInfo?: AlarmInvocationInfo) {
		try {
			await this.#runAlarm();
		} catch (error) {
			workspaceLog.error("Workspace alarm failed; the runtime retries it", {
				event: "workspace.alarm_failed",
				error,
				retryCount: alarmInfo?.retryCount ?? 0,
				...this.#diagnostics(),
			});
			throw error;
		}
	}

	async #runAlarm() {
		for (const turn of this.#store.exec<TurnRow>(
			"SELECT * FROM turns WHERE status = 'running'",
		)) {
			const [last] = this.#store.exec<{ at: string | null }>(
				"SELECT max(at) AS at FROM events WHERE turn_id = ?",
				turn.turn_id,
			);
			const reason = !this.#running.has(turn.turn_id)
				? "no_executor"
				: Date.now() - Date.parse(last?.at ?? turn.started_at) >=
					  TURN_IDLE_TIMEOUT_MS
					? "idle"
					: null;
			if (!reason) continue;
			workspaceLog.warn("Workspace alarm stopped a turn", {
				event: "workspace.turn_stopped",
				reason,
				...this.#diagnostics(),
			});
			this.#stopTurn(
				turn,
				reason === "idle"
					? "Stopped: no progress for 15 minutes."
					: "Stopped: no live executor for this turn.",
				"failed",
			);
		}
		// A turn that failed or was cut off left its unread messages behind.
		const scope = this.#store.get<WorkspaceScope>("activity-scope");
		if (scope)
			for (const row of this.#store.exec<{ conversation_id: string }>(
				"SELECT DISTINCT conversation_id FROM queued_messages WHERE status = 'queued'",
			))
				await this.#startQueuedMessage(scope, row.conversation_id);
		for (const [outputId, pending] of Object.entries(this.#outputTransfers())) {
			try {
				await this.#runOutputTransfer(outputId, pending);
			} catch (error) {
				console.error("Workspace output transfer pending", error);
			}
		}
		await this.#serializePublish(() => this.#flushOutputProjections());
		await this.#flushActivity();
		if (
			this.#running.size > 0 ||
			Object.keys(this.#outputTransfers()).length > 0 ||
			Object.keys(this.#pendingOutputProjections()).length > 0 ||
			(
				await this.#ledger.list({
					afterSequence: this.#store.get<number>("activity-sequence") ?? 0,
					limit: 1,
				})
			).length > 0 ||
			this.#activityRecords.list({
				afterSequence: this.#store.get<number>("event-activity-sequence") ?? 0,
				limit: 1,
			}).length > 0 ||
			this.#usageUnpublished()
		) {
			await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
			return;
		}
		this.#events.trim();
	}

	// ------------------------------------------------------------- internals

	#serializeActivity<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.#activitySerial.then(operation);
		this.#activitySerial = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	#flushActivity(): Promise<void> {
		return this.#serializeActivity(async () => {
			const scope = this.#store.get<WorkspaceScope>("activity-scope");
			if (!scope) return;
			const records = await this.#ledger.list({
				afterSequence: this.#store.get<number>("activity-sequence") ?? 0,
				limit: 100,
			});
			for (const record of records) {
				await this.projectAction(scope, record);
				this.#store.put("activity-sequence", record.sequence);
			}
			for (const record of this.#activityRecords.list({
				afterSequence: this.#store.get<number>("event-activity-sequence") ?? 0,
			})) {
				await this.projectEvent(record.event);
				this.#store.put("event-activity-sequence", record.sequence);
			}
			await this.#publishUsage(scope);
		}).catch((error) => {
			console.error("Workspace activity queued for retry", error);
		});
	}

	/** Chat counts for the core's workspace summary, in the core's run vocabulary. */
	#usage(): WorkspaceUsage {
		const open =
			"FROM turns t JOIN conversations c ON c.id = t.conversation_id WHERE c.archived_at IS NULL";
		const [conversations] = this.#store.exec<{ total: number }>(
			"SELECT COUNT(*) AS total FROM conversations WHERE archived_at IS NULL",
		);
		// One message per posted turn and one per finished answer.
		const [turns] = this.#store.exec<{
			total: number;
			answered: number | null;
			active: number | null;
		}>(
			`SELECT COUNT(*) AS total, SUM(t.status = 'finished') AS answered, SUM(t.status IN ('running', 'waiting')) AS active ${open}`,
		);
		const [latest] = this.#store.exec<{
			turn_id: string;
			status: TurnStatus;
			updated_at: string;
		}>(
			`SELECT t.turn_id, t.status, coalesce(t.finished_at, t.started_at) AS updated_at ${open} ORDER BY updated_at DESC, t.turn_id DESC LIMIT 1`,
		);
		const total = turns?.total ?? 0;
		return {
			usage: {
				conversationCount: conversations?.total ?? 0,
				messageCount: total + (turns?.answered ?? 0),
				runCount: total,
			},
			runStatus: {
				activeRunCount: turns?.active ?? 0,
				latestRun: latest
					? {
							id: latest.turn_id,
							status: CORE_RUN_STATUS[latest.status],
							updatedAt: latest.updated_at,
						}
					: null,
			},
		};
	}

	/** True while the core's workspace summary lacks this object's current counts. */
	#usageUnpublished(): boolean {
		return (
			Boolean(this.#store.get<WorkspaceScope>("activity-scope")) &&
			this.#store.get<string>("published-usage") !==
				JSON.stringify(this.#usage())
		);
	}

	async #publishUsage(scope: WorkspaceScope): Promise<void> {
		const counts = this.#usage();
		const encoded = JSON.stringify(counts);
		if (this.#store.get<string>("published-usage") === encoded) return;
		await this.projectUsage(scope, counts);
		this.#store.put("published-usage", encoded);
	}

	protected async projectUsage(
		scope: WorkspaceScope,
		counts: WorkspaceUsage,
	): Promise<void> {
		await applyOsWorkspaceObjectUsage(createDbQueryClient(this.env.DB), {
			...scope,
			...counts,
			publishedAt: new Date().toISOString(),
		});
	}

	protected projectEvent(event: WorkspaceChangeInput): Promise<void> {
		return publishWorkspaceAction(createDbQueryClient(this.env.DB), event);
	}

	#recordConversationActivity(event: WireEvent): void {
		// Token deltas and model/usage receipts remain in the chat ledger only.
		if (["assistant.delta", "turn.model", "turn.usage"].includes(event.type))
			return;
		const scope = this.#store.get<WorkspaceScope>("activity-scope");
		if (!scope) return;
		const approval =
			"approvalId" in event
				? this.#store.exec<ApprovalRow>(
						"SELECT * FROM approvals WHERE approval_id = ?",
						event.approvalId,
					)[0]
				: undefined;
		const turn = event.turnId
			? this.#turn(event.turnId)
			: approval
				? this.#turn(approval.turn_id)
				: undefined;
		const sender =
			event.type === "message.queued"
				? this.#queuedMessage(event.messageId)
				: undefined;
		const actor =
			event.type === "approval.decided"
				? { kind: "user" as const, id: event.by }
				: event.type === "turn.started" && turn
					? { kind: turn.actor_kind, id: turn.actor_id }
					: event.type === "message.queued" && sender
						? { kind: sender.actor_kind, id: sender.actor_id }
						: turn?.tedi_id
							? { kind: "tedi" as const, id: turn.tedi_id }
							: { kind: "service" as const, id: "workspace_object" };
		this.#activityRecords.append({
			...scope,
			kind: "run",
			id: turn?.turn_id ?? event.conversationId,
			revision: 1,
			actor,
			changeRecordId: `workspace-event:${event.seq}`,
			at: event.at,
			summary: {
				// Lets an unread row open the conversation it belongs to.
				conversationId: event.conversationId,
				// What kind of change waits for a person, in fixed words; never
				// its title, arguments or content.
				...(event.type === "approval.requested" && !event.automatic && approval
					? {
							description: stepLabel(approval.binding, approval.method).label,
						}
					: {}),
				action: {
					resource: "conversation",
					// A change that applies at once is not waiting for anyone, so
					// it must not read as a request to the people here.
					operation:
						event.type === "approval.requested" && event.automatic
							? "approval.automatic"
							: event.type,
					outcome:
						(event.type === "turn.finished" && event.status !== "done") ||
						(event.type === "step.finished" && event.status === "error") ||
						(event.type === "approval.executed" && event.status === "failed")
							? "not_applied"
							: event.type === "approval.decided" && event.decision === "deny"
								? "denied"
								: "applied",
					surface: "workspace_object",
					...(turn ? { traceId: turn.turn_id } : {}),
				},
			},
		});
	}

	protected async projectAction(
		scope: WorkspaceScope,
		record: ChangeRecord,
	): Promise<void> {
		if (
			record.actor.organizationId !== scope.organizationId ||
			record.source.surface !== "workspace_object"
		) {
			throw new Error("Workspace action provenance mismatch");
		}
		const actor = WorkspaceChangeActorSchema.parse({
			kind:
				record.actor.kind === "agent" ? "external_agent" : record.actor.kind,
			id: record.actor.id,
		});
		const revisionId = (record.after ?? record.before)?.revisionId;
		await publishWorkspaceAction(createDbQueryClient(this.env.DB), {
			...scope,
			kind: "run",
			id: record.id,
			revision: 1,
			actor,
			changeRecordId: record.id,
			at: record.recordedAt,
			summary: {
				action: {
					resource: record.resource,
					operation: record.operation,
					outcome: record.outcome,
					surface: "workspace_object",
					...(record.source.traceId ? { traceId: record.source.traceId } : {}),
					...(revisionId ? { revisionId } : {}),
				},
			},
		});
	}

	#pendingOutputProjections() {
		return (
			this.#store.get<
				Record<string, { scope: WorkspaceScope; generation: string }>
			>("pending-output-projections") ?? {}
		);
	}

	#serializePublish(operation: () => Promise<void>): Promise<void> {
		const next = this.#publishSerial.then(operation);
		this.#publishSerial = next.then(
			() => {},
			() => {},
		);
		return next;
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
		const written = this.#serializeOutput(async () => {
			if (this.#outputMoving(outputId))
				throw new Error("Output transfer in progress or output moved");
			this.#store.put("activity-scope", scope);
			// Persist the retry before the write; the alarm publishes what is left.
			await this.#markOutputPending(scope, outputId);
			return write();
		});
		// Publishing waits for this write, whatever its outcome, but no later
		// write waits for publishing: a slow feed cannot hold the queue.
		const published = this.#publishOutput(
			outputId,
			written.then(
				() => {},
				() => {},
			),
		);
		const value = await written;
		await published;
		return value;
	}

	#outputMoving(outputId: string) {
		return Boolean(
			this.#outputTransfers()[outputId] ||
			this.#store.get(`document-transfer-owner:${outputId}`) ||
			this.#store.get(`incoming-output:${outputId}`) ||
			this.#store.get(`transferred-output:${outputId}`),
		);
	}

	async #markOutputPending(scope: WorkspaceScope, outputId: string) {
		this.#store.delete(`output-history-before:${outputId}`);
		this.#store.put("pending-output-projections", {
			...this.#pendingOutputProjections(),
			[outputId]: { scope, generation: crypto.randomUUID() },
		});
		await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
	}

	/**
	 * Publish one file to the workspace feed after `after`, waiting at most
	 * PROJECTION_WAIT_MS. Other pending files are left to the alarm, so one
	 * slow file no longer rides along on every save of another.
	 */
	#publishOutput(outputId: string, after: Promise<void>): Promise<void> {
		const run = after
			.then(() =>
				this.#serializePublish(() => this.#flushOutputProjections([outputId])),
			)
			.then(() => this.#flushActivity())
			.catch((error) =>
				console.error("Workspace output projection queued for retry", error),
			);
		return Promise.race([
			run,
			new Promise<void>((resolve) => setTimeout(resolve, PROJECTION_WAIT_MS)),
		]);
	}

	/** Bounded repair from durable source records, independent of the delivery checkpoint. */
	async replayActivity(scope: WorkspaceScope, input: ActivityPageInput = {}) {
		this.bindScope(scope);
		return this.#serializeActivity(async () => {
			// A replay also rebuilds the core's chat counts for this workspace.
			this.#store.delete("published-usage");
			await this.#publishUsage(scope);
			if (input.source === "events") {
				const records = this.#activityRecords.list(input);
				for (const record of records) await this.projectEvent(record.event);
				return {
					published: records.length,
					lastSequence: records.at(-1)?.sequence ?? input.afterSequence ?? 0,
				};
			}
			const records = await this.#ledger.list(input);
			for (const record of records) await this.projectAction(scope, record);
			return {
				published: records.length,
				lastSequence: records.at(-1)?.sequence ?? input.afterSequence ?? 0,
			};
		});
	}

	async reconcileActivity(
		scope: WorkspaceScope,
		input: ActivityPageInput = {},
	) {
		this.bindScope(scope);
		const records =
			input.source === "events"
				? this.#activityRecords.list(input).map((record) => ({
						sequence: record.sequence,
						id: record.event.changeRecordId,
					}))
				: await this.#ledger.list(input);
		const missing: string[] = [];
		for (const record of records) {
			if (
				!(await hasWorkspaceActionProjection(createDbQueryClient(this.env.DB), {
					...scope,
					changeRecordId: record.id,
				}))
			)
				missing.push(record.id);
		}
		return {
			checked: records.length,
			missing,
			lastSequence: records.at(-1)?.sequence ?? input.afterSequence ?? 0,
			coverage:
				input.source === "events"
					? ("recorded_workspace_events" as const)
					: ("recorded_binding_actions" as const),
		};
	}

	async refreshOutputProjection(
		scope: WorkspaceScope,
		outputId: string,
	): Promise<void> {
		this.bindScope(scope);
		if (this.#outputMoving(outputId))
			throw new Error("Output transfer in progress or output moved");
		this.#store.put("activity-scope", scope);
		this.#store.delete(`output-history-through:${outputId}`);
		await this.#markOutputPending(scope, outputId);
		await this.#publishOutput(outputId, Promise.resolve());
	}

	/** Publish pending files, all of them or only `only`; failures stay pending. */
	async #flushOutputProjections(only?: readonly string[]) {
		for (const [outputId, pending] of Object.entries(
			this.#pendingOutputProjections(),
		)) {
			if (only && !only.includes(outputId)) continue;
			if (
				this.#outputTransfers()[outputId] ||
				this.#store.get(`document-transfer-owner:${outputId}`) ||
				this.#store.get(`transferred-output:${outputId}`)
			)
				continue;
			try {
				const complete = await this.projectOutput(pending.scope, outputId);
				if (complete === false) continue;
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
		if ((await this.outputQuery(scope, { op: "authority" })) === "shared")
			return;
		const row = await executeOutputQuery(this.db as TenantStoreDb, scope, {
			op: "get",
			outputId,
		});
		if (!row) {
			await retireWorkspaceOutputIndex(core, {
				organizationId: scope.organizationId,
				outputId,
			});
			return;
		}
		if (row.workspaceId !== scope.workspaceId || !row.currentRevisionId) return;
		const revision = await executeOutputQuery(this.db as TenantStoreDb, scope, {
			op: "revision",
			revisionId: row.currentRevisionId,
		});
		const publish = async (
			saved: Omit<NonNullable<typeof revision>, "content">,
			historical = false,
		) => {
			const [previous] = await executeOutputQuery(
				this.db as TenantStoreDb,
				scope,
				{
					op: "history",
					outputId,
					options: { limit: 1, beforeRevision: saved.revision },
				},
			);
			const excerptKey = `output-excerpt:${saved.id}`;
			await publishOutputProjection(core, row, saved, {
				historical,
				continuesBurst: continuesOutputAutosaveBurst(previous, saved),
				excerpt: this.#store.get<string>(excerptKey),
			});
			this.#store.delete(excerptKey);
		};
		if (revision) await publish(revision);
		const throughKey = `output-history-through:${outputId}`;
		const through = this.#store.get<number>(throughKey);
		// Advance only from a completely recovered history. An index entry for
		// the previous revision alone cannot prove older coalesced saves arrived.
		if (revision && through != null && through >= revision.revision - 1) {
			this.#store.put(throughKey, revision.revision);
			return true;
		}
		// Immutable revisions recover every file save even when notifications coalesced.
		const beforeRevision = this.#store.get<number>(
			`output-history-before:${outputId}`,
		);
		const options = {
			limit: 10,
			...(beforeRevision ? { beforeRevision } : {}),
		};
		const history = await executeOutputQuery(this.db as TenantStoreDb, scope, {
			op: "history",
			outputId,
			options,
		});
		for (const saved of [...history].reverse()) await publish(saved, true);
		if (history.length === options.limit) {
			this.#store.put(
				`output-history-before:${outputId}`,
				history.at(-1)!.revision,
			);
			return false;
		}
		this.#store.delete(`output-history-before:${outputId}`);
		if (revision) this.#store.put(throughKey, revision.revision);
		return true;
	}

	/**
	 * Answer a subscribe with one bounded page of the ledger. A socket with a
	 * cursor gets the events after it, oldest first, and `replay.more` while
	 * events remain; it asks again from that cursor. A socket without a cursor
	 * has folded nothing: it gets the newest page of its conversation and pages
	 * backwards with `read_ledger`, and one that follows no conversation needs
	 * no replay at all.
	 */
	async #subscribe(
		ws: WebSocket,
		scope: WorkspaceScope,
		conversationId: string | null,
		cursor: number | null,
	) {
		if (
			!(await workspaceSessionAllowed(this.env.DB, ws.deserializeAttachment()))
		) {
			this.#closeDenied(ws, "subscribe");
			return;
		}
		this.bindScope(scope);
		const current = ws.deserializeAttachment() as Record<string, unknown>;
		ws.serializeAttachment({ ...current, scope, conversationId });
		const latest = this.#events.latestSeq();
		const usage = this.#events.usageByConversation();
		const workspaceUsage = sumUsageTotals(usage.values());
		this.#control(ws, {
			type: "hello",
			cursor: latest,
			serverTime: new Date().toISOString(),
			conversations: this.#listConversations(usage),
			archived: this.#listConversations(usage, true),
			waiting: this.#waitingApprovals(),
			models: this.configuredModels(),
			...(workspaceUsage ? { usage: workspaceUsage } : {}),
		});
		const page =
			cursor !== null
				? this.#events.replayPage(cursor, conversationId)
				: conversationId
					? this.#events.historyPage(conversationId, null, 1_000)
					: { events: [], more: false };
		let replayEvents = 0;
		let replayBytes = 0;
		for (const event of page.events) {
			const frame = JSON.stringify(this.#withTurnAuthors(event));
			replayEvents += 1;
			replayBytes += frame.length;
			ws.send(frame);
		}
		const last = page.events.at(-1)?.seq;
		if (cursor !== null && page.more && last !== undefined) {
			this.#control(ws, { type: "replay.more", cursor: last, conversationId });
		} else {
			if (cursor === null && page.more && conversationId)
				this.#control(ws, {
					type: "ledger.page",
					conversationId,
					events: [],
					hasMore: true,
				});
			this.#control(ws, { type: "caught_up", cursor: latest, conversationId });
		}
		workspaceLog.info("Workspace chat socket subscribed", {
			event: "workspace.subscribed",
			cursor: cursor ?? undefined,
			latestSeq: latest,
			replayEvents,
			replayBytes,
			replayMore: page.more,
			...this.#diagnostics(),
		});
	}

	#control(ws: WebSocket, frame: WireControlFrame) {
		try {
			ws.send(JSON.stringify(frame));
		} catch {
			/* a closed socket is dropped by the runtime */
		}
	}

	async #push(event: WireEvent) {
		const frame = JSON.stringify(event);
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment() as
				| (WorkspaceSession & { conversationId?: string | null })
				| null;
			if (!(await workspaceSessionAllowed(this.env.DB, attachment))) {
				this.#closeDenied(ws, "push");
				continue;
			}
			// A request that waits for a person, and its decision, reach every
			// open chat: the workspace owes the answer, whichever chat asked.
			if (
				attachment?.conversationId &&
				attachment.conversationId !== event.conversationId &&
				!(
					(event.type === "approval.requested" ||
						event.type === "approval.decided") &&
					!event.automatic
				)
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

	#dataPort(
		scope: WorkspaceScope,
		actorKind: ActorKind,
		turn?: { conversationId: string; turnId: string },
	) {
		// The person who started the turn, also when a guest tedi answers it.
		const started = turn ? this.#turn(turn.turnId) : undefined;
		return new TenantDataPort({
			...scope,
			tenant: this.db as TenantStoreDb,
			core: createDbQueryClient(this.env.DB),
			bucket: this.env.R2_BUCKET,
			actorKind,
			actingUserId: started?.actor_kind === "user" ? started.actor_id : null,
			conversationId: turn?.conversationId,
			agentTurnId: turn?.turnId,
			validateAppSource: (files, date) =>
				validateWorkspaceAppSource(this.env.LOADER, files, date),
			assertWorkspaceAuthority: async () => {
				if (!(await this.#claimOutputs(scope)))
					throw new Error("Workspace output activation is required");
			},
			commitOutput: (outputId, write) =>
				this.#commitOutput(scope, outputId, write),
			// Saves through the API notify there; the agent's saves land here.
			notifyOutputRevision: (notice) =>
				notifyOutputRevision(
					{
						db: createDbQueryClient(this.env.DB),
						rooms: this.env.COLLAB_ROOM,
						env: this.env,
						development: this.env.ENVIRONMENT === "development",
					},
					scope,
					notice,
				),
		});
	}

	#bindings(
		scope: WorkspaceScope,
		turn: {
			turnId: string;
			conversationId: string;
			actor: { id: string; kind: ActorKind };
		},
		approvalRequestId?: string,
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
		const data = this.#dataPort(scope, turn.actor.kind, turn);
		const started = this.#turn(turn.turnId);
		const accountActor: Actor | undefined =
			started?.actor_kind === "user"
				? {
						id: started.actor_id,
						kind: "user",
						organizationId: scope.organizationId,
					}
				: undefined;
		// One id per source and turn, so a repeated ask shows one card.
		const requestConnection = (request: ConnectionRequest) =>
			void this.#events.append(turn.conversationId, {
				type: "connection.requested",
				turnId: turn.turnId,
				requestId: `${turn.turnId}:${request.resourceId}`,
				...request,
			});
		return buildWorkspaceBindings({
			memory: this.#memory,
			data,
			runs: data,
			accountActor,
			accounts:
				accountActor &&
				workspaceAccounts({
					scope,
					conversationId: turn.conversationId,
					userId: accountActor.id,
					data,
					api: this.accountService(),
					requestConnection,
					approvalRequestId,
				}),
			compliance: this.#compliance,
			accountability: {
				append: async (input) => {
					this.#store.put("activity-scope", scope);
					const record = await this.#ledger.append(input);
					await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
					await this.#flushActivity();
					return record;
				},
				list: (query) => this.#ledger.list(query),
				get: (id) => this.#ledger.get(id),
				export: () => this.#ledger.export(),
			},
			actor,
			source,
			web: createWebPort(this.#store, turn.conversationId, this.webFetch()),
			showView: (view) => {
				const shown = this.#viewsShown.get(turn.turnId) ?? 0;
				if (shown >= MAX_VIEWS_PER_TURN)
					throw new Error(`At most ${MAX_VIEWS_PER_TURN} views per answer`);
				this.#viewsShown.set(turn.turnId, shown + 1);
				this.#events.append(turn.conversationId, {
					type: "view.shown",
					turnId: turn.turnId,
					...view,
				});
			},
			requestConnection,
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
		approvalRequestId?: string,
	): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
		if (!(BINDING_NAMES as readonly string[]).includes(binding))
			return { ok: false, error: `Unknown binding ${binding}` };
		const target = this.#bindings(scope, turn, approvalRequestId)[
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
			...(args[0] === undefined ? {} : { input: boundedEventInput(args[0]) }),
		});
		try {
			// Refused here, before any check or card, so the model can correct
			// the text and nothing waits for a decision that could not apply.
			const unsavable = unsavableTextError(args);
			if (unsavable) throw new Error(unsavable);
			const value = await (fn as (...a: unknown[]) => Promise<unknown>)(
				...args,
			);
			const json = value === undefined ? "null" : JSON.stringify(value);
			const startedRun = binding === "work" && method === "startRun";
			this.#events.append(turn.conversationId, {
				type: "step.finished",
				turnId: turn.turnId,
				stepId,
				status: "ok",
				durationMs: Date.now() - started,
				...(value === undefined
					? {}
					: {
							result: startedRun
								? json
								: boundedEventText(json, EVENT_INPUT_CHARS),
						}),
				...(startedRun ? { tool: "work.startRun" } : {}),
			});
			return { ok: true, value: JSON.parse(json) };
		} catch (error: unknown) {
			let message = callFailureText(error);
			if (error instanceof AccountReadHeld) {
				const requestArgs = args.slice(0, 3);
				const [inserted] = this.#store.exec<{ approval_id: string }>(
					"INSERT OR IGNORE INTO approvals (approval_id, turn_id, conversation_id, step_id, binding, method, args, resource, args_hash, actor_id, actor_kind, tedi_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING approval_id",
					error.approvalId,
					turn.turnId,
					turn.conversationId,
					stepId,
					binding,
					method,
					JSON.stringify(requestArgs),
					"connected_account",
					await hashArguments(requestArgs),
					turn.actor.id,
					turn.actor.kind,
					turn.tediId ?? null,
				);
				if (inserted)
					this.#events.append(turn.conversationId, {
						type: "approval.requested",
						turnId: turn.turnId,
						stepId,
						approvalId: error.approvalId,
						title: label,
						reason:
							"An active organization owner or admin with workspace build access must decide this read.",
						input: boundedEventInput({
							resourceId: args[0],
							toolName: args[1],
						}),
					});
			}
			if (
				error instanceof CallRefusedError &&
				error.decision.verdict === "needs_approval"
			) {
				const finishStep = (outcome: { ok: boolean; error?: string }) =>
					this.#events.append(turn.conversationId, {
						type: "step.finished",
						turnId: turn.turnId,
						stepId,
						status: outcome.ok ? "ok" : "error",
						durationMs: Date.now() - started,
						...(outcome.error ? { error: outcome.error } : {}),
					});
				// The same change asked for again gets no second card.
				const [waiting] = this.#store.exec<{ approval_id: string }>(
					"SELECT approval_id FROM approvals WHERE conversation_id = ? AND binding = ? AND method = ? AND args_hash = ? AND status = 'pending' LIMIT 1",
					turn.conversationId,
					binding,
					method,
					error.record.argsHash,
				);
				if (waiting) {
					const repeated = `${message}. This exact change is already waiting for the person's decision; do not propose it again.`;
					finishStep({ ok: false, error: repeated });
					return { ok: false, error: repeated };
				}
				// The agent's own create or edit of one workspace file applies at
				// once; version history and undo are the way back. Removing
				// content, deleting, sharing and anything else waits for a person.
				const appliesNow = fileWriteAppliesAtOnce(binding, method, args, {
					destructive:
						error.decision.riskTier !== "bounded_write" ||
						error.decision.blastRadius !== "single_resource",
				});
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
				const approvalEvent = {
					type: "approval.requested" as const,
					requester: {
						id: turn.actor.id,
						kind: turn.actor.kind === "tedi" ? "tedi" : "person",
					},
					turnId: turn.turnId,
					stepId,
					approvalId,
					// A web page card names the site; the full address is its input.
					title:
						(binding === "web" && method === "fetch"
							? webApprovalTitle(args[0])
							: null) ?? label,
					reason: error.decision.reason,
					policy: error.decision.gate,
					input: boundedEventInput(
						binding === "apps" && method === "create"
							? newAppCardInput(args[0])
							: args[0],
					),
					...(target ? { target: { id: target.id, title: target.title } } : {}),
					...(appliesNow ? { automatic: true as const } : {}),
				};
				this.#events.append(turn.conversationId, approvalEvent);
				const [held] = appliesNow
					? this.#store.exec<ApprovalRow>(
							"SELECT * FROM approvals WHERE approval_id = ?",
							approvalId,
						)
					: [];
				if (held) {
					// Recorded under whoever the turn acts for, applied now, and
					// the turn gets the result.
					const settled = await this.#settleApproval(scope, held, {
						decision: "approve",
						by: turn.actor.id,
						automatic: true,
					});
					const outcome = settled?.outcome ?? {
						ok: false as const,
						error: "The change could not be applied",
					};
					finishStep(outcome.ok ? { ok: true } : outcome);
					return outcome;
				}
				message = `${message}. It waits for the person's decision on its card and is not applied yet; carry on with work that does not depend on it.`;
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
		if (this.#turn(turnId)?.status !== "running") return;
		const data = event.data ?? {};
		let body: WireEventBody | null = null;
		switch (event.type) {
			case "model_started":
				body = { type: "turn.model", turnId, model: String(data.model) };
				break;
			case "usage_updated":
				body = {
					type: "turn.usage",
					turnId,
					usage: data.usage as TurnUsage,
				};
				break;
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
					...(typeof data.code === "string"
						? { input: { code: boundedEventText(data.code) } }
						: {}),
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
					...(typeof data.result === "string"
						? { result: boundedEventText(data.result) }
						: {}),
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
				// The thread marks where earlier messages stopped being sent whole.
				this.#events.append(conversationId, {
					type: "conversation.summarized",
					turnId,
				});
				break;
			default:
				body = null;
		}
		if (body) this.#events.append(conversationId, body);
	}

	/** How long a turn waits for one code run; a test shortens it. */
	protected codeTimeoutMs(): number {
		return SANDBOX_TIMEOUT_MS;
	}

	async #guestProfile(
		scope: WorkspaceScope,
		tediId: string,
		userText: string,
		actorKind: ActorKind,
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
				trust: "trusted" | "untrusted";
			}): Promise<GuestProfile>;
		};
		return stub.guestProfile({
			tediId,
			organizationId: scope.organizationId,
			sessionKey: `workspace:${scope.workspaceId}`,
			userText,
			trust: actorKind === "user" ? "trusted" : "untrusted",
		});
	}

	/**
	 * Skills the person picked in the composer (`/skill <slug>`). Only
	 * organization-level, non-private skills that are in use (active, proven or
	 * crystallized) load, the same reach the Home composer offers. A slug that
	 * does not resolve is skipped; the model still sees the typed line.
	 */
	async #referencedSkills(scope: WorkspaceScope, text: string) {
		const slugs = parseSkillReferences(text).slice(0, 3);
		if (slugs.length === 0) return [];
		const db = createDbClient(this.env.DB);
		const rows = await Promise.all(
			slugs.map((slug) =>
				getSkillEntryBySlug(db, scope.organizationId, slug).catch(
					() => undefined,
				),
			),
		);
		const skills: ReferencedSkill[] = [];
		for (const row of rows) {
			if (!row || !isSkillReadableByTedi(row)) continue;
			if (
				!["active", "proven", "crystallized"].includes(row.lifecycleState ?? "")
			)
				continue;
			skills.push({
				slug: row.slug ?? "",
				title: row.title,
				content: row.content,
			});
		}
		return skills;
	}

	/**
	 * Every request in the workspace still waiting for a person, oldest first,
	 * as each was announced. A chat shows them all, whichever conversation
	 * asked.
	 */
	#waitingApprovals(): WaitingApproval[] {
		const rows = this.#store.exec<ApprovalRow>(
			`SELECT * FROM approvals WHERE status = 'pending' ORDER BY rowid ASC LIMIT ${WAITING_APPROVALS_LIMIT}`,
		);
		const announced = new Map<string, WaitingApproval>();
		for (const turnId of new Set(rows.map((row) => row.turn_id)))
			for (const event of this.#events.ofTurn(turnId, "approval.requested"))
				if (event.type === "approval.requested")
					announced.set(event.approvalId, {
						approvalId: event.approvalId,
						conversationId: event.conversationId,
						turnId: event.turnId,
						stepId: event.stepId,
						title: event.title,
						reason: event.reason,
						at: event.at,
						...(event.policy ? { policy: event.policy } : {}),
						...(event.input === undefined ? {} : { input: event.input }),
						...(event.target ? { target: event.target } : {}),
					});
		return rows.flatMap((row) => {
			const request = announced.get(row.approval_id);
			if (!request) return [];
			return [
				{
					...request,
					requester: {
						id: row.tedi_id ?? row.actor_id,
						kind: row.tedi_id || row.actor_kind === "tedi" ? "tedi" : "person",
					},
				},
			];
		});
	}

	/**
	 * Changes this conversation proposed that still wait for a decision, so a
	 * new turn knows about them instead of proposing them again.
	 */
	async #pendingApprovals(
		scope: WorkspaceScope,
		conversationId: string,
		actorKind: ActorKind,
	): Promise<PendingApproval[]> {
		const rows = this.#store.exec<ApprovalRow>(
			"SELECT * FROM approvals WHERE conversation_id = ? AND status = 'pending' ORDER BY rowid ASC LIMIT 50",
			conversationId,
		);
		if (rows.length === 0) return [];
		const data = this.#dataPort(scope, actorKind);
		return Promise.all(
			rows.map(async (row) => {
				const action = stepLabel(row.binding, row.method).label;
				if (row.binding === "accounts") return { action };
				const request = (JSON.parse(row.args) as unknown[])[0] as
					| { title?: unknown; name?: unknown; outputId?: unknown }
					| string
					| undefined;
				const target =
					typeof request === "string"
						? // A web page waiting to be read: its address.
							request.slice(0, 300)
						: typeof request?.title === "string"
							? request.title
							: row.binding === "apps" && typeof request?.name === "string"
								? request.name.slice(0, 120)
								: typeof request?.outputId === "string"
									? ((await data.getOutput(request.outputId).catch(() => null))
											?.title ?? null)
									: null;
				return { action, target };
			}),
		);
	}

	async #plan(
		scope: WorkspaceScope,
		turnId: string,
		conversationId: string,
		input: TurnRequest,
	): Promise<TurnPlan> {
		const data = this.#dataPort(scope, input.actorKind, {
			conversationId,
			turnId,
		});
		const workspaceRead = this.#workspaceRead ?? data.workspace();
		this.#workspaceRead = workspaceRead;
		void workspaceRead.then(
			() => {
				if (this.#workspaceRead === workspaceRead) this.#workspaceRead = null;
			},
			() => {
				if (this.#workspaceRead === workspaceRead) this.#workspaceRead = null;
			},
		);
		const [
			workspace,
			guest,
			referencedSkills,
			pendingApprovals,
			linkedAccounts,
		] = await Promise.all([
			workspaceRead,
			input.tediId
				? this.#guestProfile(scope, input.tediId, input.text, input.actorKind)
				: null,
			input.actorKind === "user"
				? this.#referencedSkills(scope, input.text)
				: [],
			this.#pendingApprovals(scope, conversationId, input.actorKind),
			input.actorKind === "user"
				? listLinkedAccounts(data).catch(() => [])
				: null,
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
			referencedSkills,
			pendingApprovals,
			linkedAccounts,
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
			...(input.tediId ? { tediId: input.tediId } : {}),
			...(input.actorKind === "user" ? { memberId: input.actorId } : {}),
			modelId: input.modelId,
			systemPrompt,
			history,
			userText:
				input.actorKind === "user"
					? input.text
					: wrapUntrustedInput(input.text, input.actorKind),
		};
	}

	/** Reread the administrator's published model catalog at most once a minute. */
	protected async refreshModelCatalog(): Promise<void> {
		if (
			this.#modelCatalog &&
			Date.now() - this.#modelCatalog.readAt < MODEL_CATALOG_TTL_MS
		)
			return;
		try {
			const { entries } = await getModelCatalogConfig(
				createDbQueryClient(this.env.DB),
			);
			this.#modelCatalog = { entries, readAt: Date.now() };
		} catch (error) {
			// A missing or malformed catalog offers no model; never an older list.
			this.#modelCatalog = null;
			console.warn("workspace model catalog unavailable", error);
		}
	}

	protected configuredModels() {
		return catalogWorkspaceModels(this.env, this.#modelCatalog?.entries ?? []);
	}

	/** Outbound fetch for `web.fetch`; a test subclass serves fixed pages. */
	protected webFetch(): FetchFn | undefined {
		return undefined;
	}

	protected accountService(): AccountService {
		return this.env.API_SERVICE as unknown as AccountService;
	}

	/** The model a turn streams from; a test subclass returns a scripted one. */
	protected modelFor(plan: TurnPlan): ModelPort {
		return admittedTurnModel(this.env, plan);
	}

	async #execute(
		scope: WorkspaceScope,
		turnId: string,
		conversationId: string,
		input: TurnRequest,
		controller: AbortController,
	) {
		const startedAt = Date.now();
		let answered = false;
		try {
			const plan = await this.#plan(scope, turnId, conversationId, input);
			const isolate =
				input.isolate ?? plan.history.length > ISOLATE_AFTER_MESSAGES;
			// Written before the model call, so a reset mid-turn shows its size.
			workspaceLog.info("Workspace turn running", {
				event: "workspace.turn_running",
				isolated: isolate,
				historyMessages: plan.history.length,
				...this.#diagnostics(() => ({
					historyBytes:
						this.#store.exec<{ bytes: number }>(
							"SELECT coalesce(sum(length(message)), 0) AS bytes FROM (SELECT message FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 200)",
							conversationId,
						)[0]?.bytes ?? 0,
				})),
			});
			const result = isolate
				? await this.#runIsolated(plan, controller.signal)
				: await executeTurn(plan, {
						env: this.env,
						model: this.modelFor(plan),
						codeRuns: {
							env: (runId) =>
								loopbackEnv(this.ctx.exports.WorkspaceBindingLoopback, {
									objectName: tenantStoreName(scope),
									scope,
									turnId,
									runId,
								}),
							start: (runId) => this.startCodeRun(scope, turnId, runId),
							end: (runId) => this.endCodeRun(scope, turnId, runId),
							timeoutMs: this.codeTimeoutMs(),
						},
						emit: (event) => this.#emitLoopEvent(conversationId, turnId, event),
						save: (progress) =>
							this.#saveProgress(conversationId, turnId, progress),
						takeAdded: () => this.takeQueuedMessages(scope, turnId),
						signal: controller.signal,
					});
			if (this.#turn(turnId)?.status !== "running") return;
			const usage = result.usage
				? {
						...toTurnUsage(result.usage),
						...(await priceTurn(
							this.env.DB,
							this.env,
							plan.modelId,
							result.usage,
							new Date().toISOString(),
						)),
					}
				: null;
			if (this.#turn(turnId)?.status !== "running") return;
			this.#persist(conversationId, turnId, result);
			this.#events.append(conversationId, {
				type: "assistant.done",
				turnId,
				messageId: turnId,
				text: result.text,
				model: result.model,
				...(usage ? { usage } : {}),
			});
			this.#events.append(conversationId, {
				type: "turn.finished",
				turnId,
				status: result.stopReason === "aborted" ? "cancelled" : "done",
				durationMs: Date.now() - startedAt,
			});
			if (result.stopReason !== "aborted") answered = true;
		} catch (error) {
			if (this.#turn(turnId)?.status !== "running") return;
			const cancelled = controller.signal.aborted;
			// The message stays on the turn; a model error can quote the chat.
			workspaceLog.warn("Workspace turn did not finish", {
				event: "workspace.turn_failed",
				reason: cancelled
					? "cancelled"
					: error instanceof Error
						? error.name
						: "error",
				durationMs: Date.now() - startedAt,
				...this.#diagnostics(),
			});
			const message = cancelled
				? "cancelled by user"
				: error instanceof Error
					? error.message
					: String(error);
			this.#store.run(
				"UPDATE turns SET status = ?, error = ?, finished_at = ? WHERE turn_id = ?",
				cancelled ? "cancelled" : "failed",
				message,
				new Date().toISOString(),
				turnId,
			);
			this.#events.append(conversationId, {
				type: "turn.finished",
				turnId,
				status: cancelled ? "cancelled" : "error",
				error: message,
				durationMs: Date.now() - startedAt,
			});
		} finally {
			this.#running.delete(turnId);
			this.#codeRuns.delete(turnId);
			this.#viewsShown.delete(turnId);
			for (const wake of this.#waiters.get(turnId) ?? []) wake();
			this.#waiters.delete(turnId);
		}
		// What the person sent too late for this turn starts the next one. A
		// stopped turn handed its unread messages back instead.
		const next =
			!controller.signal.aborted &&
			(await this.#startQueuedMessage(scope, conversationId));
		if (answered && !next)
			await this.#continueAfterDecisions(scope, conversationId).catch(
				(error: unknown) =>
					workspaceLog.warn("Decisions made during a turn were not answered", {
						event: "workspace.decisions_unanswered",
						error,
						...this.#diagnostics(),
					}),
			);
	}

	async #runIsolated(plan: TurnPlan, signal: AbortSignal): Promise<TurnResult> {
		const facet = this.ctx.facets.get(`turn:${plan.turnId}`, () => ({
			class: this.ctx.exports.TurnFacet,
		})) as unknown as {
			run(plan: TurnPlan, objectName: string): Promise<TurnResult>;
			cancel(): Promise<void>;
		};
		signal.throwIfAborted();
		// An AbortSignal cannot cross RPC; Stop reaches the facet as a call.
		const stop = () => {
			facet.cancel().catch(() => {});
		};
		signal.addEventListener("abort", stop, { once: true });
		try {
			return await facet.run(plan, tenantStoreName(plan.scope));
		} finally {
			signal.removeEventListener("abort", stop);
			this.ctx.facets.delete(`turn:${plan.turnId}`);
		}
	}

	/** Store a turn's progress at once, so a stop or crash keeps it. */
	#saveProgress(
		conversationId: string,
		turnId: string,
		progress: TurnProgress,
	) {
		if (this.#turn(turnId)?.status !== "running") return;
		const now = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			if (progress.compaction) {
				this.#store.put(
					`compaction:${conversationId}`,
					progress.compaction.summary,
				);
				this.#store.run(
					"DELETE FROM messages WHERE seq IN (SELECT seq FROM messages WHERE conversation_id = ? ORDER BY seq ASC LIMIT ?)",
					conversationId,
					progress.compaction.droppedMessages,
				);
			}
			for (const message of progress.messages) {
				this.#store.run(
					"INSERT INTO messages (conversation_id, turn_id, at, message) VALUES (?, ?, ?, ?)",
					conversationId,
					turnId,
					now,
					JSON.stringify(message),
				);
			}
			this.#store.run(
				"UPDATE conversations SET updated_at = ? WHERE id = ?",
				now,
				conversationId,
			);
		});
	}

	#persist(conversationId: string, turnId: string, result: TurnResult) {
		const now = new Date().toISOString();
		this.#store.run(
			"UPDATE turns SET status = ?, text = ?, finished_at = ? WHERE turn_id = ?",
			result.stopReason === "aborted" ? "cancelled" : "finished",
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
export interface WorkspaceRpc extends DocumentTransferRuntime {
	appendAgentRunNotice(
		scope: WorkspaceScope,
		input: { conversationId: string; attemptId: string; content: string },
	): Promise<void>;
	transferOutput(
		scope: WorkspaceScope,
		outputId: string,
		targetWorkspaceId: string,
	): Promise<OutputTransferResult>;
	completeOutputTransfer(
		scope: WorkspaceScope,
		outputId: string,
		transferId: string,
	): Promise<void>;
	replayActivity(
		scope: WorkspaceScope,
		input?: ActivityPageInput,
	): Promise<{ published: number; lastSequence: number }>;
	reconcileActivity(
		scope: WorkspaceScope,
		input?: ActivityPageInput,
	): Promise<{
		checked: number;
		missing: string[];
		lastSequence: number;
		coverage: "recorded_binding_actions" | "recorded_workspace_events";
	}>;

	refreshOutputProjection(
		scope: WorkspaceScope,
		outputId: string,
	): Promise<void>;
	adoptSharedOutputs(
		scope: WorkspaceScope,
		input: { outputIds: string[]; dryRun: boolean },
	): ReturnType<WorkspaceDO["adoptSharedOutputs"]>;
	outputQuery<K extends OutputQuery["op"]>(
		scope: WorkspaceScope,
		query: OutputQuery<K>,
	): Promise<OutputQueryResult<K>>;
	sendTurn(
		scope: WorkspaceScope,
		input: TurnRequest,
	): Promise<{
		turnId: string;
		conversationId: string;
		seq: number;
		/** Held for the turn already working; `turnId` is that turn. */
		queued?: true;
	}>;
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
	listConversationTurnIds(
		scope: WorkspaceScope,
		conversationId: string,
	): Promise<string[]>;
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
	exportChangeRecords(
		scope: WorkspaceScope,
		query: OsWorkspaceChangeRecordsQuery,
	): Promise<OsWorkspaceChangeRecordsExport>;
	readChangeRecords(
		scope: WorkspaceScope,
		query?: ChangeRecordQuery,
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
	): Promise<ApprovalResult>;
	decideApprovals(
		scope: WorkspaceScope,
		input: {
			approvalIds: string[];
			decision: "approve" | "deny";
			by: string;
			note?: string;
		},
	): Promise<ApprovalResult[]>;
	describe(scope: WorkspaceScope): Promise<{
		organizationId: string;
		workspaceId: string;
		createdAt: string;
		migrations: string[];
		outputAuthority: string;
		importGeneration: number;
	}>;
	applyImportDelta(
		scope: WorkspaceScope,
		input: TenantStoreDeltaBatch & {
			importGeneration: number;
			freezeRef: string;
		},
	): Promise<{
		batchId: string;
		table: string;
		rowCount: number;
		status: "imported" | "duplicate";
		importGeneration: number;
	}>;
	activateOutputAuthority(
		scope: WorkspaceScope,
		input: { importGeneration: number; reconciliationRef: string },
	): Promise<{ importGeneration: number; reconciliationRef: string }>;
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
/** What `sendTurn` answers for a message held for the working turn. */
function queuedReceipt(message: QueuedMessageRow) {
	return {
		turnId: message.turn_id,
		conversationId: message.conversation_id,
		seq: message.seq,
		queued: true as const,
	};
}

/** What a call is answered when its code run is not the one the turn waits for. */
export const ENDED_CODE_RUN_ERROR =
	"Not done: this code run has ended, so its calls are no longer accepted. This call changed nothing.";

/**
 * Each code run of a turn has its own id, carried by the stubs in its `env`.
 * The workspace accepts a call only from the run the turn is waiting for.
 */
export interface CodeRuns {
	/** Sandbox `env` for one run: one loopback stub per binding. */
	env(runId: string): Record<string, unknown>;
	start(runId: string): void | Promise<void>;
	end(runId: string): void | Promise<void>;
	timeoutMs: number;
}

function loopbackEnv(
	loopback: (options: { props: LoopbackProps }) => unknown,
	run: Omit<LoopbackProps, "binding">,
): Record<string, unknown> {
	const env: Record<string, unknown> = {};
	for (const binding of BINDING_NAMES)
		env[binding] = loopback({ props: { ...run, binding } });
	return env;
}

export interface ExecuteTurnHost {
	env: WorkspaceEnv;
	codeRuns: CodeRuns;
	emit: (event: LoopEvent) => void;
	save: (progress: TurnProgress) => void | Promise<void>;
	takeAdded: () => AddedMessage[] | Promise<AddedMessage[]>;
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
			runCode: async (code) => {
				const runId = crypto.randomUUID();
				await host.codeRuns.start(runId);
				// However the run ends, its id stops being accepted before the
				// model reads the result: code still executing after a timeout
				// cannot change anything behind the model's back.
				try {
					return await sandbox.run({
						code,
						env: host.codeRuns.env(runId),
						timeoutMs: host.codeRuns.timeoutMs,
					});
				} finally {
					await host.codeRuns.end(runId);
				}
			},
			emit: host.emit,
			save: host.save,
			takeAdded: host.takeAdded,
			signal: host.signal,
			summarize: async (messages) => {
				const stream = host.model.stream(
					{
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
					},
					{ signal: host.signal, maxTokens: host.model.maxOutputTokens },
				);
				const summary = await stream.result();
				return {
					usage: summary.usage,
					summary: summary.content
						.filter(
							(block): block is { type: "text"; text: string } =>
								block.type === "text",
						)
						.map((block) => block.text)
						.join(""),
				};
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
	readonly #stop = new AbortController();

	/** The parent's Stop: abort the model call and run no further code. */
	cancel() {
		this.#stop.abort(new Error("cancelled by user"));
	}

	/** How long the turn waits for one code run; a test shortens it. */
	protected async codeTimeoutMs(_plan: TurnPlan): Promise<number> {
		return SANDBOX_TIMEOUT_MS;
	}

	/** The model this facet streams from; a test subclass returns a scripted one. */
	protected async modelFor(plan: TurnPlan): Promise<ModelPort> {
		return admittedTurnModel(this.env, plan);
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
			saveTurnProgress(
				scope: WorkspaceScope,
				turnId: string,
				progress: TurnProgress,
			): Promise<void>;
			takeQueuedMessages(
				scope: WorkspaceScope,
				turnId: string,
			): Promise<AddedMessage[]>;
			startCodeRun(
				scope: WorkspaceScope,
				turnId: string,
				runId: string,
			): Promise<void>;
			endCodeRun(
				scope: WorkspaceScope,
				turnId: string,
				runId: string,
			): Promise<void>;
		};
		return executeTurn(plan, {
			env: this.env,
			model: await this.modelFor(plan),
			codeRuns: {
				env: (runId) =>
					loopbackEnv(this.ctx.exports.WorkspaceBindingLoopback, {
						objectName,
						scope: plan.scope,
						turnId: plan.turnId,
						runId,
					}),
				start: (runId) => parent.startCodeRun(plan.scope, plan.turnId, runId),
				end: (runId) => parent.endCodeRun(plan.scope, plan.turnId, runId),
				timeoutMs: await this.codeTimeoutMs(plan),
			},
			emit: (event) => {
				void parent.appendTurnEvent(plan.scope, plan.turnId, event);
			},
			save: (progress) =>
				parent.saveTurnProgress(plan.scope, plan.turnId, progress),
			takeAdded: () => parent.takeQueuedMessages(plan.scope, plan.turnId),
			signal: this.#stop.signal,
		});
	}
}

interface LoopbackProps {
	objectName: string;
	scope: WorkspaceScope;
	turnId: string;
	/** The code run this stub was made for. */
	runId: string;
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
					runId: string;
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
			runId: props.runId,
			binding: props.binding,
			method,
			args,
		});
	}
	list(...args: unknown[]) {
		return this.#call("list", args);
	}
	/** `web.fetch`: an entrypoint's own `fetch` is HTTP, so the harness calls this name. */
	fetchPage(...args: unknown[]) {
		return this.#call("fetch", args);
	}
	listOpen(...args: unknown[]) {
		return this.#call("listOpen", args);
	}
	startRun(...args: unknown[]) {
		return this.#call("startRun", args);
	}
	readRun(...args: unknown[]) {
		return this.#call("readRun", args);
	}
	sendRunMessage(...args: unknown[]) {
		return this.#call("sendRunMessage", args);
	}
	stopRun(...args: unknown[]) {
		return this.#call("stopRun", args);
	}
	write(...args: unknown[]) {
		return this.#call("write", args);
	}
	history(...args: unknown[]) {
		return this.#call("history", args);
	}
	review(...args: unknown[]) {
		return this.#call("review", args);
	}
	rollback(...args: unknown[]) {
		return this.#call("rollback", args);
	}
	readFile(...args: unknown[]) {
		return this.#call("readFile", args);
	}
	editFile(...args: unknown[]) {
		return this.#call("editFile", args);
	}
	writeFile(...args: unknown[]) {
		return this.#call("writeFile", args);
	}
	grep(...args: unknown[]) {
		return this.#call("grep", args);
	}
	getCode(...args: unknown[]) {
		return this.#call("getCode", args);
	}
	get(...args: unknown[]) {
		return this.#call("get", args);
	}
	readFileText(...args: unknown[]) {
		return this.#call("readFileText", args);
	}
	searchFileText(...args: unknown[]) {
		return this.#call("searchFileText", args);
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
	describe(...args: unknown[]) {
		return this.#call("describe", args);
	}
	replace(...args: unknown[]) {
		return this.#call("replace", args);
	}
	edit(...args: unknown[]) {
		return this.#call("edit", args);
	}
	show(...args: unknown[]) {
		return this.#call("show", args);
	}
	requestConnection(...args: unknown[]) {
		return this.#call("requestConnection", args);
	}
}
