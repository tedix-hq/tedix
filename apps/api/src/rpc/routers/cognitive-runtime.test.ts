import { createRouterClient } from "@orpc/server";
import {
	decodeRuntimeEventCursor,
	RuntimeEventCursorSchema,
	TediRuntimeEventKindSchema,
	TediRuntimeStabilitySchema,
	TediRuntimeStatusSchema,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import { REPO_COMMIT_WRITE_KIND } from "@tedix/api-contract/schemas/repo-commit-write";
import { getTediArtifactClaim } from "@tedix/db/queries/cognitive-runtime";
import {
	kernelRuntimeRuns,
	kernelWakeQueue,
	TEDI_RUNTIME_EVENT_KIND_VALUES,
	tediArtifacts,
	tediRuntimeEvents,
	tediSessionStates,
} from "@tedix/db/schema";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import * as runtimeSubmissionBridge from "../../kernel/runtime-submission-bridge";
import { ProvisioningHttpError } from "@tedix/provisioning";
import type { BaseContext } from "../orpc";
import { cognitiveRuntimeContractRouter } from "./cognitive-runtime";
import { runtimeEventId } from "@tedix/api-contract/utils/runtime-events";
import {
	normalizeRuntimeEvent,
	notifyKernelChildApprovalBlock,
	notifyKernelChildComplete,
	resolveTediRuntimeBackend,
} from "./cognitive-runtime/events-policy";

const mocks = vi.hoisted(() => ({
	cancelRuntimeTurn: vi.fn(),
	enqueueRuntimeChatMessage: vi.fn(),
	getApprovalRequestById: vi.fn(),
	getGatewayStability: vi.fn(),
	getOsGadgetExecutionByRunId: vi.fn(),
	getAgentDiagnostics: vi.fn(),
	getTediById: vi.fn(),
	injectAgentMessage: vi.fn(),
	insertAuditEvent: vi.fn(),
	ensureActiveKernelHarnessVersion: vi.fn(),
	recordHarnessSubjectTraceBundle: vi.fn(),
	recordContribution: vi.fn(),
	requestSubmissionAbort: vi.fn(),
	resolveApprovalRequest: vi.fn(),
	settleRepoCommitApprovalIfNeeded: vi.fn(),
	stopRuntimeRun: vi.fn(),
	transcribeAudioAttachment: vi.fn(),
	updateTediRuntimeActivity: vi.fn(),
}));

vi.mock("@tedix/db/queries/artifact-policy/contributions", () => ({
	recordTediArtifactContributionReceipt: mocks.recordContribution,
	TediArtifactContributionReceiptConflictError: class extends Error {},
}));

vi.mock(
	"@tedix/db/queries/os-workspaces/executions",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@tedix/db/queries/os-workspaces/executions")
			>();
		return {
			...actual,
			getOsGadgetExecutionByRunId: mocks.getOsGadgetExecutionByRunId,
		};
	},
);

vi.mock("@tedix/db/queries/tedis", () => ({
	getTediById: mocks.getTediById,
	updateTediRuntimeActivity: mocks.updateTediRuntimeActivity,
}));

vi.mock("@tedix/db/queries/approvals", () => ({
	getApprovalRequestById: mocks.getApprovalRequestById,
	resolveApprovalRequest: mocks.resolveApprovalRequest,
}));

// Only the durable abort stamp is replaced (the fake db has no
// runtime_submissions table to CAS against); every other ledger helper stays
// real so the fail-soft admit/settle paths keep exercising their actual code.
vi.mock(
	"@tedix/db/queries/runtime-submissions/phase-transitions",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@tedix/db/queries/runtime-submissions/phase-transitions")
			>();
		return { ...actual, requestSubmissionAbort: mocks.requestSubmissionAbort };
	},
);

vi.mock("@tedix/db/queries/audit", () => ({
	insertAuditEvent: mocks.insertAuditEvent,
}));

vi.mock("@tedix/db/queries/harness-version/trace-bundles", () => ({
	recordHarnessSubjectTraceBundle: mocks.recordHarnessSubjectTraceBundle,
}));

vi.mock("../../services/harness-persistence", () => ({
	ensureActiveKernelHarnessVersion: mocks.ensureActiveKernelHarnessVersion,
}));

vi.mock("./kernel/repo-commit-approval-settle", () => ({
	settleRepoCommitApprovalIfNeeded: mocks.settleRepoCommitApprovalIfNeeded,
}));

vi.mock("@tedix/provisioning", () => ({
	buildProvisioningConfig: (
		baseUrl: string,
		env: Record<string, unknown>,
		service: unknown,
	) => ({
		baseUrl,
		env,
		service,
	}),
	ProvisioningHttpError: class ProvisioningHttpError extends Error {
		status: number;
		body: string;
		timedOut: boolean;
		constructor(message: string, status: number, body = "", timedOut = false) {
			super(message);
			this.name = "ProvisioningHttpError";
			this.status = status;
			this.body = body;
			this.timedOut = timedOut;
		}
	},
	cancelRuntimeTurn: mocks.cancelRuntimeTurn,
	enqueueRuntimeChatMessage: mocks.enqueueRuntimeChatMessage,
	getGatewayStability: mocks.getGatewayStability,
	getAgentDiagnostics: mocks.getAgentDiagnostics,
	injectAgentMessage: mocks.injectAgentMessage,
	stopRuntimeRun: mocks.stopRuntimeRun,
}));

// ASYNC VOICE NOTES: the isolate branch transcribes audio in Worker-land before
// dispatch. Stub the STT helper so the handler test is deterministic; the helper
// itself is unit-tested in ../../lib/voice-stt.test.ts.
vi.mock("@tedix/voice/stt", async () => {
	const actual =
		await vi.importActual<typeof import("@tedix/voice/stt")>(
			"@tedix/voice/stt",
		);
	return {
		...actual,
		transcribeAudioAttachment: mocks.transcribeAudioAttachment,
	};
});

const ORG_ID = "org-1";
const TEDI_ID = "tedi-1";

it("keeps API-contract and DB runtime event kind enums aligned", () => {
	for (const kind of TEDI_RUNTIME_EVENT_KIND_VALUES) {
		expect(TediRuntimeEventKindSchema.parse(kind)).toBe(kind);
	}
	for (const kind of [
		"step.completed",
		"subagent.started",
		"subagent.completed",
		"subagent.failed",
		"submission.admitted",
		"submission.attempt.started",
		"submission.attempt.recovered",
		"submission.settled",
		"delegation.authority.evaluated",
		"workstation.exec.completed",
		"workstation.exec.failed",
		"workstation.egress.allow",
		"workstation.egress.deny",
		"browser.egress.deny",
	]) {
		expect(TEDI_RUNTIME_EVENT_KIND_VALUES).toContain(kind);
	}
});

type RuntimeEventRow = typeof tediRuntimeEvents.$inferSelect;
type RuntimeEventInsert = typeof tediRuntimeEvents.$inferInsert;
type ArtifactRow = typeof tediArtifacts.$inferSelect;
type ArtifactInsert = typeof tediArtifacts.$inferInsert;
type SessionStateRow = typeof tediSessionStates.$inferSelect;

const columnKeyByName: Record<string, string> = {
	artifact_id: "artifactId",
	conversation_id: "conversationId",
	created_at: "createdAt",
	deleted_at: "deletedAt",
	id: "id",
	kind: "kind",
	message_id: "messageId",
	organization_id: "organizationId",
	run_id: "runId",
	session_key: "sessionKey",
	tedi_id: "tediId",
};

function stringChunkValue(chunk: unknown): string {
	const value = (chunk as { value?: unknown }).value;
	return Array.isArray(value) ? value.join("") : "";
}

function collectWhereConditions(
	value: unknown,
	conditions: Array<{
		key: string;
		op: "=" | "<" | "notnull";
		value: unknown;
	}> = [],
) {
	const chunks = (value as { queryChunks?: unknown[] } | undefined)
		?.queryChunks;
	if (!Array.isArray(chunks)) return conditions;
	for (let index = 0; index < chunks.length; index += 1) {
		const chunk = chunks[index] as { name?: unknown; queryChunks?: unknown[] };
		if (chunk?.queryChunks) {
			collectWhereConditions(chunk, conditions);
			continue;
		}
		if (typeof chunk?.name !== "string") continue;
		const op = stringChunkValue(chunks[index + 1]).trim();
		const key = columnKeyByName[chunk.name];
		if (!key) continue;
		// `isNotNull(column)` renders as a trailing `is not null` chunk with no
		// bound param. Model it so soft-delete (`deletedAt`) filters apply in tests.
		if (op.includes("is not null")) {
			conditions.push({ key, op: "notnull", value: undefined });
			continue;
		}
		const param = chunks[index + 2] as { value?: unknown } | undefined;
		if (!param || !("value" in param)) continue;
		if (op === "=" || op === "<") {
			conditions.push({ key, op, value: param.value });
		}
	}
	return conditions;
}

function applyWhere<Row extends Record<string, unknown>>(
	rows: Row[],
	whereClause: unknown,
): Row[] {
	const conditions = collectWhereConditions(whereClause);
	if (conditions.length === 0) return rows;
	const equalsByKey = new Map<string, Set<unknown>>();
	const lessThan: Array<{ key: string; value: unknown }> = [];
	const notNullKeys: string[] = [];
	for (const condition of conditions) {
		if (condition.op === "=") {
			const values = equalsByKey.get(condition.key) ?? new Set<unknown>();
			values.add(condition.value);
			equalsByKey.set(condition.key, values);
		} else if (condition.op === "notnull") {
			notNullKeys.push(condition.key);
		} else {
			lessThan.push(condition);
		}
	}
	return rows.filter((row) => {
		for (const [key, values] of equalsByKey) {
			if (!values.has(row[key] ?? null)) return false;
		}
		for (const key of notNullKeys) {
			if (row[key] === null || row[key] === undefined) return false;
		}
		for (const condition of lessThan) {
			const rowValue = row[condition.key];
			if (typeof rowValue !== "string" || typeof condition.value !== "string") {
				return false;
			}
			if (!(rowValue < condition.value)) return false;
		}
		return true;
	});
}

/** True if the SQL where-tree contains a `not exists (...)` chunk. */
function whereHasNotExists(value: unknown): boolean {
	const chunks = (value as { queryChunks?: unknown[]; value?: unknown[] })
		?.queryChunks;
	const valueParts = (value as { value?: unknown[] })?.value;
	if (
		Array.isArray(valueParts) &&
		valueParts.some(
			(part) => typeof part === "string" && part.includes("not exists"),
		)
	) {
		return true;
	}
	if (!Array.isArray(chunks)) return false;
	return chunks.some((chunk) => whereHasNotExists(chunk));
}

function isDescOrder(orderByClause: unknown): boolean {
	const chunks = (orderByClause as { queryChunks?: unknown[] } | undefined)
		?.queryChunks;
	return Array.isArray(chunks)
		? chunks.some((chunk) => stringChunkValue(chunk).includes(" desc"))
		: false;
}

function normalizeRuntimeEventInsert(
	input: RuntimeEventInsert,
): RuntimeEventRow {
	return {
		id: input.id,
		organizationId: input.organizationId,
		tediId: input.tediId,
		kind: input.kind,
		conversationId: input.conversationId ?? null,
		runId: input.runId ?? null,
		messageId: input.messageId ?? null,
		toolCallId: input.toolCallId ?? null,
		approvalRequestId: input.approvalRequestId ?? null,
		artifactId: input.artifactId ?? null,
		sequence: input.sequence ?? null,
		delta: input.delta ?? null,
		payload: input.payload ?? null,
		runtimeBackend: input.runtimeBackend,
		runtimeExternalId: input.runtimeExternalId ?? null,
		runtimeExternalUrl: input.runtimeExternalUrl ?? null,
		runtimeMetadata: input.runtimeMetadata ?? null,
		createdAt: input.createdAt ?? "2026-05-25T08:00:00.000Z",
	};
}

function normalizeArtifactInsert(input: ArtifactInsert): ArtifactRow {
	return {
		id: input.id,
		organizationId: input.organizationId,
		tediId: input.tediId,
		conversationId: input.conversationId ?? null,
		runId: input.runId ?? null,
		messageId: input.messageId ?? null,
		kind: input.kind,
		name: input.name,
		mimeType: input.mimeType ?? null,
		uri: input.uri ?? null,
		sizeBytes: input.sizeBytes ?? null,
		metadata: input.metadata ?? null,
		accessClassification: input.accessClassification ?? null,
		contentDigest: input.contentDigest ?? null,
		producerExecutionId: input.producerExecutionId ?? null,
		accessEnvelope: input.accessEnvelope ?? null,
		publicationState: input.publicationState ?? null,
		createdAt: input.createdAt ?? "2026-05-25T08:00:00.000Z",
	};
}

function createRuntimeDb() {
	const events: RuntimeEventRow[] = [];
	const artifacts: ArtifactRow[] = [];
	// session-state rows carry the soft-delete (`deletedAt`) marker that
	// readMessages/listConversations consult. Default empty (no soft-deletes).
	const sessionStates: SessionStateRow[] = [];
	const rowsFor = (
		table: unknown,
	): Array<RuntimeEventRow | ArtifactRow | SessionStateRow> => {
		if (table === tediRuntimeEvents) return events;
		if (table === tediSessionStates) return sessionStates;
		return artifacts;
	};

	return {
		events,
		artifacts,
		sessionStates,
		insert(table: unknown) {
			let rows: RuntimeEventInsert[] | ArtifactInsert[] = [];
			let ignoreConflicts = false;
			let upsertOnConflict = false;
			return {
				values(
					value:
						| RuntimeEventInsert
						| RuntimeEventInsert[]
						| ArtifactInsert
						| ArtifactInsert[],
				) {
					rows = Array.isArray(value) ? value : [value];
					return this;
				},
				onConflictDoNothing() {
					ignoreConflicts = true;
					return this;
				},
				onConflictDoUpdate() {
					upsertOnConflict = true;
					return this;
				},
				returning() {
					const inserted: Array<RuntimeEventRow | ArtifactRow> = [];
					if (table === tediRuntimeEvents) {
						for (const row of rows as RuntimeEventInsert[]) {
							if (
								ignoreConflicts &&
								events.some((event) => event.id === row.id)
							) {
								continue;
							}
							const normalized = normalizeRuntimeEventInsert(row);
							events.push(normalized);
							inserted.push(normalized);
						}
						return Promise.resolve(inserted);
					}
					for (const row of rows as ArtifactInsert[]) {
						const normalized = normalizeArtifactInsert(row);
						if (upsertOnConflict) {
							const idx = artifacts.findIndex((a) => a.id === normalized.id);
							if (idx >= 0) {
								const existing = artifacts[idx]!;
								if (
									existing.organizationId !== normalized.organizationId ||
									existing.tediId !== normalized.tediId
								)
									continue;
								const updated = {
									...normalized,
									createdAt: existing.createdAt,
								};
								artifacts[idx] = updated;
								inserted.push(updated);
								continue;
							}
						}
						artifacts.push(normalized);
						inserted.push(normalized);
					}
					return Promise.resolve(inserted);
				},
				// Drizzle query builders are awaitable; the router awaits this fake.
				then<TResult1 = Array<RuntimeEventRow | ArtifactRow>, TResult2 = never>(
					onfulfilled?:
						| ((
								value: Array<RuntimeEventRow | ArtifactRow>,
						  ) => TResult1 | PromiseLike<TResult1>)
						| null,
					onrejected?:
						| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
						| null,
				) {
					return this.returning().then(onfulfilled, onrejected);
				},
			};
		},
		select() {
			let selectedRows: Array<RuntimeEventRow | ArtifactRow | SessionStateRow> =
				[];
			let whereClause: unknown;
			let orderByClause: unknown;
			let rowLimit: number | undefined;
			let fromTable: unknown;
			const builder = {
				from(table: unknown) {
					fromTable = table;
					selectedRows = [...rowsFor(table)];
					return this;
				},
				where(value: unknown) {
					whereClause = value;
					return this;
				},
				orderBy(value: unknown) {
					orderByClause = value;
					return this;
				},
				limit(value: number) {
					rowLimit = value;
					return this;
				},
				execute() {
					let output = applyWhere(selectedRows, whereClause);
					// listConversations adds `notExists(soft-deleted session)`. The
					// generic where-parser can't evaluate a correlated subquery, so model
					// the org-scoped hide directly: drop any runtime-event row whose
					// (org, tedi, conversationId) matches a soft-deleted session-state.
					if (
						fromTable === tediRuntimeEvents &&
						whereHasNotExists(whereClause)
					) {
						output = output.filter(
							(row) =>
								!sessionStates.some(
									(state) =>
										state.deletedAt != null &&
										state.organizationId ===
											(row as RuntimeEventRow).organizationId &&
										state.tediId === (row as RuntimeEventRow).tediId &&
										state.sessionKey ===
											(row as RuntimeEventRow).conversationId,
								),
						);
					}
					if (orderByClause) {
						const direction = isDescOrder(orderByClause) ? -1 : 1;
						output = [...output].sort(
							(a, b) => direction * a.createdAt.localeCompare(b.createdAt),
						);
					}
					if (rowLimit !== undefined) output = output.slice(0, rowLimit);
					return output;
				},
				// Drizzle query builders are awaitable; the router awaits this fake.
				then<TResult1 = Array<RuntimeEventRow | ArtifactRow>, TResult2 = never>(
					onfulfilled?:
						| ((
								value: Array<RuntimeEventRow | ArtifactRow>,
						  ) => TResult1 | PromiseLike<TResult1>)
						| null,
					onrejected?:
						| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
						| null,
				) {
					return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
				},
			};
			return builder;
		},
		update(table: unknown) {
			let updateValues: Partial<RuntimeEventRow & ArtifactRow> = {};
			let whereClause: unknown;
			return {
				set(value: Partial<RuntimeEventRow & ArtifactRow>) {
					updateValues = value;
					return this;
				},
				where(value: unknown) {
					whereClause = value;
					return this;
				},
				returning() {
					const target = table === tediRuntimeEvents ? events : artifacts;
					const matching = applyWhere(target, whereClause);
					for (const row of matching) {
						Object.assign(row, updateValues);
					}
					return Promise.resolve(matching);
				},
			};
		},
	};
}

function createContext(db: ReturnType<typeof createRuntimeDb>): BaseContext {
	const waitUntilPromises: Promise<unknown>[] = [];
	return {
		apiKey: {
			id: "api-key-1",
			name: "test",
			organizationId: ORG_ID,
			scopes: ["*"],
		},
		authType: "apikey",
		db: db as BaseContext["db"],
		env: {
			API_URL: "https://api.tedix.test",
			ENVIRONMENT: "test",
			TEDI_DEV_BASE_URL: "https://runtime.tedix.test",
		} as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/cognitive-runtime"),
		waitUntil: (promise) => {
			waitUntilPromises.push(promise);
		},
		waitUntilPromises,
	} as BaseContext & { waitUntilPromises: Promise<unknown>[] };
}

function createRuntimeClient(context: BaseContext) {
	return createRouterClient(cognitiveRuntimeContractRouter, { context });
}

function mockTedi(overrides: Record<string, unknown> = {}) {
	mocks.getTediById.mockResolvedValue({
		id: TEDI_ID,
		organizationId: ORG_ID,
		slug: "alpha",
		status: "active",
		runtimeKind: "agent",
		runtimeState: "active",
		runtimeStatus: null,
		lastActivityAt: null,
		lastHeartbeatAt: null,
		lastSeenAt: null,
		...overrides,
	});
}

describe("cognitive runtime router invariants", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		mocks.getApprovalRequestById.mockReset();
		mocks.getGatewayStability.mockReset();
		mocks.getAgentDiagnostics.mockReset();
		mocks.resolveApprovalRequest.mockReset();
		mocks.settleRepoCommitApprovalIfNeeded.mockReset();
		mocks.settleRepoCommitApprovalIfNeeded.mockResolvedValue(false);
		mocks.ensureActiveKernelHarnessVersion.mockResolvedValue({
			bumped: false,
			version: {
				id: "kernel-harness-v1",
				subjectKind: "kernel",
				subjectId: `kernel:${ORG_ID}`,
				orgId: ORG_ID,
				runtimeKind: "kernel",
				components: { workstation_egress: "runtime-event-v1" },
				version: "1",
				createdAt: "2026-05-25T08:00:00.000Z",
				updatedAt: "2026-05-25T08:00:00.000Z",
				promotionStatus: "active",
				promotedAt: null,
				evaluatedAt: null,
				evaluationSummary: null,
				traceSafetyPolicyId: null,
				metadata: null,
			},
		});
		mocks.recordHarnessSubjectTraceBundle.mockResolvedValue(undefined);
		mocks.requestSubmissionAbort.mockResolvedValue({
			requested: true,
			submission: undefined,
		});
		mockTedi();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("derives deterministic tedi-scoped event IDs without hardcoding runtime", () => {
		expect(
			runtimeEventId({
				conversationId: "agent:main:qa",
				kind: "message.completed",
				messageId: "message-1",
				runId: "run-1",
				runtimeBackend: "custom",
				sequence: 2,
				tediId: "tedi-1",
			}),
		).toBe(
			"runtime:tedi-1:event:custom:message.completed:agent:main:qa:run-1:message-1:2",
		);
	});

	it("keeps root runtime status fields while splitting canonical and backend diagnostics", () => {
		const status = TediRuntimeStatusSchema.parse({
			tediId: "tedi-1",
			backend: "cloudflare-agents",
			health: "starting",
			canonical: {
				health: "starting",
				lastActivityAt: null,
				lastHeartbeatAt: null,
				checkedAt: "2026-05-25T12:00:00.000Z",
			},
			lastActivityAt: null,
			lastHeartbeatAt: null,
			backendDiagnostics: {
				backend: "cloudflare-agents",
				kind: "lifecycle",
				health: "starting",
				statusDetail: "tracked_running_port_unreachable",
				processSummary: {
					gatewayLiveCount: 1,
					gatewayRunningCount: 1,
				},
				readiness: {
					httpStatus: 0,
					ready: false,
				},
			},
			diagnostics: {
				statusDetail: "tracked_running_port_unreachable",
			},
			checkedAt: "2026-05-25T12:00:00.000Z",
		});

		expect(status).toMatchObject({
			backend: "cloudflare-agents",
			health: "starting",
			canonical: {
				health: "starting",
			},
			backendDiagnostics: {
				backend: "cloudflare-agents",
				kind: "lifecycle",
				statusDetail: "tracked_running_port_unreachable",
				readiness: {
					httpStatus: 0,
					ready: false,
				},
			},
			diagnostics: {
				statusDetail: "tracked_running_port_unreachable",
			},
		});
	});

	it("accepts runtime-neutral stability diagnostics with backend-specific raw payload", () => {
		const stability = TediRuntimeStabilitySchema.parse({
			tediId: "tedi-1",
			backend: "cloudflare-agents",
			checkedAt: "2026-05-25T12:00:00.000Z",
			eventLoop: {
				delayMaxMs: 4.2,
				delayP99Ms: 1.1,
				elu: 0.12,
			},
			pluginHooks: { healthy: true },
			startup: { lastBootMs: 1234 },
			tasks: { queueDepth: 0 },
			raw: { extraBackendField: "value" },
		});
		expect(stability.backend).toBe("cloudflare-agents");
		expect(stability.eventLoop?.delayMaxMs).toBe(4.2);
		expect(stability.raw).toMatchObject({ extraBackendField: "value" });
	});

	it("routes isolate stability through isolate diagnostics instead of runtime gateway probes", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		mockTedi({ runtimeKind: "agent" });
		mocks.getAgentDiagnostics.mockResolvedValue({
			ok: true,
			slug: "cpo",
			tediId: TEDI_ID,
			queue: { depth: 0 },
			schedules: { count: 2 },
			state: { identityLoaded: true },
		});

		const { stability } = await client.getStability({ tediId: TEDI_ID });

		expect(stability.backend).toBe("cloudflare-agents");
		expect(stability.tasks).toMatchObject({
			queue: { depth: 0 },
			schedules: { count: 2 },
			state: { identityLoaded: true },
		});
		expect(stability.tasks).not.toHaveProperty("compaction");
		expect(stability.raw).toMatchObject({
			source: "agent-diagnostics",
			ok: true,
		});
		expect(mocks.getAgentDiagnostics).toHaveBeenCalledTimes(1);
		expect(mocks.getGatewayStability).not.toHaveBeenCalled();
	});

	it("allows platform principals to inspect cross-org tedi runtime status", async () => {
		const db = createRuntimeDb();
		const context = createContext(db);
		context.apiKey = {
			id: "platform-key",
			name: "platform",
			organizationId: ORG_ID,
			scopes: ["platform:admin", "tedis:read"],
		};
		mockTedi({ organizationId: "org-acme", runtimeKind: "agent" });
		const client = createRuntimeClient(context);

		const { status } = await client.getStatus({ tediId: TEDI_ID });

		expect(status.tediId).toBe(TEDI_ID);
	});

	it("rejects cross-org tedi runtime status for non-platform principals", async () => {
		const db = createRuntimeDb();
		const context = createContext(db);
		context.apiKey = {
			id: "tenant-key",
			name: "tenant",
			organizationId: ORG_ID,
			scopes: ["tedis:read"],
		};
		mockTedi({ organizationId: "org-acme", runtimeKind: "agent" });
		const client = createRuntimeClient(context);

		await expect(client.getStatus({ tediId: TEDI_ID })).rejects.toThrow(
			/Access denied to this tedi/,
		);
	});

	it("allows trusted tedix-unified service-binding calls to inspect cross-org tedi runtime status", async () => {
		const db = createRuntimeDb();
		const context = createContext(db);
		context.apiKey = undefined;
		context.authType = undefined;
		context.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Tedi-Scopes": "tedis:read",
			"X-Tedix-Mcp-App-Slug": "tedix-unified",
			"X-Tedix-Org-Id": ORG_ID,
		});
		mockTedi({ organizationId: "org-acme", runtimeKind: "agent" });
		const client = createRuntimeClient(context);

		const { status } = await client.getStatus({ tediId: TEDI_ID });

		expect(status.tediId).toBe(TEDI_ID);
	});

	it("rejects customer unified service-binding calls for cross-org tedi runtime status", async () => {
		const db = createRuntimeDb();
		const context = createContext(db);
		context.apiKey = undefined;
		context.authType = undefined;
		context.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Tedi-Scopes": "tedis:read",
			"X-Tedix-Mcp-App-Slug": "acme-unified",
			"X-Tedix-Org-Id": ORG_ID,
		});
		mockTedi({ organizationId: "org-acme", runtimeKind: "agent" });
		const client = createRuntimeClient(context);

		await expect(client.getStatus({ tediId: TEDI_ID })).rejects.toThrow(
			/Access denied to this tedi/,
		);
	});

	it("summary listEvents sheds payload and truncates delta, schema-intact", async () => {
		// A scanning agent never needs the payload/delta bulk of raw events.
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "message.completed" as const,
			conversationId: "agent:main:qa",
			runId: "run-summary",
			messageId: "message-summary",
			delta: "x".repeat(1_000),
			payload: { role: "assistant", content: "y".repeat(5_000) },
			createdAt: "2026-05-25T08:00:00.000Z",
		});

		const compact = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			runId: "run-summary",
			summary: true,
			limit: 10,
		});
		expect(compact.events).toHaveLength(1);
		const event = compact.events[0]!;
		// Identity/kind/timestamps survive; the heavy optional fields are shed.
		expect(event).toMatchObject({
			kind: "message.completed",
			runId: "run-summary",
		});
		expect(event.payload).toBeUndefined();
		expect(event.delta?.length).toBeLessThanOrEqual(201);
		expect(event.delta?.endsWith("…")).toBe(true);

		// The full read is unchanged — summary is opt-in, never the new default.
		const full = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			runId: "run-summary",
			limit: 10,
		});
		expect(full.events[0]!.payload).toBeDefined();
		expect(full.events[0]!.delta).toHaveLength(1_000);
	});

	it("records runtime events idempotently and lists normalized ledger rows", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		const input = {
			tediId: TEDI_ID,
			kind: "message.completed" as const,
			conversationId: "agent:main:qa",
			runId: "run-1",
			messageId: "message-1",
			payload: { role: "assistant", content: "Done" },
			runtime: {
				backend: "custom" as const,
				externalId: "external-run-1",
				metadata: { source: "test" },
			},
			createdAt: "2026-05-25T08:00:00.000Z",
		};

		const first = await client.recordEvent(input);
		const second = await client.recordEvent(input);
		const listed = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			limit: 10,
		});

		expect(second.event.id).toBe(first.event.id);
		expect(mocks.updateTediRuntimeActivity).toHaveBeenCalledTimes(1);
		expect(mocks.updateTediRuntimeActivity).toHaveBeenCalledWith(
			expect.anything(),
			TEDI_ID,
			"2026-05-25T08:00:00.000Z",
			{ heartbeat: false },
		);
		expect(listed.events).toHaveLength(1);
		expect(listed.events[0]).toMatchObject({
			id: first.event.id,
			tediId: TEDI_ID,
			kind: "message.completed",
			conversationId: "agent:main:qa",
			runId: "run-1",
			messageId: "message-1",
			payload: { role: "assistant", content: "Done" },
			runtime: {
				backend: "custom",
				externalId: "external-run-1",
				metadata: { source: "test" },
			},
			createdAt: "2026-05-25T08:00:00.000Z",
		});
	});

	it("emits an opaque event cursor and rejects malformed cursors", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		for (const id of ["message-a", "message-b"]) {
			await client.recordEvent({
				tediId: TEDI_ID,
				kind: "message.completed",
				conversationId: "agent:main:cursor",
				messageId: id,
				createdAt: "2026-05-25T08:00:00.000Z",
			});
		}

		const first = await client.listEvents({ tediId: TEDI_ID, limit: 1 });
		expect(first.nextBefore).toBeTruthy();
		expect(decodeRuntimeEventCursor(first.nextBefore!)).toMatchObject({
			createdAt: "2026-05-25T08:00:00.000Z",
		});
		await expect(
			client.listEvents({ tediId: TEDI_ID, before: "not-a-cursor" }),
		).rejects.toThrow();
		expect(RuntimeEventCursorSchema.safeParse("A".repeat(4_097)).success).toBe(
			false,
		);
		// `_w` is valid base64url for one invalid UTF-8 byte; fatal decoding must
		// reject it rather than replacing the byte and accepting a changed value.
		expect(RuntimeEventCursorSchema.safeParse("_w").success).toBe(false);
		expect(RuntimeEventCursorSchema.safeParse("abcd=").success).toBe(false);
	});

	it("packages workstation egress events into kernel trace bundles", async () => {
		const db = createRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const client = createRuntimeClient(context);

		const result = await client.recordEvent({
			tediId: TEDI_ID,
			kind: "workstation.egress.deny",
			conversationId: "agent:main:qa",
			runId: "kernel-run-egress",
			payload: {
				decision: "deny",
				host: "app.tedix.dev",
				kernelRunId: "kernel-run-egress",
				leaseId: "lease-1",
				profileId: "general",
				reason: "internal_service",
				traceBundleId: "trace-bundle-live",
				traceId: "trace-live",
				workItemId: "work-item-1",
				workstationId: "workstation-1",
			},
			runtime: {
				backend: "custom",
				externalId: "workstation-1",
				metadata: {
					adapter: "cloudflare-sandbox-workstation",
					kernelRunId: "kernel-run-egress",
					profileId: "general",
					traceBundleId: "trace-bundle-live",
					traceId: "trace-live",
					workstationId: "workstation-1",
				},
			},
			createdAt: "2026-05-25T08:02:00.000Z",
		});
		await Promise.all(context.waitUntilPromises);

		expect(mocks.ensureActiveKernelHarnessVersion).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				components: { workstation_egress: "runtime-event-v1" },
				orgId: ORG_ID,
				reason: "workstation egress event observed",
			}),
		);
		expect(mocks.recordHarnessSubjectTraceBundle).toHaveBeenCalledTimes(1);
		const bundle = mocks.recordHarnessSubjectTraceBundle.mock.calls[0]?.[1];
		expect(bundle).toMatchObject({
			id: "kernel-run-egress:bundle",
			subjectKind: "kernel",
			subjectId: `kernel:${ORG_ID}`,
			tediId: null,
			orgId: ORG_ID,
			conversationId: "agent:main:qa",
			runId: "kernel-run-egress",
			harnessVersionId: "kernel-harness-v1",
			eventIds: [result.event.id],
			workstation: {
				profileId: "general",
				workstationId: "workstation-1",
				leaseId: "lease-1",
				sessionIds: [],
				participantIds: [TEDI_ID],
			},
			metadata: {
				source: "cognitiveRuntime.recordEvent",
				surface: "workstation.egress",
				delegatedTediId: TEDI_ID,
				egressEventIds: [result.event.id],
				egressTraceBundleId: "trace-bundle-live",
				traceId: "trace-live",
				decision: "deny",
				host: "app.tedix.dev",
				reason: "internal_service",
				workItemId: "work-item-1",
				bodyExecutionResult: expect.objectContaining({
					bodyKind: "workstation-egress",
					status: "completed",
					runId: "kernel-run-egress",
					tediId: TEDI_ID,
					traceBundleId: "kernel-run-egress:bundle",
					structuredResult: expect.objectContaining({
						eventId: result.event.id,
						kind: "workstation.egress.deny",
						egressTraceBundleId: "trace-bundle-live",
						traceId: "trace-live",
					}),
				}),
			},
		});
		expect(JSON.stringify(bundle)).not.toContain("token=");
	});

	it("promotes runtime health events into the heartbeat clock only", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "runtime.health_changed",
			conversationId: "agent:main:qa",
			runId: "run-health",
			payload: { health: "healthy" },
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-05-25T08:01:00.000Z",
		});

		expect(mocks.updateTediRuntimeActivity).toHaveBeenCalledWith(
			expect.anything(),
			TEDI_ID,
			"2026-05-25T08:01:00.000Z",
			{ heartbeat: true },
		);
	});

	it("blocks expired approval resolution before updating the approval row", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		mocks.getApprovalRequestById.mockResolvedValue({
			id: "approval-1",
			status: "pending",
			expiresAt: "2000-01-01T00:00:00.000Z",
		});

		await expect(
			client.approve({
				tediId: TEDI_ID,
				approvalRequestId: "approval-1",
				approved: true,
			}),
		).rejects.toThrow(/timeout policy defaulted to deny/);

		expect(mocks.resolveApprovalRequest).not.toHaveBeenCalled();
		expect(db.events).toHaveLength(0);
	});

	it("records an approval.resolved event only after the approval row latch succeeds", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		mocks.getApprovalRequestById.mockResolvedValue({
			id: "approval-2",
			status: "pending",
			expiresAt: "2999-01-01T00:00:00.000Z",
		});
		mocks.resolveApprovalRequest.mockResolvedValue({
			id: "approval-2",
			tediId: TEDI_ID,
			actionType: "workstation.attach",
		});

		const result = await client.approve({
			tediId: TEDI_ID,
			approvalRequestId: "approval-2",
			approved: true,
			resolution: "approved by test",
		});

		expect(mocks.resolveApprovalRequest).toHaveBeenCalledWith(
			expect.anything(),
			"approval-2",
			expect.objectContaining({
				status: "approved",
				resolution: "approved by test",
			}),
		);
		expect(result.event).toMatchObject({
			kind: "approval.resolved",
			approvalRequestId: "approval-2",
			payload: {
				status: "approved",
				approved: true,
				resolution: "approved by test",
			},
		});
		expect(db.events).toHaveLength(1);
		expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: ORG_ID,
				actorId: "api-key-1",
				actorType: "api_key",
				action: "approval.approved",
				resourceType: "approval_request",
				resourceId: "approval-2",
				metadata: expect.objectContaining({
					tediId: TEDI_ID,
					actionType: "workstation.attach",
					approvalStatus: "approved",
					resolution: "approved by test",
					runtimeEventId: result.event.id,
				}),
			}),
		);
	});

	it("routes repo_commit_write approvals through the shared settle hook", async () => {
		const db = createRuntimeDb();
		const context = createContext(db);
		const client = createRuntimeClient(context);
		const resolvedApproval = {
			id: "approval-repo-commit",
			tediId: TEDI_ID,
			orgId: ORG_ID,
			actionType: "home.tool_write",
			payload: {
				kind: REPO_COMMIT_WRITE_KIND,
				organizationId: ORG_ID,
				tediId: TEDI_ID,
				conversationId: "home:repo",
				homeRunId: null,
				owner: "tedix-hq",
				repo: "tedix",
				baseRef: "main",
				branch: "codex/repo-commit-smoke",
				message: "docs: smoke",
				openPr: false,
				prBase: null,
				changeSummary: {
					fileCount: 1,
					addedOrModified: ["docs/tedi/README.md"],
					deleted: [],
					totalBytes: 128,
				},
				riskTier: "high",
				executionLedgerId: "ledger-repo-commit",
			},
			status: "approved",
			expiresAt: "2999-01-01T00:00:00.000Z",
		};
		mocks.getApprovalRequestById.mockResolvedValue({
			...resolvedApproval,
			status: "pending",
		});
		mocks.resolveApprovalRequest.mockResolvedValue(resolvedApproval);

		await client.approve({
			tediId: TEDI_ID,
			approvalRequestId: "approval-repo-commit",
			approved: true,
			resolution: "approved by test",
		});

		expect(mocks.settleRepoCommitApprovalIfNeeded).toHaveBeenCalledWith(
			context,
			{
				approval: resolvedApproval,
				status: "approved",
			},
		);
	});

	it("promotes the longest-content delta when runtime emits cumulative streams", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		// runtime's assistant stream emits CUMULATIVE deltas: each frame
		// carries the full running text up to that point. The promoter must
		// pick the longest-content delta (not concatenate them and not just
		// pick the latest by createdAt — a trailing empty delta would win
		// and truncate the reply).
		const cumulative = [
			"The ",
			"The cognitive ",
			"The cognitive runtime ",
			"The cognitive runtime ledger ",
			"The cognitive runtime ledger is OK.",
		];
		for (let i = 0; i < cumulative.length; i++) {
			await client.recordEvent({
				tediId: TEDI_ID,
				kind: "message.delta",
				conversationId: "agent:main:qa",
				runId: "run-live",
				messageId: "assistant:run-live",
				delta: cumulative[i],
				payload: { role: "assistant", content: cumulative[i] },
				runtime: {
					backend: "cloudflare-agents",
					metadata: { source: "tedix-context-agent-event-subscription" },
				},
				createdAt: `2026-05-25T08:00:0${i + 1}.000Z`,
			});
		}
		// Simulate the trailing empty delta that the previous bug was tripping
		// over — promoter must skip it via the length comparison.
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "message.delta",
			conversationId: "agent:main:qa",
			runId: "run-live",
			messageId: "assistant:run-live",
			delta: "",
			payload: { role: "assistant", content: "" },
			runtime: {
				backend: "cloudflare-agents",
				metadata: { source: "tedix-context-agent-event-subscription" },
			},
			createdAt: "2026-05-25T08:00:08.000Z",
		});
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:qa",
			runId: "run-live",
			payload: { status: "completed" },
			runtime: {
				backend: "cloudflare-agents",
				metadata: { source: "tedix-context-agent-event-subscription" },
			},
			createdAt: "2026-05-25T08:00:09.000Z",
		});

		const events = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			limit: 20,
		});
		const completed = events.events.find(
			(event) => event.kind === "message.completed",
		);
		expect(completed).toMatchObject({
			conversationId: "agent:main:qa",
			kind: "message.completed",
			messageId: "assistant:run-live",
			payload: {
				content: "The cognitive runtime ledger is OK.",
				role: "assistant",
			},
			runId: "run-live",
			runtime: {
				backend: "cloudflare-agents",
				externalId: "run-live",
				metadata: {
					source: "cognitiveRuntime.deltaCompletionPromotion",
				},
			},
		});

		const messages = await client.readMessages({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			limit: 10,
		});
		expect(messages.messages).toEqual([
			expect.objectContaining({
				content: "The cognitive runtime ledger is OK.",
				id: "assistant:run-live",
				role: "assistant",
				status: "completed",
			}),
		]);
	});

	it("recovers the full message when runtime emits mixed cumulative + chunked deltas with trailing fragments (regression: f5048ecf)", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		// Replay of the f5048ecf production ledger: mostly cumulative
		// deltas (sequences carrying growing prefixes of the full text)
		// but the bridge re-emits some sequences with both a cumulative
		// row AND a short chunk fragment, and the FINAL sequence is a
		// short chunk fragment ("8l") that, under the naive
		// last-by-createdAt picker, would truncate the reply to two
		// characters. The promoter must pick the longest cumulative
		// delta — the assembled full message.
		const fixtures: Array<{ sequence: number; delta: string }> = [
			{ sequence: 1, delta: "L" },
			{ sequence: 2, delta: "LIVE" },
			{ sequence: 3, delta: "LIVE_" },
			{ sequence: 4, delta: "LIVE_SMOKE" },
			{ sequence: 5, delta: "LIVE_SMOKE_OK" },
			{ sequence: 6, delta: "LIVE_SMOKE_OK mpl" },
			{ sequence: 7, delta: "LIVE_SMOKE_OK mpl7" },
			{ sequence: 7, delta: "LIVE_SMOKE_OK mpl7" },
			{ sequence: 8, delta: "LIVE_SMOKE_OK mpl7kt" },
			{ sequence: 8, delta: "_SMOKE_OK mpl7kt" },
			{ sequence: 8, delta: "LIVE_SMOKE_OK mpl7kt" },
			{ sequence: 9, delta: "LIVE_SMOKE_OK mpl7kt8" },
			{ sequence: 10, delta: "LIVE_SMOKE_OK mpl7kt8l" },
			{ sequence: 10, delta: "LIVE_SMOKE_OK mpl7kt8l" },
			{ sequence: 11, delta: "8l" },
		];
		for (let i = 0; i < fixtures.length; i++) {
			const f = fixtures[i];
			await client.recordEvent({
				tediId: TEDI_ID,
				kind: "message.delta",
				conversationId: "agent:main:f5048ecf",
				runId: "f5048ecf",
				messageId: "assistant:f5048ecf",
				sequence: f.sequence,
				delta: f.delta,
				payload: { role: "assistant" },
				runtime: {
					backend: "cloudflare-agents",
					metadata: { source: "tedix-context-agent-event-subscription" },
				},
				createdAt: `2026-05-25T13:00:${String(i).padStart(2, "0")}.000Z`,
			});
		}
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:f5048ecf",
			runId: "f5048ecf",
			payload: { status: "completed" },
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-05-25T13:01:00.000Z",
		});

		const events = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "agent:main:f5048ecf",
			limit: 50,
		});
		const completed = events.events.find((e) => e.kind === "message.completed");
		expect(completed?.payload).toMatchObject({
			role: "assistant",
			content: "LIVE_SMOKE_OK mpl7kt8l",
		});
	});

	it("ignores a trailing chunk fragment when the cumulative chain already has the full reply (regression: 49bc21a9)", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		// 49bc21a9 production replay: 70-char cumulative reply, then a
		// trailing 9-char chunk fragment "IX-LANDED" — buggy promoter
		// picked the 9-char chunk.
		const cumulative = [
			"S",
			"Saw this",
			"Saw this in chat.",
			"Saw this in chat. Model: TEDIX-LANDED",
			"Saw this in chat. Model: TEDIX-LANDED on tedi runtime ledger today.",
			"Saw this in chat. Model: TEDIX-LANDED on tedi runtime ledger today.",
		];
		for (let i = 0; i < cumulative.length; i++) {
			await client.recordEvent({
				tediId: TEDI_ID,
				kind: "message.delta",
				conversationId: "agent:main:49bc21a9",
				runId: "49bc21a9",
				messageId: "assistant:49bc21a9",
				sequence: i + 1,
				delta: cumulative[i],
				payload: { role: "assistant" },
				runtime: { backend: "cloudflare-agents" },
				createdAt: `2026-05-25T13:10:${String(i).padStart(2, "0")}.000Z`,
			});
		}
		// Trailing chunk fragment — must not win.
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "message.delta",
			conversationId: "agent:main:49bc21a9",
			runId: "49bc21a9",
			messageId: "assistant:49bc21a9",
			sequence: cumulative.length + 1,
			delta: "IX-LANDED",
			payload: { role: "assistant" },
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-05-25T13:10:30.000Z",
		});
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:49bc21a9",
			runId: "49bc21a9",
			payload: { status: "completed" },
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-05-25T13:10:31.000Z",
		});

		const events = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "agent:main:49bc21a9",
			limit: 50,
		});
		const completed = events.events.find((e) => e.kind === "message.completed");
		expect(completed?.payload).toMatchObject({
			content:
				"Saw this in chat. Model: TEDIX-LANDED on tedi runtime ledger today.",
		});
	});

	it("concatenates per-sequence fragments when runtime emits a purely chunked stream", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		// Purely chunked: every delta is a NEW fragment, never a prefix
		// extension of the previous. The longest single chunk is shorter
		// than the assembled message, so picking the longest delta is
		// wrong — the promoter must detect chunked mode and concatenate.
		const chunks = ["Hello, ", "this is ", "a chunked ", "completion."];
		for (let i = 0; i < chunks.length; i++) {
			await client.recordEvent({
				tediId: TEDI_ID,
				kind: "message.delta",
				conversationId: "agent:main:chunked",
				runId: "run-chunked",
				messageId: "assistant:run-chunked",
				sequence: i + 1,
				delta: chunks[i],
				payload: { role: "assistant" },
				runtime: { backend: "cloudflare-agents" },
				createdAt: `2026-05-25T13:20:${String(i).padStart(2, "0")}.000Z`,
			});
		}
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:chunked",
			runId: "run-chunked",
			payload: { status: "completed" },
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-05-25T13:20:10.000Z",
		});

		const events = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "agent:main:chunked",
			limit: 50,
		});
		const completed = events.events.find((e) => e.kind === "message.completed");
		expect(completed?.payload).toMatchObject({
			content: "Hello, this is a chunked completion.",
			assemblyMode: "chunked",
		});
	});

	it("repairs an early completed assistant message when deltas keep arriving after run completion", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "message.delta",
			conversationId: "agent:main:late-deltas",
			runId: "run-late-deltas",
			messageId: "assistant:run-late-deltas",
			sequence: 1,
			delta: "ce",
			payload: { role: "assistant" },
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-06-13T19:17:58.000Z",
		});
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:late-deltas",
			runId: "run-late-deltas",
			payload: { status: "completed" },
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-06-13T19:17:59.000Z",
		});
		let messages = await client.readMessages({
			tediId: TEDI_ID,
			conversationId: "agent:main:late-deltas",
			limit: 20,
		});
		expect(messages.messages).toEqual([
			expect.objectContaining({
				content: "ce",
				role: "assistant",
				status: "completed",
			}),
		]);

		for (const [index, delta] of ["o-confirm-", "1781378276753"].entries()) {
			await client.recordEvent({
				tediId: TEDI_ID,
				kind: "message.delta",
				conversationId: "agent:main:late-deltas",
				runId: "run-late-deltas",
				messageId: "assistant:run-late-deltas",
				sequence: index + 2,
				delta,
				payload: { role: "assistant" },
				runtime: { backend: "cloudflare-agents" },
				createdAt: `2026-06-13T19:18:0${index}.000Z`,
			});
		}

		messages = await client.readMessages({
			tediId: TEDI_ID,
			conversationId: "agent:main:late-deltas",
			limit: 20,
		});
		expect(messages.messages).toEqual([
			expect.objectContaining({
				content: "ceo-confirm-1781378276753",
				role: "assistant",
				status: "completed",
				metadata: expect.objectContaining({
					assemblyMode: "chunked",
					deltaCount: 3,
					repairedCompletedEventId: expect.any(String),
				}),
			}),
		]);
		expect(
			db.events.filter((event) => event.kind === "message.completed"),
		).toHaveLength(1);
	});

	it("promotes nested full runtime message text when delta text is only a short token", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "message.delta",
			conversationId: "agent:main:short-token",
			runId: "run-short-token",
			messageId: "assistant:run-short-token",
			sequence: 1,
			delta: "gateway",
			payload: {
				role: "assistant",
				text: "gateway",
				data: {
					message: {
						content: "gateway-event-builder-live-1781378888862",
						role: "assistant",
					},
				},
			},
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-06-13T19:17:58.000Z",
		});
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:short-token",
			runId: "run-short-token",
			payload: { status: "completed" },
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-06-13T19:17:59.000Z",
		});

		const messages = await client.readMessages({
			tediId: TEDI_ID,
			conversationId: "agent:main:short-token",
			limit: 20,
		});
		expect(messages.messages).toEqual([
			expect.objectContaining({
				content: "gateway-event-builder-live-1781378888862",
				role: "assistant",
				status: "completed",
			}),
		]);
	});

	it("reads lowercase runtime agent session rows from mixed-case agent session input", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "message.completed",
			conversationId: "agent:main:gatewayeventbuilder1781378974964",
			runId: "run-normalized-session",
			messageId: "assistant:run-normalized-session",
			payload: {
				role: "assistant",
				content: "GATEWAYEVENTBUILDER1781378974964",
			},
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-06-13T19:18:59.000Z",
		});

		const messages = await client.readMessages({
			tediId: TEDI_ID,
			conversationId: "agent:MAIN:GATEWAYEVENTBUILDER1781378974964",
			limit: 20,
		});
		expect(messages.messages).toEqual([
			expect.objectContaining({
				content: "GATEWAYEVENTBUILDER1781378974964",
				conversationId: "agent:main:gatewayeventbuilder1781378974964",
				role: "assistant",
			}),
		]);

		const events = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "agent:MAIN:GATEWAYEVENTBUILDER1781378974964",
			limit: 20,
		});
		expect(events.events).toEqual([
			expect.objectContaining({
				conversationId: "agent:main:gatewayeventbuilder1781378974964",
				kind: "message.completed",
			}),
		]);
	});

	it("assembles in-flight chunked deltas for readMessages instead of rendering only the latest fragment", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		const chunks = ["LOCAL", "_CTO", "_CANONICAL", "_1780348002648", " ok"];
		for (let i = 0; i < chunks.length; i++) {
			await client.recordEvent({
				tediId: TEDI_ID,
				kind: "message.delta",
				conversationId: "agent:main:local-canonical",
				runId: "run-local-canonical",
				messageId: "assistant:run-local-canonical",
				sequence: i + 1,
				delta: chunks[i],
				payload: { role: "assistant" },
				runtime: {
					backend: "cloudflare-agents",
					metadata: { source: "gateway-backend-subscription" },
				},
				createdAt: `2026-06-01T21:07:${String(i).padStart(2, "0")}.000Z`,
			});
		}

		const messages = await client.readMessages({
			tediId: TEDI_ID,
			conversationId: "agent:main:local-canonical",
			limit: 20,
		});

		expect(messages.messages).toEqual([
			expect.objectContaining({
				id: "assistant:run-local-canonical",
				role: "assistant",
				status: "pending",
				content: "LOCAL_CTO_CANONICAL_1780348002648 ok",
				startedAt: "2026-06-01T21:07:00.000Z",
			}),
		]);
	});

	it("collapses cumulative-prefix runs across turn boundaries (regression: 9f25f47e — runId carrying multiple assistant turns)", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		// Same runId carrying TWO assistant turns. Each turn restarts
		// cumulative from "". Raw per-delta concat would produce
		// "Hi — there.Hi —Hi — again."; longest-delta would lose turn 1.
		// Expected: longest cumulative per turn, joined.
		const stream: string[] = [
			"Hi —",
			"Hi — there.",
			// turn boundary — non-prefix
			"Hi —",
			"Hi — again.",
		];
		for (let i = 0; i < stream.length; i++) {
			await client.recordEvent({
				tediId: TEDI_ID,
				kind: "message.delta",
				conversationId: "agent:main:9f25f47e",
				runId: "9f25f47e",
				messageId: "assistant:9f25f47e",
				sequence: i + 1,
				delta: stream[i],
				payload: { role: "assistant" },
				runtime: { backend: "cloudflare-agents" },
				createdAt: `2026-05-27T12:49:${String(i).padStart(2, "0")}.000Z`,
			});
		}
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:9f25f47e",
			runId: "9f25f47e",
			payload: { status: "completed" },
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-05-27T12:49:10.000Z",
		});

		const events = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "agent:main:9f25f47e",
			limit: 50,
		});
		const completed = events.events.find((e) => e.kind === "message.completed");
		expect(completed?.payload).toMatchObject({
			content: "Hi — there.Hi — again.",
		});
	});

	it("recovers a 246-char cumulative stream punctuated by a short trailing fragment (regression: 0562024d)", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		const full =
			"Received AUDIT-FINAL-mpl2 marker — the cognitive runtime ledger has " +
			"successfully promoted the message.completed event with the full " +
			"accumulated assistant text rather than the last delta chunk. " +
			"Verifying end to end the audit message is preserved completely.";
		expect(full.length).toBeGreaterThanOrEqual(240);
		// 84 cumulative growing prefixes + the buggy trailing fragment.
		for (let i = 1; i <= 84; i++) {
			const slice = full.slice(0, Math.ceil((full.length * i) / 84));
			await client.recordEvent({
				tediId: TEDI_ID,
				kind: "message.delta",
				conversationId: "agent:main:0562024d",
				runId: "0562024d",
				messageId: "assistant:0562024d",
				sequence: i,
				delta: slice,
				payload: { role: "assistant" },
				runtime: { backend: "cloudflare-agents" },
				createdAt: `2026-05-25T13:30:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`,
			});
		}
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "message.delta",
			conversationId: "agent:main:0562024d",
			runId: "0562024d",
			messageId: "assistant:0562024d",
			sequence: 85,
			delta: " the audit message.",
			payload: { role: "assistant" },
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-05-25T13:31:00.000Z",
		});
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:0562024d",
			runId: "0562024d",
			payload: { status: "completed" },
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-05-25T13:31:01.000Z",
		});

		const events = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "agent:main:0562024d",
			limit: 200,
		});
		const completed = events.events.find((e) => e.kind === "message.completed");
		expect(completed?.payload).toMatchObject({ content: full });
	});

	it("resolves the conversation when resident completion events only carry a run id", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.started",
			conversationId: "agent:main:qa",
			runId: "run-resident",
			payload: { status: "started" },
			runtime: {
				backend: "cloudflare-agents",
				metadata: { source: "os.chat" },
			},
			createdAt: "2026-05-25T08:00:00.000Z",
		});
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "message.delta",
			runId: "run-resident",
			messageId: "assistant:run-resident",
			delta: "Resident-only final content",
			payload: {
				role: "assistant",
				content: "Resident-only final content",
			},
			runtime: {
				backend: "cloudflare-agents",
				metadata: { source: "tedix-context-agent-event-subscription" },
			},
			createdAt: "2026-05-25T08:00:02.000Z",
		});
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			runId: "run-resident",
			payload: { status: "completed" },
			runtime: {
				backend: "cloudflare-agents",
				metadata: { source: "tedix-context-agent-event-subscription" },
			},
			createdAt: "2026-05-25T08:00:03.000Z",
		});

		const events = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			limit: 10,
		});
		expect(events.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					conversationId: "agent:main:qa",
					kind: "message.completed",
					messageId: "assistant:run-resident",
					payload: expect.objectContaining({
						content: "Resident-only final content",
					}),
					runId: "run-resident",
				}),
			]),
		);
	});

	it("dedups a promoted message.completed when a real one already exists for the same runId", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		// Pre-seed a real `message.completed` straight into the ledger to
		// simulate the resident `tedix-context` agent-event subscription
		// having already written the canonical terminal frame for this run.
		await db.insert(tediRuntimeEvents).values({
			id: "real-message-completed",
			organizationId: ORG_ID,
			tediId: TEDI_ID,
			kind: "message.completed",
			conversationId: "agent:main:qa",
			runId: "run-dup",
			messageId: "real-message-id",
			payload: {
				role: "assistant",
				content: "Real terminal frame from runtime",
			},
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-05-25T08:00:05.000Z",
		});

		// Now feed a delta + run.completed for the SAME runId. Without the
		// guard, the promoter at `run.completed` would synthesize a second
		// `message.completed` with a different deterministic id (different
		// messageId + createdAt → different id), and the ledger would carry
		// two terminal rows for one run.
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "message.delta",
			conversationId: "agent:main:qa",
			runId: "run-dup",
			messageId: "assistant:run-dup",
			delta: "Promoted from delta",
			payload: { role: "assistant", content: "Promoted from delta" },
			runtime: {
				backend: "cloudflare-agents",
				metadata: { source: "tedix-context-agent-event-subscription" },
			},
			createdAt: "2026-05-25T08:00:06.000Z",
		});
		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:qa",
			runId: "run-dup",
			payload: { status: "completed" },
			runtime: {
				backend: "cloudflare-agents",
				metadata: { source: "tedix-context-agent-event-subscription" },
			},
			createdAt: "2026-05-25T08:00:07.000Z",
		});

		// Also send a second `message.completed` via the recordEvent handler
		// for the same run (with a *different* messageId, so the deterministic
		// id wouldn't collide). The insert-boundary guard must reject this too.
		const repeat = await client.recordEvent({
			tediId: TEDI_ID,
			kind: "message.completed",
			conversationId: "agent:main:qa",
			runId: "run-dup",
			messageId: "alternate-message-id",
			payload: {
				role: "assistant",
				content: "Duplicate from a second emitter",
			},
			runtime: { backend: "cloudflare-agents", metadata: { source: "test" } },
			createdAt: "2026-05-25T08:00:08.000Z",
		});

		// Exactly one `message.completed` for this run — the original.
		const completed = db.events.filter(
			(row) => row.kind === "message.completed" && row.runId === "run-dup",
		);
		expect(completed).toHaveLength(1);
		expect(completed[0]?.id).toBe("real-message-completed");
		expect(repeat.event.id).toBe("real-message-completed");
	});

	it("dedups run lifecycle events from parallel writers with different ids", async () => {
		// Three independent writers race for the same run.started /
		// run.completed event with different canonical ids — the resident tedix-context plugin
		// (id prefix `runtime-agent:`), the gateway-ws-proxy Tedix OS-mirror path
		// (id prefix `runtime:event:agent:`), and API enqueue pre-recording
		// (id prefix `runtime:event:agent:run.started:`). The id-uniqueness
		// gate can't catch these. The single insert boundary must.
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		// Writer 1: the API enqueue path pre-records run.started before any
		// runtime frames arrive.
		await client.recordEvent({
			id: "runtime:tedi:event:agent:run.started:agent:main:main:run-dup-lifecycle:msg-1:2026-05-25T08:00:00.000Z",
			tediId: TEDI_ID,
			kind: "run.started",
			conversationId: "agent:main:main",
			runId: "run-dup-lifecycle",
			messageId: "msg-1",
			payload: { status: "queued", inputMessageId: "msg-1" },
			runtime: {
				backend: "cloudflare-agents",
				externalId: "run-dup-lifecycle",
				metadata: { source: "os.chat", dispatch: "tedi.gateway.chat.send" },
			},
			createdAt: "2026-05-25T08:00:00.000Z",
		});

		// Writer 2: resident tedix-context plugin posts the lifecycle event
		// from inside the container with its own deterministic id.
		await client.recordEvent({
			id: "runtime-agent:tedi:run-dup-lifecycle:lifecycle:1",
			tediId: TEDI_ID,
			kind: "run.started",
			conversationId: "agent:main:main",
			runId: "run-dup-lifecycle",
			sequence: 1,
			payload: {
				data: { phase: "start", startedAt: 1779740231430 },
				stream: "lifecycle",
			},
			runtime: {
				backend: "cloudflare-agents",
				metadata: {
					source: "tedix-context-agent-event-subscription",
					stream: "lifecycle",
				},
			},
			createdAt: "2026-05-25T08:00:01.000Z",
		});

		// Writer 3: Tedix OS-browser mirrors the gateway WS frame through
		// `/api/chat/runtime-event` with the canonical toTediRuntimeEvent id
		// shape (no `source` field — payload passes through as-is).
		await client.recordEvent({
			id: "runtime:tedi:event:agent:agent:main:main:run-dup-lifecycle:1",
			tediId: TEDI_ID,
			kind: "run.started",
			conversationId: "agent:main:main",
			runId: "run-dup-lifecycle",
			sequence: 1,
			payload: {
				status: "running",
				progress: { phase: "start" },
				data: { phase: "start", startedAt: 1779740231430 },
			},
			runtime: {
				backend: "cloudflare-agents",
				metadata: {
					event: "agent",
					stream: "lifecycle",
					raw: { runId: "run-dup-lifecycle", stream: "lifecycle" },
				},
			},
			createdAt: "2026-05-25T08:00:02.000Z",
		});

		// Same three writers for run.completed.
		await client.recordEvent({
			id: "runtime-agent:tedi:run-dup-lifecycle:lifecycle:177",
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:main",
			runId: "run-dup-lifecycle",
			sequence: 177,
			payload: { status: "completed" },
			runtime: {
				backend: "cloudflare-agents",
				metadata: { source: "tedix-context-agent-event-subscription" },
			},
			createdAt: "2026-05-25T08:00:10.000Z",
		});
		await client.recordEvent({
			id: "runtime:tedi:event:agent:agent:main:main:run-dup-lifecycle:177",
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:main",
			runId: "run-dup-lifecycle",
			sequence: 177,
			payload: { status: "completed" },
			runtime: {
				backend: "cloudflare-agents",
				metadata: { event: "agent", stream: "lifecycle" },
			},
			createdAt: "2026-05-25T08:00:11.000Z",
		});

		// Exactly one row per lifecycle kind, regardless of how many writers
		// posted. The winning row is the FIRST writer through the boundary.
		const started = db.events.filter(
			(row) => row.kind === "run.started" && row.runId === "run-dup-lifecycle",
		);
		const completed = db.events.filter(
			(row) =>
				row.kind === "run.completed" && row.runId === "run-dup-lifecycle",
		);
		expect(started).toHaveLength(1);
		expect(completed).toHaveLength(1);
		expect(started[0]?.runtimeMetadata).toMatchObject({ source: "os.chat" });
		expect(completed[0]?.runtimeMetadata).toMatchObject({
			source: "tedix-context-agent-event-subscription",
		});
	});

	it("reads durable messages from received, delta, completed, and run completion events", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		await db.insert(tediRuntimeEvents).values([
			{
				id: "event-user",
				organizationId: ORG_ID,
				tediId: TEDI_ID,
				kind: "message.received",
				conversationId: "agent:main:qa",
				runId: "run-user",
				messageId: "message-user",
				payload: { role: "user", content: "Please check this" },
				runtimeBackend: "cloudflare-agents",
				createdAt: "2026-05-25T08:00:00.000Z",
			},
			{
				id: "event-delta-1",
				organizationId: ORG_ID,
				tediId: TEDI_ID,
				kind: "message.delta",
				conversationId: "agent:main:qa",
				runId: "run-pending",
				messageId: "message-assistant-pending",
				delta: "Working",
				payload: { role: "assistant" },
				runtimeBackend: "cloudflare-agents",
				createdAt: "2026-05-25T08:00:01.000Z",
			},
			{
				id: "event-delta-2",
				organizationId: ORG_ID,
				tediId: TEDI_ID,
				kind: "message.delta",
				conversationId: "agent:main:qa",
				runId: "run-pending",
				messageId: "message-assistant-pending",
				delta: "Working now",
				payload: { role: "assistant" },
				runtimeBackend: "cloudflare-agents",
				createdAt: "2026-05-25T08:00:02.000Z",
			},
			{
				id: "event-assistant",
				organizationId: ORG_ID,
				tediId: TEDI_ID,
				kind: "message.completed",
				conversationId: "agent:main:qa",
				runId: "run-done",
				messageId: "message-assistant-done",
				payload: {
					role: "assistant",
					content: "Finished",
					toolCallIds: ["tool-1"],
				},
				runtimeBackend: "cloudflare-agents",
				createdAt: "2026-05-25T08:00:03.000Z",
			},
			{
				id: "event-run-complete",
				organizationId: ORG_ID,
				tediId: TEDI_ID,
				kind: "run.completed",
				conversationId: "agent:main:qa",
				runId: "run-done",
				messageId: "message-user",
				payload: { status: "completed" },
				runtimeBackend: "cloudflare-agents",
				createdAt: "2026-05-25T08:00:04.000Z",
			},
		]);

		const result = await client.readMessages({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			limit: 20,
		});

		expect(result.messages).toEqual([
			expect.objectContaining({
				id: "message-user",
				role: "user",
				status: "pending",
				content: "Please check this",
				// Ψ5 Part B: user turns stamp `startedAt` from the
				// `message.received` row time directly.
				startedAt: "2026-05-25T08:00:00.000Z",
			}),
			expect.objectContaining({
				id: "assistant:run-pending",
				role: "assistant",
				status: "pending",
				content: "Working now",
				// Ψ5 Part B: in-flight assistant turn — `startedAt` lands on
				// the FIRST delta (08:00:01), not the latest (08:00:02), so
				// the WORKED FOR pill measures from first chunk on reload.
				startedAt: "2026-05-25T08:00:01.000Z",
			}),
			expect.objectContaining({
				id: "message-assistant-done",
				role: "assistant",
				status: "completed",
				content: "Finished",
				// Ψ5 Part B: completed-only turn (no preceding delta in this
				// fixture) — `startedAt` falls back to the `message.completed`
				// row time, yielding a "0s" pill rather than no pill.
				startedAt: "2026-05-25T08:00:03.000Z",
				completedAt: "2026-05-25T08:00:03.000Z",
				toolCallIds: ["tool-1"],
			}),
		]);
	});

	it("enqueue writes the input/run ledger and records dispatch failure", async () => {
		const db = createRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const client = createRuntimeClient(context);
		const randomUuid = vi
			.spyOn(crypto, "randomUUID")
			.mockReturnValueOnce("message-uuid");
		mocks.injectAgentMessage.mockResolvedValue({
			error: "runtime busy",
			success: false,
			session_key: "agent:main:qa",
		});

		const result = await client.enqueueMessage({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			content: "Can you inspect this?",
			idempotencyKey: "enqueue-key",
			metadata: { source: "test" },
		});
		await Promise.all(context.waitUntilPromises);

		const rows = await db
			.select()
			.from(tediRuntimeEvents)
			.orderBy(tediRuntimeEvents.createdAt);

		expect(result).toMatchObject({
			idempotencyKey: "enqueue-key",
			conversationId: "agent:main:qa",
			status: "failed",
			error: "runtime busy",
		});
		expect(mocks.enqueueRuntimeChatMessage).not.toHaveBeenCalled();
		expect(mocks.injectAgentMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				baseUrl: expect.stringContaining("alpha.tedi.tedix.tech"),
			}),
			expect.objectContaining({
				message: "Can you inspect this?",
				session: "agent:main:qa",
				clientRequestId: "enqueue-key",
				metadata: { source: "test" },
				async: true,
			}),
		);
		expect(rows.map((row) => row.kind)).toEqual(["run.failed"]);
		expect(rows[0]).toMatchObject({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			runId: "enqueue-key",
			messageId: "message-uuid",
		});
		expect(rows[0]?.payload).toEqual({
			error: "runtime busy",
			reason: "dispatch_failed",
		});
		randomUuid.mockRestore();
	});

	it("transcribes an isolate audio attachment and injects the transcript into the turn", async () => {
		const db = createRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const client = createRuntimeClient(context);
		mockTedi({ runtimeKind: "agent" });
		mocks.transcribeAudioAttachment.mockResolvedValue({
			text: "remind me to call the dentist",
			provider: "azure",
		});
		mocks.injectAgentMessage.mockResolvedValue({
			run_id: "alpha:mcp:isolate-enqueue-key",
			success: true,
			session_key: "agent:main:qa",
		});

		const result = await client.enqueueMessage({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			// Voice-note-only sends carry a minimal placeholder (the contract
			// requires non-empty content); `buildTranscriptContent` trims it so the
			// turn runs with just the transcript block.
			content: " ",
			idempotencyKey: "isolate-enqueue-key",
			attachments: [
				{
					content: "SGVsbG8=",
					durationMs: 5400,
					fileName: "voice.wav",
					mimeType: "audio/wav",
					size: 5,
					type: "audio",
				},
			],
		});
		await Promise.all(context.waitUntilPromises);

		// The isolate turn ran with the templated transcript, not the empty text.
		expect(mocks.injectAgentMessage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				message: "[Voice message transcript]\nremind me to call the dentist",
				session: "agent:main:qa",
				clientRequestId: "isolate-enqueue-key",
				async: true,
				attachments: [
					expect.objectContaining({
						durationMs: 5400,
						fileName: "voice.wav",
						mimeType: "audio/wav",
						size: 5,
						type: "audio",
					}),
				],
			}),
		);
		expect(result).toMatchObject({
			idempotencyKey: "isolate-enqueue-key",
			runId: "alpha:mcp:isolate-enqueue-key",
			status: "queued",
		});

		const rows = await db
			.select()
			.from(tediRuntimeEvents)
			.orderBy(tediRuntimeEvents.createdAt);
		const received = rows.find((r) => r.kind === "message.received");
		expect(received?.payload).toMatchObject({
			role: "user",
			content: "[Voice message transcript]\nremind me to call the dentist",
			metadata: {
				voiceTranscript: {
					transcript: "remind me to call the dentist",
					provider: "azure",
					fileName: "voice.wav",
					mimeType: "audio/wav",
				},
			},
		});
		// Audio attachment is retained as an event ref for forensics/replay.
		expect(
			(received?.payload as { attachments?: unknown[] } | undefined)
				?.attachments,
		).toEqual([
			expect.objectContaining({
				content: "data:audio/wav;base64,SGVsbG8=",
				durationMs: 5400,
				fileName: "voice.wav",
				size: 5,
			}),
		]);
	});

	it("fails soft when isolate transcription throws — runs the turn with a clear note", async () => {
		const db = createRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const client = createRuntimeClient(context);
		mockTedi({ runtimeKind: "agent" });
		mocks.transcribeAudioAttachment.mockRejectedValue(
			new Error("Azure STT failed (404)"),
		);
		mocks.injectAgentMessage.mockResolvedValue({
			success: true,
			session_key: "agent:main:qa",
		});

		await client.enqueueMessage({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			content: "here",
			idempotencyKey: "isolate-audio-fail-key",
			attachments: [
				{
					content: "SGVsbG8=",
					fileName: "voice.wav",
					mimeType: "audio/wav",
					type: "audio",
				},
			],
		});
		await Promise.all(context.waitUntilPromises);

		expect(mocks.injectAgentMessage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				message: "here\n\n[audio transcription failed: Azure STT failed (404)]",
				clientRequestId: "isolate-audio-fail-key",
				async: true,
				attachments: [
					expect.objectContaining({
						fileName: "voice.wav",
						mimeType: "audio/wav",
						type: "audio",
					}),
				],
			}),
		);
	});

	// soft-delete (`tedi_session_states.deletedAt`) must hide a conversation
	// from EVERY consumer (MCP/analytics/audit), not just the Tedix OS client.
	function seedConversation(
		db: ReturnType<typeof createRuntimeDb>,
		conversationId: string,
	) {
		db.events.push({
			id: `evt-${conversationId}`,
			organizationId: ORG_ID,
			tediId: TEDI_ID,
			kind: "message.received",
			conversationId,
			runId: "run-x",
			messageId: "msg-x",
			toolCallId: null,
			approvalRequestId: null,
			artifactId: null,
			sequence: null,
			delta: null,
			payload: { role: "user", content: `hi from ${conversationId}` },
			runtimeBackend: "cloudflare-agents",
			runtimeExternalId: null,
			runtimeExternalUrl: null,
			runtimeMetadata: null,
			createdAt: "2026-05-25T08:00:00.000Z",
		});
	}

	function seedCompaction(
		db: ReturnType<typeof createRuntimeDb>,
		input: {
			id: string;
			conversationId: string;
			createdAt: string;
			summary: string;
			checkpoint?: Record<string, unknown>;
		},
	) {
		db.events.push(
			normalizeRuntimeEventInsert({
				id: input.id,
				organizationId: ORG_ID,
				tediId: TEDI_ID,
				kind: "context.compacted",
				conversationId: input.conversationId,
				payload: {
					summary: input.summary,
					firstKeptEntryId: `${input.id}:kept`,
					tokensBefore: 12_345,
					...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
				},
				runtimeBackend: "cloudflare-agents",
				createdAt: input.createdAt,
			}),
		);
	}

	function softDelete(
		db: ReturnType<typeof createRuntimeDb>,
		sessionKey: string,
		overrides: Partial<SessionStateRow> = {},
	) {
		db.sessionStates.push({
			id: `state-${sessionKey}`,
			organizationId: overrides.organizationId ?? ORG_ID,
			tediId: overrides.tediId ?? TEDI_ID,
			userId: overrides.userId ?? "user-deleter",
			sessionKey,
			title: null,
			pinnedAt: null,
			// `?? null` would coerce an explicit `null` override back to the
			// default — distinguish "not provided" from "explicitly not deleted".
			deletedAt:
				"deletedAt" in overrides
					? (overrides.deletedAt ?? null)
					: "2026-05-25T09:00:00.000Z",
			lastSeenAt: null,
			createdAt: "2026-05-25T07:00:00.000Z",
			updatedAt: "2026-05-25T09:00:00.000Z",
		});
	}

	it("excludes soft-deleted conversations from listConversations (org-scoped)", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		seedConversation(db, "agent:main:keep");
		seedConversation(db, "agent:main:gone");
		// Deleted by a DIFFERENT user — org-scoped hiding applies regardless.
		softDelete(db, "agent:main:gone", { userId: "someone-else" });

		const list = await client.listConversations({ tediId: TEDI_ID });
		expect(list.conversations.map((c) => c.id)).toEqual(["agent:main:keep"]);
	});

	it("returns the latest durable compaction state without changing transcript messages", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		seedConversation(db, "agent:main:keep");
		seedCompaction(db, {
			id: "compaction-old",
			conversationId: "agent:main:keep",
			createdAt: "2026-05-25T08:01:00.000Z",
			summary: "Old summary",
		});
		seedCompaction(db, {
			id: "compaction-latest",
			conversationId: "agent:main:keep",
			createdAt: "2026-05-25T08:02:00.000Z",
			summary: "Latest summary",
			checkpoint: {
				version: 1,
				coveredThroughEntryId: "compaction-latest:covered",
				capabilityBindings: [],
				artifactRevisions: [],
				pendingApprovals: [],
				workReferences: [],
				toolResultDependencies: [],
				contextSources: [],
				truncated: false,
				checkpointDigest: `sha256:${"d".repeat(64)}`,
			},
		});
		seedCompaction(db, {
			id: "compaction-other",
			conversationId: "agent:main:other",
			createdAt: "2026-05-25T08:03:00.000Z",
			summary: "Wrong conversation",
		});

		const transcript = await client.readMessages({
			tediId: TEDI_ID,
			conversationId: "agent:main:keep",
		});

		expect(transcript.messages).toHaveLength(1);
		expect(transcript.messages[0]).toMatchObject({
			content: "hi from agent:main:keep",
			role: "user",
		});
		expect(transcript.compaction).toEqual({
			summary: "Latest summary",
			firstKeptEntryId: "compaction-latest:kept",
			tokensBefore: 12_345,
			createdAt: "2026-05-25T08:02:00.000Z",
			checkpoint: {
				version: 1,
				coveredThroughEntryId: "compaction-latest:covered",
				capabilityBindings: [],
				artifactRevisions: [],
				pendingApprovals: [],
				workReferences: [],
				toolResultDependencies: [],
				contextSources: [],
				truncated: false,
				checkpointDigest: `sha256:${"d".repeat(64)}`,
			},
		});
	});

	it("returns an empty transcript for a soft-deleted conversation in readMessages", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		seedConversation(db, "agent:main:gone");
		seedCompaction(db, {
			id: "compaction-deleted",
			conversationId: "agent:main:gone",
			createdAt: "2026-05-25T08:02:00.000Z",
			summary: "Must stay hidden",
		});
		softDelete(db, "agent:main:gone");

		const transcript = await client.readMessages({
			tediId: TEDI_ID,
			conversationId: "agent:main:gone",
		});
		expect(transcript.messages).toEqual([]);
		expect(transcript.compaction).toBeNull();
		expect(transcript.nextCursor).toBeNull();
	});

	it("does NOT hide a conversation whose session-state row is not soft-deleted", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		seedConversation(db, "agent:main:keep");
		// Pinned/titled but NOT deleted (deletedAt null) — must stay visible.
		softDelete(db, "agent:main:keep", { deletedAt: null });

		const list = await client.listConversations({ tediId: TEDI_ID });
		expect(list.conversations.map((c) => c.id)).toEqual(["agent:main:keep"]);
		const transcript = await client.readMessages({
			tediId: TEDI_ID,
			conversationId: "agent:main:keep",
		});
		expect(transcript.messages.length).toBe(1);
	});

	it("routes async enqueue for isolate tedis through isolate inject", async () => {
		mockTedi({ runtimeKind: "agent", isolateAgentId: "alpha" });
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		mocks.injectAgentMessage.mockResolvedValue({
			run_id: "alpha:mcp:isolate-enqueue-key",
			success: true,
			session_key: "agent:main:qa",
		});
		vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("message-uuid");

		const result = await client.enqueueMessage({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			content: "Durable isolate async send",
			idempotencyKey: "isolate-enqueue-key",
			metadata: { source: "test" },
		});

		expect(result).toMatchObject({
			idempotencyKey: "isolate-enqueue-key",
			conversationId: "agent:main:qa",
			runId: "alpha:mcp:isolate-enqueue-key",
			status: "queued",
		});
		expect(mocks.enqueueRuntimeChatMessage).not.toHaveBeenCalled();
		expect(mocks.injectAgentMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				baseUrl: expect.stringContaining("alpha.tedi.tedix.tech"),
			}),
			{
				message: "Durable isolate async send",
				session: "agent:main:qa",
				clientRequestId: "isolate-enqueue-key",
				metadata: { source: "test" },
				async: true,
			},
		);

		// Isolate async accept returns the real predicted run id, so the API can
		// safely expose the accepted user turn immediately without stranding rows
		// under the raw idempotency key.
		const events = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "alpha:agent:main:qa",
			limit: 20,
		});
		expect(events.events.map((event) => event.kind)).toEqual([
			"message.received",
			"run.started",
		]);
		const received = events.events.find(
			(event) => event.kind === "message.received",
		);
		expect(received).toMatchObject({
			id: "alpha:mcp:isolate-enqueue-key:0",
			runId: "alpha:mcp:isolate-enqueue-key",
			payload: {
				role: "user",
				content: "Durable isolate async send",
				metadata: { source: "test" },
			},
		});
	});

	it("canonicalizes short agent isolate conversation ids before inject", async () => {
		mockTedi({ runtimeKind: "agent", isolateAgentId: "alpha" });
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		mocks.injectAgentMessage.mockResolvedValue({
			run_id: "alpha:mcp:isolate-short-key",
			success: true,
			session_key: "agent:main:main",
		});

		const result = await client.enqueueMessage({
			tediId: TEDI_ID,
			conversationId: "agent:main",
			content: "Durable isolate async send",
			idempotencyKey: "isolate-short-key",
		});

		expect(result).toMatchObject({
			idempotencyKey: "isolate-short-key",
			conversationId: "agent:main:main",
			runId: "alpha:mcp:isolate-short-key",
			status: "queued",
		});
		expect(mocks.injectAgentMessage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				session: "agent:main:main",
				clientRequestId: "isolate-short-key",
				async: true,
			}),
		);

		const events = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "alpha:agent:main:main",
			limit: 20,
		});
		expect(events.events.map((event) => event.kind)).toEqual([
			"message.received",
			"run.started",
		]);
	});

	it("keeps isolate enqueue async without requiring a dispatchMode metadata hint", async () => {
		mockTedi({ runtimeKind: "agent", isolateAgentId: "alpha" });
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		// Async accept: the body queues the turn and returns 202 + the predicted
		// run id immediately, so a cold child's first turn is not capped by the
		// inject HTTP timeout.
		mocks.injectAgentMessage.mockResolvedValue({
			run_id: "alpha:mcp:isolate-enqueue-key",
			success: true,
			accepted: true,
			session_key: "agent:main:qa",
		});

		const result = await client.enqueueMessage({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			content: "Home delegated work order",
			idempotencyKey: "isolate-enqueue-key",
			metadata: { source: "kernelRuntime.delegate" },
		});

		expect(result).toMatchObject({
			runId: "alpha:mcp:isolate-enqueue-key",
			status: "queued",
		});
		// The async flag is forwarded so the body accepts + queues instead of
		// running the turn inline under the inject request lifetime.
		expect(mocks.injectAgentMessage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				message: "Home delegated work order",
				session: "agent:main:qa",
				clientRequestId: "isolate-enqueue-key",
				async: true,
			}),
		);
		const events = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "alpha:agent:main:qa",
			limit: 20,
		});
		expect(events.events.map((event) => event.kind)).toEqual([
			"message.received",
			"run.started",
		]);
		expect(events.events[0]?.runId).toBe("alpha:mcp:isolate-enqueue-key");
	});

	describe("ledger pre-admit", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("pre-admits under the SAME deterministic id the isolate's own run.started echo later reports", async () => {
			mockTedi({ runtimeKind: "agent", isolateAgentId: "alpha" });
			const db = createRuntimeDb();
			const client = createRuntimeClient(createContext(db));
			const recordSpy = vi.spyOn(
				runtimeSubmissionBridge,
				"recordTediSubmissionStarted",
			);
			mocks.injectAgentMessage.mockResolvedValue({
				run_id: "alpha:mcp:predict-match-key",
				success: true,
				session_key: "agent:main:qa",
			});

			await client.enqueueMessage({
				tediId: TEDI_ID,
				conversationId: "agent:main:qa",
				content: "Pre-admit parity check",
				idempotencyKey: "predict-match-key",
			});

			// First call is the pre-admit (before dispatch); it must predict the
			// EXACT id the isolate independently reports as `run_id` above — a
			// mismatch here would silently strand a phantom ledger row.
			expect(recordSpy.mock.calls[0]?.[1]).toMatchObject({
				tediId: TEDI_ID,
				runId: "alpha:mcp:predict-match-key",
			});
			// The choke-point admit (on run.started, elsewhere in the module) is
			// the second call, idempotent onto the SAME id — not a double-count.
			expect(recordSpy.mock.calls[1]?.[1]).toMatchObject({
				runId: "alpha:mcp:predict-match-key",
			});
		});

		it("settles the pre-admitted row failed when injectAgentMessage resolves success:false — never left stranded running", async () => {
			mockTedi({ runtimeKind: "agent", isolateAgentId: "alpha" });
			const db = createRuntimeDb();
			const client = createRuntimeClient(createContext(db));
			const settleSpy = vi.spyOn(
				runtimeSubmissionBridge,
				"settleTediSubmission",
			);
			mocks.injectAgentMessage.mockResolvedValue({
				success: false,
				error: "gateway rejected the turn",
			});

			const result = await client.enqueueMessage({
				tediId: TEDI_ID,
				conversationId: "agent:main:qa",
				content: "Dispatch rejection",
				idempotencyKey: "predict-reject-key",
			});

			expect(result.status).toBe("failed");
			expect(settleSpy).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					runId: "alpha:mcp:predict-reject-key",
					outcome: "failed",
				}),
			);
		});

		it("settles the pre-admitted row failed when injectAgentMessage throws", async () => {
			mockTedi({ runtimeKind: "agent", isolateAgentId: "alpha" });
			const db = createRuntimeDb();
			const client = createRuntimeClient(createContext(db));
			const settleSpy = vi.spyOn(
				runtimeSubmissionBridge,
				"settleTediSubmission",
			);
			mocks.injectAgentMessage.mockRejectedValue(
				new Error("network unreachable"),
			);

			const result = await client.enqueueMessage({
				tediId: TEDI_ID,
				conversationId: "agent:main:qa",
				content: "Dispatch throws",
				idempotencyKey: "predict-throw-key",
			});

			expect(result.status).toBe("failed");
			expect(settleSpy).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					runId: "alpha:mcp:predict-throw-key",
					outcome: "failed",
				}),
			);
		});

		it("preserves one pre-admitted run when a cold runtime accept times out with unknown delivery", async () => {
			mockTedi({ runtimeKind: "agent", isolateAgentId: "alpha" });
			const db = createRuntimeDb();
			const client = createRuntimeClient(createContext(db));
			const settleSpy = vi.spyOn(
				runtimeSubmissionBridge,
				"settleTediSubmission",
			);
			mocks.injectAgentMessage.mockRejectedValue(
				new ProvisioningHttpError(
					"Tedi runtime request timed out after 12000ms",
					504,
					"",
					true,
				),
			);

			const result = await client.enqueueMessage({
				tediId: TEDI_ID,
				conversationId: "agent:main:qa",
				content: "Cold admission remains supervised",
				idempotencyKey: "cold-timeout-key",
			});

			expect(result).toEqual({
				idempotencyKey: "cold-timeout-key",
				conversationId: "agent:main:qa",
				runId: "alpha:mcp:cold-timeout-key",
				status: "queued",
			});
			expect(mocks.injectAgentMessage).toHaveBeenCalledTimes(1);
			expect(settleSpy).not.toHaveBeenCalled();
			const events = await client.listEvents({
				tediId: TEDI_ID,
				conversationId: "alpha:agent:main:qa",
				limit: 20,
			});
			expect(events.events).toEqual([]);
		});

		it("does not claim a supervised timeout when durable pre-admission failed", async () => {
			mockTedi({ runtimeKind: "agent", isolateAgentId: "alpha" });
			const db = createRuntimeDb();
			const client = createRuntimeClient(createContext(db));
			vi.spyOn(
				runtimeSubmissionBridge,
				"recordTediSubmissionStarted",
			).mockRejectedValueOnce(new Error("ledger unavailable"));
			mocks.injectAgentMessage.mockRejectedValue(
				new ProvisioningHttpError(
					"Tedi runtime request timed out after 12000ms",
					504,
					"",
					true,
				),
			);

			const result = await client.enqueueMessage({
				tediId: TEDI_ID,
				conversationId: "agent:main:qa",
				content: "No phantom supervision",
				idempotencyKey: "unadmitted-timeout-key",
			});

			expect(result).toMatchObject({
				idempotencyKey: "unadmitted-timeout-key",
				status: "failed",
				reason: "dispatch_failed",
			});
			expect(result.runId).toBeUndefined();
			expect(mocks.injectAgentMessage).toHaveBeenCalledTimes(1);
		});

		it("a pre-admit failure never blocks dispatch — the choke-point admit remains the fallback of record", async () => {
			mockTedi({ runtimeKind: "agent", isolateAgentId: "alpha" });
			const db = createRuntimeDb();
			const client = createRuntimeClient(createContext(db));
			vi.spyOn(
				runtimeSubmissionBridge,
				"recordTediSubmissionStarted",
			).mockRejectedValueOnce(new Error("ledger unavailable"));
			mocks.injectAgentMessage.mockResolvedValue({
				run_id: "alpha:mcp:predict-fail-soft-key",
				success: true,
				session_key: "agent:main:qa",
			});

			const result = await client.enqueueMessage({
				tediId: TEDI_ID,
				conversationId: "agent:main:qa",
				content: "Pre-admit throws but dispatch still succeeds",
				idempotencyKey: "predict-fail-soft-key",
			});

			expect(result.status).toBe("queued");
			expect(result.runId).toBe("alpha:mcp:predict-fail-soft-key");
			expect(mocks.injectAgentMessage).toHaveBeenCalled();
		});
	});

	it("transcribes voice-only isolate enqueue messages before async accept", async () => {
		mockTedi({ runtimeKind: "agent", isolateAgentId: "alpha" });
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		mocks.transcribeAudioAttachment.mockResolvedValue({
			text: "isolate voice message works",
			provider: "azure",
		});
		mocks.injectAgentMessage.mockResolvedValue({
			run_id: "alpha:mcp:isolate-voice-key",
			success: true,
			accepted: true,
			session_key: "agent:main:qa",
		});

		const result = await client.enqueueMessage({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			content: "",
			idempotencyKey: "isolate-voice-key",
			attachments: [
				{
					content: "SGVsbG8=",
					fileName: "voice.wav",
					mimeType: "audio/wav",
					type: "audio",
				},
			],
			metadata: { source: "test" },
		});

		expect(result).toMatchObject({
			runId: "alpha:mcp:isolate-voice-key",
			status: "queued",
		});
		expect(mocks.injectAgentMessage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				message: "[Voice message transcript]\nisolate voice message works",
				session: "agent:main:qa",
				clientRequestId: "isolate-voice-key",
				attachments: [
					expect.objectContaining({
						fileName: "voice.wav",
						mimeType: "audio/wav",
						type: "audio",
					}),
				],
				async: true,
			}),
		);

		const events = await client.listEvents({
			tediId: TEDI_ID,
			conversationId: "alpha:agent:main:qa",
			limit: 20,
		});
		const received = events.events.find(
			(event) => event.kind === "message.received",
		);
		expect(received).toMatchObject({
			id: "alpha:mcp:isolate-voice-key:0",
			runId: "alpha:mcp:isolate-voice-key",
			payload: {
				role: "user",
				content: "[Voice message transcript]\nisolate voice message works",
			},
		});
		expect(
			(
				received?.payload as
					| { attachments?: Array<{ fileName?: string }> }
					| undefined
			)?.attachments?.[0]?.fileName,
		).toBe("voice.wav");
	});

	it("preflight bails enqueueMessage with runtime_unavailable when isolate tedi is stopped", async () => {
		// Simulate a paused/stopped isolate tedi — healthForIsolateTedi returns "stopped".
		mockTedi({
			runtimeKind: "agent",
			isolateAgentId: "alpha",
			status: "paused",
		});
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("message-preflight");

		const result = await client.enqueueMessage({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			content: "attempt to dispatch to dead runtime",
			idempotencyKey: "preflight-key",
		});

		// Preflight must bail before inject is called.
		expect(mocks.injectAgentMessage).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			idempotencyKey: "preflight-key",
			status: "failed",
			reason: "runtime_unavailable",
		});

		// A run.failed event must be written with preflightOnly: true so callers
		// and Mission Control can categorise the failure as boot-phase, not inject.
		const events = await db
			.select()
			.from(tediRuntimeEvents)
			.orderBy(tediRuntimeEvents.createdAt);
		expect(events.map((e) => e.kind)).toEqual(["run.failed"]);
		expect(events[0]?.payload).toMatchObject({
			reason: "runtime_unavailable",
		});
		expect(
			(events[0]?.runtimeMetadata as { preflightOnly?: boolean } | null)
				?.preflightOnly,
		).toBe(true);
	});

	it("preflight bails enqueueMessage with runtime_unavailable when isolate tedi is provisioning but active probe fails", async () => {
		mockTedi({
			runtimeKind: "agent",
			isolateAgentId: "alpha",
			status: "provisioning",
		});
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		// Active probe fails (e.g. network error during startup).
		mocks.getAgentDiagnostics.mockRejectedValue(new Error("runtime not ready"));
		vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("message-starting");

		const result = await client.enqueueMessage({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			content: "dispatch during startup",
			idempotencyKey: "starting-key",
		});

		expect(mocks.injectAgentMessage).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			idempotencyKey: "starting-key",
			status: "failed",
			reason: "runtime_unavailable",
		});

		const events = await db
			.select()
			.from(tediRuntimeEvents)
			.orderBy(tediRuntimeEvents.createdAt);
		expect(events.map((e) => e.kind)).toEqual(["run.failed"]);
		expect(events[0]?.payload).toMatchObject({ reason: "runtime_unavailable" });
	});

	it("preflight proceeds without extra latency when isolate tedi is healthy", async () => {
		mockTedi({
			runtimeKind: "agent",
			isolateAgentId: "alpha",
			status: "active",
		});
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		mocks.injectAgentMessage.mockResolvedValue({
			run_id: "alpha:mcp:healthy-key",
			success: true,
			session_key: "agent:main:qa",
		});

		const result = await client.enqueueMessage({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			content: "healthy dispatch",
			idempotencyKey: "healthy-key",
		});

		// getAgentDiagnostics must NOT be called — healthy path skips active probe.
		expect(mocks.getAgentDiagnostics).not.toHaveBeenCalled();
		expect(mocks.injectAgentMessage).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ status: "queued" });
	});

	it("translates a reconnecting tedi runtime into SERVICE_UNAVAILABLE (503) on stopRun", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		mocks.cancelRuntimeTurn.mockRejectedValue(
			new ProvisioningHttpError("Tedi gateway is reconnecting", 503),
		);

		await expect(
			client.stopRun({
				tediId: TEDI_ID,
				runId: "run-1",
				conversationId: "agent:main:qa",
				reason: "user_pressed_enter",
			}),
		).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		expect(mocks.stopRuntimeRun).not.toHaveBeenCalled();
	});

	it("stopRun stamps durable abort intent BEFORE the runtime cancel, and the stamp survives a thrown ProvisioningHttpError", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		mocks.cancelRuntimeTurn.mockRejectedValue(
			new ProvisioningHttpError("Tedi runtime request failed", 521),
		);

		await expect(
			client.stopRun({
				tediId: TEDI_ID,
				runId: `${TEDI_ID}:mcp:turn-abort-1`,
				conversationId: "agent:main:qa",
				reason: "operator_canceled",
			}),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });

		// The durable intent was recorded even though the cancel RPC was lost.
		expect(mocks.requestSubmissionAbort).toHaveBeenCalledTimes(1);
		expect(mocks.requestSubmissionAbort).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				submissionId: `sub:${TEDI_ID}:mcp:turn-abort-1`,
				organizationId: ORG_ID,
				reason: "operator_canceled",
			}),
		);
		// Stamp-before-action: the stamp preceded the runtime cancel attempt.
		expect(
			mocks.requestSubmissionAbort.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.cancelRuntimeTurn.mock.invocationCallOrder[0] ?? 0);
		// And no run.canceled event was written (the cancel itself failed).
		expect(db.events.some((event) => event.kind === "run.canceled")).toBe(
			false,
		);
	});

	it("records run.canceled when the runtime accepts the stop request", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		mocks.cancelRuntimeTurn.mockResolvedValue({ success: true });

		const result = await client.stopRun({
			tediId: TEDI_ID,
			runId: "run-1",
			conversationId: "agent:main:qa",
			reason: "user_canceled",
		});

		expect(result.ok).toBe(true);
		expect(result.event).toMatchObject({
			tediId: TEDI_ID,
			runId: "run-1",
			kind: "run.canceled",
		});
		expect(mocks.cancelRuntimeTurn).toHaveBeenCalledTimes(1);
		expect(mocks.stopRuntimeRun).not.toHaveBeenCalled();
	});

	it("stopRun on an isolate tedi routes through cancelRuntimeTurn (not stopRuntimeRun)", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		// agent runtimeKind = isolate (not legacy runtime)
		mockTedi({ runtimeKind: "agent" });
		mocks.cancelRuntimeTurn.mockResolvedValue({ success: true });

		const result = await client.stopRun({
			tediId: TEDI_ID,
			runId: `${TEDI_ID}:mcp:some-turn-key`,
			conversationId: "agent:main:qa",
			reason: "operator_canceled",
		});

		expect(result.ok).toBe(true);
		expect(result.event).toMatchObject({
			tediId: TEDI_ID,
			runId: `${TEDI_ID}:mcp:some-turn-key`,
			kind: "run.canceled",
		});
		// Must call cancelRuntimeTurn with the turnKey segment extracted from runId
		expect(mocks.cancelRuntimeTurn).toHaveBeenCalledTimes(1);
		expect(mocks.cancelRuntimeTurn.mock.calls[0]?.[1]).toEqual({
			clientRequestId: "some-turn-key",
			runId: `${TEDI_ID}:mcp:some-turn-key`,
		});
		// Must NOT fall back to runtime stopRuntimeRun
		expect(mocks.stopRuntimeRun).not.toHaveBeenCalled();
	});

	it("stopRun on an isolate tedi treats already-settled workflow as success", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		mockTedi({ runtimeKind: "agent" });
		// already_settled is the fail-soft signal from the DO cancel endpoint
		mocks.cancelRuntimeTurn.mockResolvedValue({
			success: true,
			detail: "already_settled",
		});

		const result = await client.stopRun({
			tediId: TEDI_ID,
			runId: `${TEDI_ID}:mcp:settled-turn`,
		});

		expect(result.ok).toBe(true);
		expect(result.event).toMatchObject({ kind: "run.canceled" });
	});

	it("stopRun on an isolate tedi surfaces SERVICE_UNAVAILABLE when cancelRuntimeTurn 503s", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		mockTedi({ runtimeKind: "agent" });
		mocks.cancelRuntimeTurn.mockRejectedValue(
			new ProvisioningHttpError("runtime unavailable", 503),
		);

		await expect(
			client.stopRun({
				tediId: TEDI_ID,
				runId: `${TEDI_ID}:mcp:busy-turn`,
			}),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(mocks.stopRuntimeRun).not.toHaveBeenCalled();
	});

	it("records artifacts, emits artifact events, and reads the artifact back", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		const recorded = await client.recordArtifact({
			tediId: TEDI_ID,
			id: "artifact-1",
			conversationId: "agent:main:qa",
			runId: "run-1",
			messageId: "message-1",
			kind: "document",
			name: "notes.md",
			mimeType: "text/markdown",
			uri: "https://example.com/registry-only/notes.md",
			sizeBytes: 42,
			metadata: { source: "test" },
			createdAt: "2026-05-25T08:00:00.000Z",
		});
		const listed = await client.listArtifacts({
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			limit: 10,
		});
		const read = await client.getArtifact({
			tediId: TEDI_ID,
			artifactId: "artifact-1",
		});
		const events = await db.select().from(tediRuntimeEvents);

		expect(recorded.artifact).toMatchObject({
			id: "artifact-1",
			tediId: TEDI_ID,
			kind: "document",
			name: "notes.md",
			accessClassification: "runtime_private",
		});
		expect(recorded.artifact.metadata).toBeUndefined();
		expect(recorded.artifact.uri).toBeUndefined();
		expect(listed.artifacts).toEqual([recorded.artifact]);
		expect(read.artifact).toEqual(recorded.artifact);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			kind: "artifact.created",
			artifactId: "artifact-1",
			payload: {
				artifact: expect.objectContaining({
					id: "artifact-1",
					accessClassification: "runtime_private",
				}),
			},
		});
		expect(
			(events[0]?.payload?.artifact as Record<string, unknown>)?.uri,
		).toBeUndefined();
		expect(
			(events[0]?.payload?.artifact as Record<string, unknown>)?.metadata,
		).toBeUndefined();
		const artifacts = await db.select().from(tediArtifacts);
		expect(artifacts).toHaveLength(1);
	});

	it("does not expose a peer tedi private artifact location to a trusted runtime", async () => {
		const db = createRuntimeDb();
		await db.insert(tediArtifacts).values({
			id: "peer-private-artifact",
			organizationId: ORG_ID,
			tediId: "peer-tedi",
			kind: "file",
			name: "peer.txt",
			uri: "r2://private/peer.txt",
			metadata: { secret: "peer" },
			accessClassification: "runtime_private",
			publicationState: "ready",
		});
		const context = createContext(db);
		context.authType = "service-binding";
		context.tediId = TEDI_ID;
		context.tediScopes = ["tedis:read"];
		context.headers = new Headers({
			"X-Tedix-Caller": "brain-bridge",
			"X-Tedix-Caller-Source": "http-platform-client",
			"X-Tedix-Tedi-Id": TEDI_ID,
		});

		const result = await createRuntimeClient(context).getArtifact({
			tediId: TEDI_ID,
			artifactId: "peer-private-artifact",
		});

		expect(result.artifact.tediId).toBe("peer-tedi");
		expect(result.artifact.uri).toBeUndefined();
		expect(result.artifact.metadata).toBeUndefined();
	});

	it("rejects forged contribution payloads before inserting a runtime event", async () => {
		const db = createRuntimeDb();
		const input = {
			id: "forged-contribution",
			tediId: TEDI_ID,
			kind: "tool.completed" as const,
			conversationId: "agent:main:qa",
			runId: "run-1",
			payload: {
				artifactContributionReceipt: {
					version: 1,
					artifactIds: ["artifact-1"],
					completeness: "observed_prefix",
					observations: [],
				},
			},
			createdAt: "2026-09-23T00:00:00.000Z",
		};
		await expect(
			createRuntimeClient(createContext(db)).recordEvent(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await db.select().from(tediRuntimeEvents)).toHaveLength(0);
	});

	it("binds a trusted contribution from the canonical persisted tool event", async () => {
		const db = createRuntimeDb();
		await db.insert(tediArtifacts).values({
			id: "bound-artifact",
			organizationId: ORG_ID,
			tediId: TEDI_ID,
			conversationId: "agent:main:qa",
			runId: "run-bound",
			kind: "document",
			name: "bound.md",
			contentDigest: "a".repeat(64),
			accessClassification: "runtime_private",
			publicationState: "ready",
			createdAt: "2026-09-23T00:00:00.000Z",
		});
		const context = createContext(db);
		context.authType = "service-binding";
		context.tediId = TEDI_ID;
		context.tediScopes = ["tedis:write"];
		context.headers = new Headers({
			"X-Tedix-Caller": "brain-bridge",
			"X-Tedix-Caller-Source": "http-platform-client",
			"X-Tedix-Tedi-Id": TEDI_ID,
		});
		mocks.recordContribution.mockResolvedValueOnce({ created: true });
		await createRuntimeClient(context).recordEvent({
			id: "trusted-contribution",
			tediId: TEDI_ID,
			kind: "tool.completed",
			conversationId: "agent:main:qa",
			runId: "run-bound",
			payload: {
				artifactContributionReceipt: {
					version: 1,
					artifactIds: ["bound-artifact"],
					completeness: "observed_prefix",
					observations: [],
				},
			},
			createdAt: "2026-09-23T00:00:00.000Z",
		});
		expect(mocks.recordContribution).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				artifactId: "bound-artifact",
				producerRuntimeEventId: "trusted-contribution",
				completeness: "observed_prefix",
			}),
		);
	});

	it("replays only an exact-run legacy workstation claim with no conversation", async () => {
		const db = createRuntimeDb();
		const artifactId = "run-legacy:artifact:workstation_process:job:stdout";
		await db.insert(tediArtifacts).values({
			id: artifactId,
			organizationId: ORG_ID,
			tediId: TEDI_ID,
			conversationId: null,
			runId: "run-legacy",
			kind: "log",
			name: "workstation_process/job/stdout.log",
			metadata: {
				source: "workstation_process",
				subKind: "workstation_process",
				producer: "workstation-adapter",
			},
			contentDigest: "a".repeat(64),
			accessClassification: "runtime_private",
			publicationState: "ready",
			createdAt: "2026-09-23T00:00:00.000Z",
		});
		const context = createContext(db);
		context.authType = "service-binding";
		context.tediId = TEDI_ID;
		context.tediScopes = ["tedis:write"];
		context.headers = new Headers({
			"X-Tedix-Caller": "brain-bridge",
			"X-Tedix-Caller-Source": "http-platform-client",
			"X-Tedix-Tedi-Id": TEDI_ID,
		});
		mocks.recordContribution.mockResolvedValueOnce({ created: true });
		await createRuntimeClient(context).recordEvent({
			id: "legacy-contribution",
			tediId: TEDI_ID,
			kind: "tool.completed",
			conversationId: "agent:main:delegation",
			runId: "run-legacy",
			payload: {
				artifactContributionReceipt: {
					version: 1,
					artifactIds: [artifactId],
					completeness: "observed_prefix",
					observations: [],
				},
			},
			createdAt: "2026-09-23T00:00:00.000Z",
		});
		expect(mocks.recordContribution).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				artifactId,
				allowLegacyNullConversation: true,
			}),
		);
	});

	it("rejects a null-conversation artifact outside the legacy workstation shape", async () => {
		const db = createRuntimeDb();
		await db.insert(tediArtifacts).values({
			id: "run-legacy:artifact:other:job:stdout",
			organizationId: ORG_ID,
			tediId: TEDI_ID,
			conversationId: null,
			runId: "run-legacy",
			kind: "log",
			name: "workstation_process/job/stdout.log",
			metadata: {
				source: "workstation_process",
				subKind: "workstation_process",
				producer: "workstation-adapter",
			},
			contentDigest: "a".repeat(64),
			accessClassification: "runtime_private",
			publicationState: "ready",
			createdAt: "2026-09-23T00:00:00.000Z",
		});
		const context = createContext(db);
		context.authType = "service-binding";
		context.tediId = TEDI_ID;
		context.tediScopes = ["tedis:write"];
		context.headers = new Headers({
			"X-Tedix-Caller": "brain-bridge",
			"X-Tedix-Caller-Source": "http-platform-client",
			"X-Tedix-Tedi-Id": TEDI_ID,
		});
		await expect(
			createRuntimeClient(context).recordEvent({
				id: "non-workstation-contribution",
				tediId: TEDI_ID,
				kind: "tool.completed",
				conversationId: "agent:main:delegation",
				runId: "run-legacy",
				payload: {
					artifactContributionReceipt: {
						version: 1,
						artifactIds: ["run-legacy:artifact:other:job:stdout"],
						completeness: "observed_prefix",
						observations: [],
					},
				},
				createdAt: "2026-09-23T00:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("rejects unowned R2 references and mints links only for owned bodies", async () => {
		const db = createRuntimeDb();
		const context = createContext(db);
		const client = createRuntimeClient(context);

		await expect(
			client.recordArtifact({
				tediId: TEDI_ID,
				id: "foreign-r2",
				kind: "document",
				name: "foreign.md",
				uri: "r2://tedix-tedi-production/other-tedi/artifacts/secret.md",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await db.insert(tediArtifacts).values([
			{
				id: "legacy-unsafe",
				organizationId: ORG_ID,
				tediId: TEDI_ID,
				kind: "document",
				name: "unsafe.md",
				uri: "r2://skill-artifacts-production/another-tenant/secret.md",
				createdAt: "2026-09-22T00:00:00.000Z",
			},
			{
				id: "peer-workstation",
				organizationId: ORG_ID,
				tediId: TEDI_ID,
				kind: "log",
				name: "peer-stdout.log",
				uri: "r2://tedi-storage/orgs/org-1/tedis/22222222-2222-4222-8222-222222222222/workstations/coding/processes/p/terminal/stdout.log",
				createdAt: "2026-09-22T00:00:00.000Z",
			},
			{
				id: "protected-derived",
				organizationId: ORG_ID,
				tediId: TEDI_ID,
				kind: "document",
				name: "protected.md",
				uri: `r2://tedix-tedi-production/${TEDI_ID}/artifacts/protected.md`,
				accessClassification: "source_derived",
				contentDigest: "a".repeat(64),
				producerExecutionId: "execution-1",
				accessEnvelope: JSON.stringify({
					version: 1,
					sources: [
						{
							workspaceResourceId: crypto.randomUUID(),
							workspaceId: crypto.randomUUID(),
							providerId: "github",
							resourceType: "repository",
							providerResourceId: "tedix-hq/tedix",
							connectionScope: "tenant",
							requiredScopes: ["repo:read"],
							operations: ["read"],
						},
					],
				}),
				createdAt: "2026-09-22T00:00:00.000Z",
			},
		]);
		await expect(
			client.createArtifactShareLink({
				tediId: TEDI_ID,
				artifactId: "legacy-unsafe",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.createArtifactShareLink({
				tediId: TEDI_ID,
				artifactId: "peer-workstation",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("lets a tedi read a peer artifact only within the same organization", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));
		await db.insert(tediArtifacts).values([
			{
				id: "peer-artifact",
				organizationId: ORG_ID,
				tediId: "peer-tedi",
				kind: "log",
				name: "peer-proof.json",
				uri: "r2://tedix-tedi-production/peer-tedi/artifacts/deliverable/peer-proof.json",
				createdAt: "2026-08-31T00:00:00.000Z",
			},
			{
				id: "foreign-artifact",
				organizationId: "other-org",
				tediId: "foreign-tedi",
				kind: "log",
				name: "foreign-proof.json",
				uri: "r2://tedix-tedi-production/foreign-tedi/artifacts/deliverable/foreign-proof.json",
				createdAt: "2026-08-31T00:00:00.000Z",
			},
		]);

		await expect(
			client.getArtifact({
				tediId: TEDI_ID,
				artifactId: "peer-artifact",
			}),
		).resolves.toMatchObject({
			artifact: { id: "peer-artifact", tediId: "peer-tedi" },
		});
		await expect(
			client.getArtifact({
				tediId: TEDI_ID,
				artifactId: "foreign-artifact",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("records the server-computed digest for an uploaded source file", async () => {
		const db = createRuntimeDb();
		const context = createContext(db);
		const put = vi.fn(async () => {
			expect(await getTediArtifactClaim(db, "raw-source-1")).toMatchObject({
				id: "raw-source-1",
			});
			return { key: "created" };
		});
		(
			context.env as CloudflareEnv & { TEDI_R2_BUCKET: { put: typeof put } }
		).TEDI_R2_BUCKET = { put };
		const client = createRuntimeClient(context);

		const recorded = await client.recordArtifact({
			tediId: TEDI_ID,
			id: "raw-source-1",
			kind: "file",
			name: "invoice.xml",
			mimeType: "application/xml",
			content: '<invoice id="1" />',
			metadata: {
				projectKey: "FINANCE-AUDIT",
				sourceManifest: { sourceType: "sat-cfdi", parseStatus: "parsed" },
			},
		});

		expect(put).toHaveBeenCalledOnce();
		const firstKey = put.mock.calls[0]?.[0];
		expect(put.mock.calls[0]?.[2]).toMatchObject({
			onlyIf: { etagDoesNotMatch: "*" },
		});
		expect(firstKey).toMatch(
			new RegExp(
				`^${TEDI_ID}/artifacts/deliverable/[0-9a-f]{64}/[0-9a-f]{64}/invoice\\.xml$`,
			),
		);
		expect(recorded.artifact).toMatchObject({
			name: "invoice.xml",
			sizeBytes: 18,
			metadata: undefined,
			accessClassification: "runtime_private",
		});

		await client.recordArtifact({
			tediId: TEDI_ID,
			id: "raw-source-2",
			kind: "file",
			name: "invoice.xml",
			content: '<invoice id="2" />',
		});
		expect(put).toHaveBeenCalledTimes(2);
		expect(put.mock.calls[1]?.[0]).not.toBe(firstKey);
	});

	it("rejects source-derived recording without durable storage before claiming", async () => {
		const db = createRuntimeDb();
		const context = createContext(db);
		context.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Skill-Run-Id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"X-Tedix-Tedi-Scopes": "tedis:write",
		});
		mocks.getOsGadgetExecutionByRunId.mockResolvedValue({
			id: "execution-source",
			resourceAccessEnvelope: JSON.stringify({ version: 1, sources: [] }),
		});
		const client = createRuntimeClient(context);

		await expect(
			client.recordArtifact({
				tediId: TEDI_ID,
				id: "derived-no-bucket",
				kind: "file",
				name: "source.txt",
				content: "governed bytes",
			}),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(db.artifacts).toHaveLength(0);
		expect(db.events).toHaveLength(0);
	});

	it("rejects explicit inline content without durable storage before claiming", async () => {
		const db = createRuntimeDb();
		const client = createRuntimeClient(createContext(db));

		await expect(
			client.recordArtifact({
				tediId: TEDI_ID,
				id: "explicit-no-bucket",
				kind: "file",
				name: "content.txt",
				uri: "https://caller.invalid/not-the-inline-bytes",
				content: "inline bytes",
			}),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(db.artifacts).toHaveLength(0);
		expect(db.events).toHaveLength(0);
	});

	it("verifies existing immutable bytes and leaves a failed new claim pending", async () => {
		const db = createRuntimeDb();
		const context = createContext(db);
		context.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Skill-Run-Id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"X-Tedix-Tedi-Scopes": "tedis:write",
		});
		mocks.getOsGadgetExecutionByRunId.mockResolvedValue({
			id: "execution-source",
			resourceAccessEnvelope: JSON.stringify({ version: 1, sources: [] }),
		});
		const put = vi.fn(async () => null);
		let storedBytes = "different bytes";
		const head = vi.fn(async () => ({
			size: 14,
			httpMetadata: { contentType: "text/plain; charset=utf-8" },
		}));
		const get = vi.fn(async () => ({
			arrayBuffer: async () => new TextEncoder().encode(storedBytes).buffer,
		}));
		(
			context.env as CloudflareEnv & { TEDI_R2_BUCKET: unknown }
		).TEDI_R2_BUCKET = {
			put,
			head,
			get,
		};
		const client = createRuntimeClient(context);

		await expect(
			client.recordArtifact({
				tediId: TEDI_ID,
				id: "derived-conflict",
				kind: "file",
				name: "source.txt",
				content: "governed bytes",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(head).toHaveBeenCalledOnce();
		expect(get).toHaveBeenCalledOnce();
		expect(db.artifacts).toEqual([
			expect.objectContaining({
				id: "derived-conflict",
				publicationState: "pending",
			}),
		]);
		expect(db.events).toHaveLength(0);

		storedBytes = "governed bytes";
		await expect(
			client.recordArtifact({
				tediId: TEDI_ID,
				id: "derived-conflict",
				kind: "file",
				name: "source.txt",
				content: "governed bytes",
			}),
		).resolves.toMatchObject({ artifact: { id: "derived-conflict" } });
		expect(db.artifacts[0]).toMatchObject({ publicationState: "ready" });
		expect(db.events).toHaveLength(1);

		storedBytes = "different bytes";
		await expect(
			client.recordArtifact({
				tediId: TEDI_ID,
				id: "derived-conflict",
				kind: "file",
				name: "source.txt",
				content: "governed bytes",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(db.artifacts[0]).toMatchObject({ publicationState: "ready" });
		expect(db.events).toHaveLength(1);
	});

	it("keeps malformed execution envelopes source-derived but unverifiable", async () => {
		const db = createRuntimeDb();
		const context = createContext(db);
		context.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Skill-Run-Id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"X-Tedix-Tedi-Scopes": "tedis:write",
		});
		mocks.getOsGadgetExecutionByRunId.mockResolvedValue({
			id: "execution-source",
			resourceAccessEnvelope: "not-json",
		});
		const put = vi.fn(async () => ({ key: "created" }));
		(
			context.env as CloudflareEnv & { TEDI_R2_BUCKET: unknown }
		).TEDI_R2_BUCKET = {
			put,
		};
		const client = createRuntimeClient(context);

		await client.recordArtifact({
			tediId: TEDI_ID,
			id: "derived-malformed-envelope",
			kind: "file",
			name: "source.txt",
			content: "governed bytes",
		});
		expect(db.artifacts[0]).toMatchObject({
			accessClassification: "runtime_private",
			producerExecutionId: null,
			accessEnvelope: null,
			publicationState: "ready",
		});
		expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				actorType: "api_key",
				actorId: "api-key-1",
				action: "artifact.producer_unverifiable",
				resourceId: "derived-malformed-envelope",
				metadata: expect.objectContaining({
					reason: "malformed_execution_access_envelope",
				}),
			}),
		);
	});

	it("rejects duplicate normalized bundle paths", async () => {
		const db = createRuntimeDb();
		const context = createContext(db);
		(
			context.env as CloudflareEnv & { TEDI_R2_BUCKET: unknown }
		).TEDI_R2_BUCKET = {
			put: vi.fn(),
		};
		const client = createRuntimeClient(context);
		await expect(
			client.recordArtifact({
				tediId: TEDI_ID,
				id: "duplicate-paths",
				kind: "document",
				name: "site",
				files: [
					{ path: "index.html", content: "one" },
					{ path: "/index.html", content: "two" },
				],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(db.artifacts).toHaveLength(0);
	});

	it("rejects cross-owner artifact ids before any single or bundle storage effect", async () => {
		const db = createRuntimeDb();
		await db.insert(tediArtifacts).values([
			{
				id: "peer-collision",
				organizationId: ORG_ID,
				tediId: "peer-tedi",
				kind: "file",
				name: "peer.txt",
				uri: "r2://victim/peer",
				createdAt: "2026-08-31T00:00:00.000Z",
			},
			{
				id: "foreign-collision",
				organizationId: "other-org",
				tediId: "foreign-tedi",
				kind: "file",
				name: "foreign.txt",
				uri: "r2://victim/foreign",
				createdAt: "2026-08-31T00:00:00.000Z",
			},
		]);
		const context = createContext(db);
		const put = vi.fn(async () => undefined);
		const list = vi.fn(async () => ({ objects: [{ key: "stale" }] }));
		const deleteObjects = vi.fn(async () => undefined);
		(
			context.env as CloudflareEnv & { TEDI_R2_BUCKET: unknown }
		).TEDI_R2_BUCKET = {
			put,
			list,
			delete: deleteObjects,
		};
		const client = createRuntimeClient(context);
		await expect(
			client.recordArtifact({
				tediId: TEDI_ID,
				id: "malformed-bundle",
				kind: "document",
				name: "bad bundle",
				files: [
					{ path: "index.html", content: "valid first file" },
					{ path: "../escape.js", content: "invalid last file" },
				],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(
			db.artifacts.find((artifact) => artifact.id === "malformed-bundle"),
		).toBeUndefined();

		await expect(
			client.recordArtifact({
				tediId: TEDI_ID,
				id: "peer-collision",
				kind: "file",
				name: "attacker.txt",
				content: "attacker bytes",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			client.recordArtifact({
				tediId: TEDI_ID,
				id: "foreign-collision",
				kind: "document",
				name: "dashboard",
				files: [{ path: "index.html", content: "attacker bundle" }],
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			client.recordArtifact({
				tediId: TEDI_ID,
				id: "peer-collision",
				kind: "file",
				name: "repointed.txt",
				uri: "https://attacker.invalid/payload",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(put).not.toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
		expect(deleteObjects).not.toHaveBeenCalled();
		expect(
			db.artifacts.find((artifact) => artifact.id === "peer-collision"),
		).toMatchObject({
			tediId: "peer-tedi",
			name: "peer.txt",
			uri: "r2://victim/peer",
		});
	});
});

describe("resolveTediRuntimeBackend", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it("maps an isolate tedi to the cloudflare-agents backend", async () => {
		mocks.getTediById.mockResolvedValue({ runtimeKind: "agent" });
		const ctx = createContext(createRuntimeDb());
		// Distinct id per case to avoid the module-level backend cache colliding.
		expect(await resolveTediRuntimeBackend(ctx, "rb-iso-1")).toBe(
			"cloudflare-agents",
		);
	});

	it("does not inspect D1 rows to resolve the runtime backend", async () => {
		mocks.getTediById.mockResolvedValue({ runtimeKind: "agent" });
		const ctx = createContext(createRuntimeDb());
		expect(await resolveTediRuntimeBackend(ctx, "rb-con-1")).toBe(
			"cloudflare-agents",
		);
		expect(mocks.getTediById).not.toHaveBeenCalled();
	});

	it("caches by tediId — a second resolve does not re-read D1", async () => {
		mocks.getTediById.mockResolvedValue({ runtimeKind: "agent" });
		const ctx = createContext(createRuntimeDb());
		expect(await resolveTediRuntimeBackend(ctx, "rb-cache-1")).toBe(
			"cloudflare-agents",
		);
		mocks.getTediById.mockClear();
		// Flip the underlying value; the cache must still return the first result
		// and must NOT have hit getTediById again.
		mocks.getTediById.mockResolvedValue({ runtimeKind: "agent" });
		expect(await resolveTediRuntimeBackend(ctx, "rb-cache-1")).toBe(
			"cloudflare-agents",
		);
		expect(mocks.getTediById).not.toHaveBeenCalled();
	});

	it("does not D1-read for backend resolution", async () => {
		mocks.getTediById.mockRejectedValue(new Error("d1 down"));
		const ctx = createContext(createRuntimeDb());
		expect(await resolveTediRuntimeBackend(ctx, "rb-fail-1")).toBe(
			"cloudflare-agents",
		);
		expect(mocks.getTediById).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// notifyKernelChildComplete — PHASE-1 inbox-wake focused tests
// ─────────────────────────────────────────────────────────────────────────────

type WakeQueueRow = typeof kernelWakeQueue.$inferInsert;

function createWakeDb() {
	const wakeRows: WakeQueueRow[] = [];
	return {
		wakeRows,
		insert(table: unknown) {
			let row: WakeQueueRow | null = null;
			let ignoreConflicts = false;
			return {
				values(value: WakeQueueRow) {
					row = value;
					return this;
				},
				onConflictDoNothing() {
					ignoreConflicts = true;
					return this;
				},
				// Drizzle query builders are awaitable.
				then<T1 = undefined, T2 = never>(
					onfulfilled?: ((v: undefined) => T1 | PromiseLike<T1>) | null,
					onrejected?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
				) {
					if (row && table === kernelWakeQueue) {
						const alreadyExists =
							ignoreConflicts && wakeRows.some((r) => r.id === row!.id);
						if (!alreadyExists) wakeRows.push(row);
					}
					return Promise.resolve().then(onfulfilled as never, onrejected);
				},
			};
		},
	};
}

function createWakeContext(db: ReturnType<typeof createWakeDb>): BaseContext & {
	clearChildApprovalBlockedCalls: unknown[];
	mirrorChildApprovalBlockedCalls: unknown[];
	scheduleWakeAlarmCalls: Array<[string, string, string]>;
} {
	const scheduleWakeAlarmCalls: Array<[string, string, string]> = [];
	const mirrorChildApprovalBlockedCalls: unknown[] = [];
	const clearChildApprovalBlockedCalls: unknown[] = [];
	const stubFn = {
		clearChildApprovalBlocked: vi.fn(async (input: unknown) => {
			clearChildApprovalBlockedCalls.push(input);
		}),
		mirrorChildApprovalBlocked: vi.fn(async (input: unknown) => {
			mirrorChildApprovalBlockedCalls.push(input);
		}),
		scheduleWakeAlarm: vi.fn(async (...args: [string, string, string]) => {
			scheduleWakeAlarmCalls.push(args);
		}),
	};
	const kernelNs = {
		get: () => stubFn,
		idFromName: (name: string) => ({ toString: () => name }),
	};
	return {
		apiKey: {
			id: "api-key-1",
			name: "test",
			organizationId: ORG_ID,
			scopes: ["*"],
		},
		authType: "apikey",
		db: db as unknown as BaseContext["db"],
		env: {
			ENVIRONMENT: "test",
			KERNEL: kernelNs,
		} as unknown as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/cognitive-runtime"),
		waitUntil: vi.fn(),
		clearChildApprovalBlockedCalls,
		mirrorChildApprovalBlockedCalls,
		scheduleWakeAlarmCalls,
	} as unknown as BaseContext & {
		clearChildApprovalBlockedCalls: unknown[];
		mirrorChildApprovalBlockedCalls: unknown[];
		scheduleWakeAlarmCalls: Array<[string, string, string]>;
	};
}

describe("notifyKernelChildComplete (inbox-wake PHASE-1)", () => {
	it("cross-org guard drops the wake without writing to queue or calling DO", async () => {
		const db = createWakeDb();
		const ctx = createWakeContext(db);

		await notifyKernelChildComplete(ctx, {
			childRunId: "run-b",
			childStatus: "failed",
			childOrganizationId: "org-child",
			parentOrganizationId: "org-parent",
			parentConversationId: "conv-home-2",
		});

		expect(db.wakeRows).toHaveLength(0);
		expect(
			(
				ctx as unknown as {
					env: {
						KERNEL: {
							get: () => { scheduleWakeAlarm: ReturnType<typeof vi.fn> };
						};
					};
				}
			).env.KERNEL.get().scheduleWakeAlarm,
		).not.toHaveBeenCalled();
	});

	it("N child completions for the same conversation each write a queue row and call scheduleWakeAlarm", async () => {
		const db = createWakeDb();
		const ctx = createWakeContext(db);

		const CONV = "conv-home-3";
		const runs = ["run-c1", "run-c2", "run-c3"] as const;

		for (const runId of runs) {
			await notifyKernelChildComplete(ctx, {
				childRunId: runId,
				childStatus: "completed",
				childOrganizationId: ORG_ID,
				parentOrganizationId: ORG_ID,
				parentConversationId: CONV,
			});
		}

		// All three queue rows written (each has a distinct id keyed on runId).
		expect(db.wakeRows).toHaveLength(3);
		const queuedRunIds = db.wakeRows.map((r) => r.childRunId);
		for (const runId of runs) {
			expect(queuedRunIds).toContain(runId);
		}

		// scheduleWakeAlarm called once per completion; DO's own debounce coalesces
		// the alarms — the DO-level debounce is tested separately in kernel-do tests.
		const calls = ctx.scheduleWakeAlarmCalls;
		expect(calls).toHaveLength(3);
		for (const call of calls) {
			expect(call[0]).toBe(CONV);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// recordEvent inbox-wake parent-lookup fallback
//
// Terminal child events (run.completed/failed/canceled) carry no
// homeConversationId in runtime.metadata. The fallback queries
// kernel_runtime_runs WHERE childRunId = input.runId to find the parent
// conversation. These tests cover the happy path and the no-parent-found no-op.
// ─────────────────────────────────────────────────────────────────────────────

type KernelRunRow = typeof kernelRuntimeRuns.$inferSelect;

function createParentLookupDb(parentRows: KernelRunRow[] = []) {
	const base = createRuntimeDb();
	const wakeRows: (typeof kernelWakeQueue.$inferInsert)[] = [];

	const originalSelect = base.select.bind(base);
	const originalInsert = base.insert.bind(base);

	return {
		...base,
		wakeRows,
		insert(table: unknown) {
			if (table === kernelWakeQueue) {
				let row: typeof kernelWakeQueue.$inferInsert | null = null;
				let ignoreConflicts = false;
				return {
					values(value: typeof kernelWakeQueue.$inferInsert) {
						row = value;
						return this;
					},
					onConflictDoNothing() {
						ignoreConflicts = true;
						return this;
					},
					// Drizzle query builders are awaitable.
					then<T1 = undefined, T2 = never>(
						onfulfilled?: ((v: undefined) => T1 | PromiseLike<T1>) | null,
						onrejected?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
					) {
						if (row) {
							const alreadyExists =
								ignoreConflicts &&
								wakeRows.some(
									(r) => r.id === (row as NonNullable<typeof row>).id,
								);
							if (!alreadyExists) wakeRows.push(row as NonNullable<typeof row>);
						}
						return Promise.resolve().then(onfulfilled as never, onrejected);
					},
				};
			}
			return originalInsert(table);
		},
		select(_columns?: unknown) {
			const baseBuilder = originalSelect();

			const kernelRunsBuilder = {
				where(_clause: unknown) {
					return kernelRunsBuilder;
				},
				orderBy(_clause: unknown) {
					return kernelRunsBuilder;
				},
				limit(_n: number) {
					return kernelRunsBuilder;
				},
				// Drizzle query builders are awaitable.
				then<T1, T2 = never>(
					onfulfilled?: ((v: KernelRunRow[]) => T1 | PromiseLike<T1>) | null,
					onrejected?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
				) {
					return Promise.resolve(parentRows).then(
						onfulfilled as (v: KernelRunRow[]) => T1 | PromiseLike<T1>,
						onrejected,
					);
				},
			};

			return {
				from(table: unknown) {
					if (table === kernelRuntimeRuns) return kernelRunsBuilder;
					return baseBuilder.from(table);
				},
			};
		},
	};
}

function createInboxWakeContext(
	db: ReturnType<typeof createParentLookupDb>,
): BaseContext & {
	waitUntilPromises: Promise<unknown>[];
	scheduleWakeAlarmCalls: Array<[string, string, string]>;
} {
	const waitUntilPromises: Promise<unknown>[] = [];
	const scheduleWakeAlarmCalls: Array<[string, string, string]> = [];
	const stubDo = {
		scheduleWakeAlarm: vi.fn(async (...args: [string, string, string]) => {
			scheduleWakeAlarmCalls.push(args);
		}),
		clearChildApprovalBlocked: vi.fn(async () => {}),
		mirrorChildApprovalBlocked: vi.fn(async () => {}),
	};
	const kernelNs = {
		get: () => stubDo,
		idFromName: (name: string) => ({ toString: () => name }),
	};
	return {
		apiKey: {
			id: "api-key-1",
			name: "test",
			organizationId: ORG_ID,
			scopes: ["*"],
		},
		authType: "apikey",
		db: db as unknown as BaseContext["db"],
		env: {
			ENVIRONMENT: "test",
			TEDI_DEV_BASE_URL: "https://runtime.tedix.test",
			KERNEL: kernelNs,
		} as unknown as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/cognitive-runtime"),
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise);
		},
		waitUntilPromises,
		scheduleWakeAlarmCalls,
	} as unknown as BaseContext & {
		waitUntilPromises: Promise<unknown>[];
		scheduleWakeAlarmCalls: Array<[string, string, string]>;
	};
}

describe("recordEvent inbox-wake parent-lookup fallback", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		mockTedi({ runtimeKind: "agent" });
	});

	const CHILD_RUN = "child-run-fallback-1";
	const PARENT_CONV = "kernel:conv-home-fallback";

	it("resolves homeConversationId from parent kernel_runtime_runs row when runtime.metadata carries none", async () => {
		const parentRow: KernelRunRow = {
			id: "krr-1",
			organizationId: ORG_ID,
			conversationId: PARENT_CONV,
			childRunId: CHILD_RUN,
			childConversationId: null,
			status: "completed",
			delegatedTediId: TEDI_ID,
			inputMessageId: null,
			outputMessageId: null,
			progressValue: null,
			progressLabel: null,
			progressDetail: null,
			latestEventKind: null,
			latestEventAt: null,
			preview: null,
			runtimeBackend: "cloudflare-agents",
			runtimeExternalId: null,
			runtimeExternalUrl: null,
			runtimeMetadata: null,
			metadata: null,
			startedAt: "2026-06-20T00:00:00.000Z",
			completedAt: null,
			createdAt: "2026-06-20T00:00:00.000Z",
			updatedAt: "2026-06-20T00:00:00.000Z",
		};
		const db = createParentLookupDb([parentRow]);
		const ctx = createInboxWakeContext(db);
		const client = createRouterClient(cognitiveRuntimeContractRouter, {
			context: ctx,
		});

		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:qa",
			runId: CHILD_RUN,
			// No homeConversationId in runtime.metadata
			runtime: { backend: "cloudflare-agents", metadata: {} },
			createdAt: "2026-06-20T00:00:00.000Z",
		});

		// Flush waitUntil promises so notifyKernelChildComplete runs.
		await Promise.all(ctx.waitUntilPromises);

		expect(db.wakeRows).toHaveLength(1);
		expect(db.wakeRows[0]?.childRunId).toBe(CHILD_RUN);
		expect(ctx.scheduleWakeAlarmCalls).toHaveLength(1);
		expect(ctx.scheduleWakeAlarmCalls[0]?.[0]).toBe(PARENT_CONV);
	});

	it("resolves a multi-tedi plan parent from metadata.homePlan assignments", async () => {
		const parentRow: KernelRunRow = {
			id: "krr-plan-1",
			organizationId: ORG_ID,
			conversationId: PARENT_CONV,
			childRunId: null,
			childConversationId: null,
			status: "running",
			delegatedTediId: null,
			inputMessageId: null,
			outputMessageId: null,
			progressValue: null,
			progressLabel: null,
			progressDetail: null,
			latestEventKind: null,
			latestEventAt: null,
			preview: null,
			runtimeBackend: "custom",
			runtimeExternalId: null,
			runtimeExternalUrl: null,
			runtimeMetadata: null,
			metadata: {
				homePlan: {
					id: "plan-1",
					status: "dispatching",
					summary: "Two required branches",
					source: "kernelRuntime.plan.v1",
					createdAt: "2026-06-20T00:00:00.000Z",
					assignments: [
						{
							id: "assignment-1",
							ownerTediId: TEDI_ID,
							ownerLabel: "CTO",
							routeKind: "agent",
							objective: "Inspect convergence",
							expectedEvidence: ["Terminal proof"],
							risk: "low",
							confidence: 0.9,
							requiresApproval: true,
							required: true,
							status: "running",
							childRunId: CHILD_RUN,
						},
					],
					dependencies: [],
				},
			},
			startedAt: "2026-06-20T00:00:00.000Z",
			completedAt: null,
			createdAt: "2026-06-20T00:00:00.000Z",
			updatedAt: "2026-06-20T00:00:00.000Z",
		};
		const db = createParentLookupDb([parentRow]);
		const ctx = createInboxWakeContext(db);
		const client = createRouterClient(cognitiveRuntimeContractRouter, {
			context: ctx,
		});

		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:qa",
			runId: CHILD_RUN,
			runtime: { backend: "cloudflare-agents", metadata: {} },
			createdAt: "2026-06-20T00:00:00.000Z",
		});
		await Promise.all(ctx.waitUntilPromises);

		expect(db.wakeRows).toHaveLength(1);
		expect(db.wakeRows[0]?.childRunId).toBe(CHILD_RUN);
		expect(ctx.scheduleWakeAlarmCalls).toHaveLength(1);
		expect(ctx.scheduleWakeAlarmCalls[0]?.[0]).toBe(PARENT_CONV);
	});

	it("does NOT fire a wake when no parent kernel_runtime_runs row exists for the child run", async () => {
		const db = createParentLookupDb([]); // no parent rows
		const ctx = createInboxWakeContext(db);
		const client = createRouterClient(cognitiveRuntimeContractRouter, {
			context: ctx,
		});

		await client.recordEvent({
			tediId: TEDI_ID,
			kind: "run.completed",
			conversationId: "agent:main:qa",
			runId: "child-run-orphan",
			runtime: { backend: "cloudflare-agents", metadata: {} },
			createdAt: "2026-06-20T00:02:00.000Z",
		});

		await Promise.all(ctx.waitUntilPromises);

		expect(db.wakeRows).toHaveLength(0);
		expect(ctx.scheduleWakeAlarmCalls).toHaveLength(0);
	});
});

describe("normalizeRuntimeEvent canonical usage promotion", () => {
	// Minimal row factory — only the columns normalizeRuntimeEvent reads.
	function row(
		payload: Record<string, unknown> | null,
	): typeof tediRuntimeEvents.$inferSelect {
		return {
			id: "evt-run-completed",
			tediId: "tedi-1",
			kind: "run.completed",
			conversationId: "tedi-1:agent:main:qa",
			runId: "tedi-1:mcp:turn-1",
			messageId: null,
			toolCallId: null,
			approvalRequestId: null,
			artifactId: null,
			sequence: 3,
			delta: null,
			payload,
			runtimeBackend: "cloudflare-agents",
			runtimeExternalId: null,
			runtimeExternalUrl: null,
			runtimeMetadata: null,
			createdAt: "2026-06-16T10:00:01.000Z",
		} as unknown as typeof tediRuntimeEvents.$inferSelect;
	}

	it("promotes payload.usage from the REAL run.completed writer payload", () => {
		// EXACT shape the isolate ledger-mirror / kernel turn-work writers emit:
		// the scalar `tokensUsed` PLUS the canonical `usage` breakdown.
		const event = normalizeRuntimeEvent(
			row({
				tokensUsed: 1280,
				usage: {
					provider: "azure-openai",
					model: "gpt-5-1-preview",
					inputTokens: 1200,
					outputTokens: 80,
					cacheReadTokens: null,
					cacheWriteTokens: null,
				},
			}),
		);
		expect(event.usage).toEqual({
			provider: "azure-openai",
			model: "gpt-5-1-preview",
			inputTokens: 1200,
			outputTokens: 80,
			reasoningTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
		});
	});

	it("leaves usage undefined when the payload carries ONLY the scalar tokensUsed (regression guard)", () => {
		// The original bug shape: promoter read `payload.usage` but writers emitted
		// only `tokensUsed`. With the writers fixed this stays a guard — a scalar
		// alone must never be invented into a usage breakdown.
		const event = normalizeRuntimeEvent(row({ tokensUsed: 1280 }));
		expect(event.usage).toBeUndefined();
	});

	it("leaves usage undefined for non-usage events", () => {
		const event = normalizeRuntimeEvent(
			row({ role: "assistant", content: "hi" }),
		);
		expect(event.usage).toBeUndefined();
	});
});

describe("notifyKernelChildApprovalBlock", () => {
	it("mirrors and clears delegated approval blocks through KernelDO state", async () => {
		const db = createWakeDb();
		const ctx = createWakeContext(db);

		await notifyKernelChildApprovalBlock(ctx, {
			childRunId: "child-run-approval",
			childOrganizationId: ORG_ID,
			parentOrganizationId: ORG_ID,
			parentConversationId: "home:approval",
			approvalRequestId: "approval-1",
			delegatedTediId: "tedi-cto",
			blocked: true,
		});
		await notifyKernelChildApprovalBlock(ctx, {
			childRunId: "child-run-approval",
			childOrganizationId: ORG_ID,
			parentOrganizationId: ORG_ID,
			parentConversationId: "home:approval",
			approvalRequestId: "approval-1",
			delegatedTediId: "tedi-cto",
			blocked: false,
		});

		expect(ctx.mirrorChildApprovalBlockedCalls).toEqual([
			{
				parentConversationId: "home:approval",
				childRunId: "child-run-approval",
				approvalRequestId: "approval-1",
				delegatedTediId: "tedi-cto",
			},
		]);
		expect(ctx.clearChildApprovalBlockedCalls).toEqual([
			{
				parentConversationId: "home:approval",
				childRunId: "child-run-approval",
				approvalRequestId: "approval-1",
			},
		]);
	});
});
