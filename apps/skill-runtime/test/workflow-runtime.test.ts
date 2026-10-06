import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import trajectoryMining from "../examples/trajectory-mining/scripts/workflow";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { recordArtifactOnceForRun } from "../src/artifact-immutability";
import {
	clearSkillRunRestartIntent,
	finalizeAbortedSkillRunRestart,
	getSkillRun,
	listNonTerminalRuns,
	loadSkillRunSnapshot,
	reconcileSkillRun,
	reserveSkillRunExecutionEpoch,
	resolveSkillWorkflowMcpGateway,
	skillRunEnvironmentMatches,
	touchSkillRunReconciled,
	updateSkillRunAfterControl,
} from "../src/db";
import {
	assertTenantRuntimeImports,
	DISPATCH_SHIM,
	DYNAMIC_WORKFLOWS_VERSION,
	MCP_COMPLETION_FAILURE_INSPECTOR_SOURCE,
	MCP_PROVIDER_CONFIRMATION_INSPECTOR_SOURCE,
	SENSITIVE_WORKFLOW_ERROR_FACTORY_SOURCE,
	skillRuntimeStubKey,
	TENANT_COMPATIBILITY_FLAGS,
	tenantWorkflowModuleSource,
	WORKFLOW_BRIDGE_COMPATIBILITY_VERSION,
	WORKFLOW_CONTEXT_MODULE,
	WORKFLOW_FETCH_GATE_FACTORY_SOURCE,
	WORKFLOW_FETCH_GATE_MODULE,
} from "../src/runner";
import {
	claimImplicitWorkflowAdmission,
	deriveIdempotentRunId,
	isRecoverableAdmissionFailure,
	pruneExpiredWorkflowAdmissionDedup,
	releaseImplicitWorkflowAdmission,
	workflowAdmissionFingerprint,
	workflowAdmissionJsonEqual,
} from "../src/workflow-admission";
import {
	buildWorkflowApprovalEvent,
	claimWorkflowApprovalDecision,
	finalizeWorkflowApprovalDecision,
	WORKFLOW_APPROVAL_EVENT_TYPE,
	WorkflowApprovalDecisionConflictError,
} from "../src/workflow-approval";
import { mapWorkflowEngineStatus } from "../src/workflow-engine-status";
import { withWorkflowEvidenceRetry } from "../src/workflow-evidence";
import {
	buildWorkflowMcpCallIdentity,
	isWorkflowMcpCallContext,
} from "../src/workflow-identity";
import { encodeWorkflowArtifactPathSegment } from "../src/workflow-path";
import {
	abortAmbiguousWorkflowRestart,
	bindWorkflowRestartExecutionEpoch,
	claimWorkflowRestart,
	finalizeWorkflowRestart,
	fingerprintWorkflowError,
	fingerprintWorkflowOutput,
	getWorkflowExecutionEpochOutcome,
	hasWorkflowExecutionEpochStarted,
	isWorkflowInstanceRetired,
	recordWorkflowExecutionEpochOutcome,
	recordWorkflowExecutionEpochStarted,
	resolveAcceptedWorkflowRestart,
	WorkflowRestartConflictError,
	workflowRestartBarrierState,
} from "../src/workflow-restart";
import { isWorkflowRetirementError } from "../src/workflow-retirement";
import { assertWorkflowExecutionEpochRuntimePin } from "../src/workflow-runtime-pin";
import {
	workflowSubmissionHasAbortIntent,
	workflowSubmissionOutcomeMatches,
} from "../src/workflow-submission";

assert.equal(mapWorkflowEngineStatus("waiting"), "running");
assert.equal(mapWorkflowEngineStatus("waitingForPause"), "paused");
assert.equal(mapWorkflowEngineStatus("terminated"), "canceled");
assert.equal(mapWorkflowEngineStatus("mystery"), null);

assert.equal(isWorkflowRetirementError("REVOKED"), true);
assert.equal(isWorkflowRetirementError("REVOKED: privacy cleanup"), true);
assert.equal(isWorkflowRetirementError("REVOKED_TOKEN_REFRESH_FAILED"), false);
assert.equal(isWorkflowRetirementError("revoked: tenant failure"), false);

function createRestartReceiptDb() {
	const rows = new Map<string, { contentInline: string; outcome: string }>();
	let beforeNextUpdate: (() => void) | null = null;
	return {
		rows,
		beforeNextUpdate(callback: () => void) {
			beforeNextUpdate = callback;
		},
		db: {
			prepare(sql: string) {
				let values: unknown[] = [];
				const statement = {
					bind(...nextValues: unknown[]) {
						values = nextValues;
						return statement;
					},
					async run() {
						if (sql.includes("INSERT INTO skill_run_artifacts")) {
							const key = `${String(values[1])}:${String(values[2])}`;
							if (rows.has(key)) return { meta: { changes: 0 } };
							const prefix = `${String(values[1])}:`;
							const operatorAborted = Array.from(rows).some(
								([existingKey, row]) => {
									if (!existingKey.startsWith(prefix)) return false;
									const parsed = JSON.parse(row.contentInline) as {
										status?: string;
										resolution?: { action?: string };
									};
									return (
										parsed.status === "rejected" &&
										parsed.resolution?.action === "operator_abort"
									);
								},
							);
							if (operatorAborted) return { meta: { changes: 0 } };
							rows.set(key, {
								contentInline: String(values[4]),
								outcome: "pending",
							});
							return { meta: { changes: 1 } };
						}
						if (sql.includes("UPDATE skill_run_artifacts")) {
							const callback = beforeNextUpdate;
							beforeNextUpdate = null;
							callback?.();
							const key = `${String(values[0])}:${String(values[1])}`;
							const existing = rows.get(key);
							const promotion = sql.includes(
								"SET content_inline = ?3, size_bytes = ?4, outcome = 'success'",
							);
							const abort = sql.includes(
								"SET content_inline = ?3, size_bytes = ?4, outcome = 'failure'",
							);
							const epochBinding =
								!promotion &&
								!abort &&
								!sql.includes("size_bytes = ?4, outcome = ?5");
							const expectedContent = String(
								values[epochBinding || promotion || abort ? 4 : 5],
							);
							if (
								existing?.outcome !== "pending" ||
								existing.contentInline !== expectedContent
							) {
								return { meta: { changes: 0 } };
							}
							rows.set(key, {
								contentInline: String(values[2]),
								outcome: epochBinding
									? existing.outcome
									: promotion
										? "success"
										: abort
											? "failure"
											: String(values[4]),
							});
							return { meta: { changes: 1 } };
						}
						throw new Error(`unexpected D1 run: ${sql}`);
					},
					async first() {
						if (sql.includes("SELECT workflow_retired_at")) {
							return { workflow_retired_at: null, error: null };
						}
						if (sql.includes("SELECT 1 AS present")) {
							const prefix = `${String(values[0])}:`;
							for (const [key, row] of rows) {
								if (!key.startsWith(prefix)) continue;
								const parsed = JSON.parse(row.contentInline) as {
									status?: string;
									resolution?: { action?: string };
								};
								if (
									parsed.status === "rejected" &&
									parsed.resolution?.action === "operator_abort"
								) {
									return { present: 1 };
								}
							}
							return null;
						}
						if (!sql.includes("SELECT content_inline")) {
							throw new Error(`unexpected D1 first: ${sql}`);
						}
						const row = rows.get(`${String(values[0])}:${String(values[1])}`);
						return row ? { content_inline: row.contentInline } : null;
					},
				};
				return statement;
			},
		} as unknown as D1Database,
	};
}

function sqliteD1(db: Database): D1Database {
	const prepare = (query: string) => {
		const statement = db.prepare(query);
		let values: Array<null | number | bigint | string | Uint8Array> = [];
		const prepared = {
			bind: (...next: unknown[]) => {
				values = next as typeof values;
				return prepared;
			},
			run: async () => {
				const result = statement.run(...values);
				return {
					success: true,
					meta: {
						changes: Number(result.changes),
						last_row_id: Number(result.lastInsertRowid),
						duration: 0,
					},
				};
			},
			first: async (column?: string) => {
				const row = statement.get(...values) as
					| Record<string, unknown>
					| undefined;
				return column ? (row?.[column] ?? null) : (row ?? null);
			},
			all: async () => ({
				results: statement.all(...values),
				success: true,
				meta: {},
			}),
			raw: async () =>
				(statement.all(...values) as Array<Record<string, unknown>>).map(
					Object.values,
				),
		};
		return prepared;
	};
	return {
		prepare,
		batch: async (statements: Array<{ all: () => Promise<unknown> }>) =>
			Promise.all(statements.map((statement) => statement.all())),
		exec: async (query: string) => {
			db.exec(query);
			return { count: 0, duration: 0 };
		},
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;
}

// Tenant aggregate routing is D1-canonical and organization-scoped. A tedi id
// from another tenant must never select that tenant's aggregate, while the
// configured aggregateTedis namespace wins over slug derivation.
{
	const sqlite = new Database(":memory:");
	sqlite.exec(`
		CREATE TABLE tedis (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			slug TEXT NOT NULL
		);
		CREATE TABLE apps (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			slug TEXT NOT NULL,
			metadata TEXT
		);
	`);
	const insertTedi = sqlite.prepare(
		"INSERT INTO tedis (id, organization_id, slug) VALUES (?, ?, ?)",
	);
	insertTedi.run("worker-a", "org-a", "acme-operator");
	insertTedi.run("worker-b", "org-b", "other-operator");
	const insertApp = sqlite.prepare(
		"INSERT INTO apps (id, organization_id, slug, metadata) VALUES (?, ?, ?, ?)",
	);
	const gatewayMetadata = (tediSlug: string, namespace: string): string =>
		JSON.stringify({
			mcpConfig: {
				authMode: "authenticated",
				codeMode: true,
				aggregateApps: [{ slug: "tedix" }],
				aggregateTedis: [{ slug: tediSlug, namespace }],
			},
		});
	insertApp.run(
		"app-a",
		"org-a",
		"acme-unified",
		gatewayMetadata("acme-operator", "operator"),
	);
	insertApp.run(
		"app-b",
		"org-b",
		"other-unified",
		gatewayMetadata("other-operator", "other_operator"),
	);
	// Looks similar but is not an authenticated Code Mode aggregate.
	insertApp.run(
		"app-decoy",
		"org-a",
		"decoy-unified",
		JSON.stringify({
			mcpConfig: {
				authMode: "authenticated",
				codeMode: false,
				aggregateApps: [{ slug: "tedix" }],
			},
		}),
	);

	assert.deepEqual(
		await resolveSkillWorkflowMcpGateway(sqliteD1(sqlite), "org-a", "worker-a"),
		{ slug: "acme-unified", tediNamespace: "operator" },
	);
	assert.equal(
		await resolveSkillWorkflowMcpGateway(sqliteD1(sqlite), "org-a", "worker-b"),
		null,
	);
	sqlite.close();
}

const baseContext = {
	stepName: "publish report",
	stepCount: 2,
	stepType: "do" as const,
	attempt: 1,
	phase: "run" as const,
	ordinal: 1,
};

// The worker entrypoint transitively imports Cloudflare-only modules. Mock the
// two runtime packages so this standalone Bun test can exercise the pure
// restart fence exported by index.ts without constructing a Worker runtime.
const { mock } = await import("bun:test");
mock.module("cloudflare:workers", () => ({
	WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/dynamic-workflows", () => ({
	DynamicWorkflowBinding: class {},
	createDynamicWorkflowEntrypoint: () => class {},
	wrapWorkflowBinding: (binding: unknown) => binding,
}));
const {
	workflowControlAdmissionConflict,
	workflowControlRestartConflict,
	workflowControlRetiredConflict,
} = await import("../src/index");
const { reconcileWorkflowAbortIntent } = await import("../src/reconciler");

const abortSubmission = {
	sourceKind: "skill_workflow",
	status: "running",
	abortRequestedAt: "2026-07-12T00:00:00.000Z",
	metadata: { workflowExecutionEpoch: 2 },
} as const;
assert.equal(workflowSubmissionHasAbortIntent(abortSubmission, 2), true);
assert.equal(workflowSubmissionHasAbortIntent(abortSubmission, 1), false);
assert.equal(
	workflowSubmissionHasAbortIntent(
		{ ...abortSubmission, status: "reserved" },
		2,
	),
	false,
);
assert.equal(
	workflowSubmissionHasAbortIntent(
		{ ...abortSubmission, sourceKind: "tedi_message" },
		2,
	),
	false,
);

let activeStatus = "running";
let terminateCalls = 0;
const activeAbort = await reconcileWorkflowAbortIntent({
	abortRequested: true,
	engine: { status: activeStatus },
	handle: {
		async terminate() {
			terminateCalls++;
			activeStatus = "terminated";
		},
		async status() {
			return { status: activeStatus };
		},
	},
});
assert.equal(terminateCalls, 1);
assert.equal(activeAbort.terminationRequested, true);
assert.equal(activeAbort.engine.status, "terminated");

let terminalTerminateCalls = 0;
const completedWins = await reconcileWorkflowAbortIntent({
	abortRequested: true,
	engine: { status: "complete" },
	handle: {
		async terminate() {
			terminalTerminateCalls++;
		},
		async status() {
			return { status: "complete" };
		},
	},
});
assert.equal(terminalTerminateCalls, 0);
assert.equal(completedWins.terminationRequested, false);
assert.equal(completedWins.engine.status, "complete");

let ambiguousStatus = "unknown";
const ambiguousTermination = await reconcileWorkflowAbortIntent({
	abortRequested: true,
	engine: { status: ambiguousStatus },
	handle: {
		async terminate() {
			ambiguousStatus = "terminated";
			throw new Error("control response lost");
		},
		async status() {
			return { status: ambiguousStatus };
		},
	},
});
assert.equal(ambiguousTermination.terminationRequested, true);
assert.equal(ambiguousTermination.engine.status, "terminated");

const openRestart = {
	executionEpoch: 8,
	restartRequestedAt: "2026-07-12T00:01:00.000Z",
	restartCommandId: "restart-8",
};
for (const control of [
	"pause",
	"resume",
	"cancel",
	"approve",
	"reject",
	"event",
]) {
	assert.deepEqual(
		workflowControlRestartConflict(openRestart),
		{
			error: "workflow_restart_in_progress",
			executionEpoch: 8,
			restartId: "restart-8",
			message:
				"a native restart is still being durably reconciled; inspect status and retry this control after the restart intent clears",
		},
		`${control} must reject while a restart intent is open`,
	);
}
assert.equal(
	workflowControlRestartConflict({
		...openRestart,
		restartRequestedAt: null,
		restartCommandId: null,
	}),
	null,
);

assert.deepEqual(
	workflowControlAdmissionConflict({
		status: "failed",
		error: "WORKFLOW_ADMISSION_PENDING: awaiting engine acceptance",
	}),
	{
		error: "workflow_admission_pending",
		message:
			"the engine admission result is still being reconciled; inspect status and retry this control after the admission marker clears",
	},
);
assert.equal(
	workflowControlAdmissionConflict({
		status: "failed",
		error: "tenant workflow failed",
	}),
	null,
);
assert.deepEqual(
	workflowControlRetiredConflict({
		workflowRetiredAt: "2026-07-12T00:00:00.000Z",
		error: null,
	}),
	{
		error: "workflow_instance_retired",
		message:
			"this Workflow instance is permanently retired; inspect the run or start a new runId instead of mutating it",
	},
);
assert.ok(
	workflowControlRetiredConflict({
		workflowRetiredAt: null,
		error: "REVOKED: privacy cleanup",
	}),
);
assert.equal(
	workflowControlRetiredConflict({
		workflowRetiredAt: null,
		error: "REVOKED_TOKEN_REFRESH_FAILED",
	}),
	null,
);
assert.equal(
	workflowControlRetiredConflict({ workflowRetiredAt: null, error: null }),
	null,
);

// Every control route rejects a fenced run before its first engine mutation.
// Driven through the Worker's real fetch against one skill_runs row.
const { default: runtimeWorker } = await import("../src/index");
const { WORKFLOW_ADMISSION_CREATE_FAILED } =
	await import("../src/workflow-admission");
async function control(
	route: string,
	body: Record<string, unknown>,
	row: Record<string, unknown>,
) {
	const statements: string[] = [];
	const engine: string[] = [];
	const env = {
		PLATFORM_SERVICE_TOKEN: "service-token",
		ENVIRONMENT: "production",
		DB: {
			prepare: (sql: string) => {
				statements.push(sql.replace(/\s+/g, " ").trim());
				return {
					bind: () => ({
						first: async () =>
							/FROM skill_runs WHERE id/.test(sql)
								? {
										id: "run-1",
										skill_id: "skill-1",
										tedi_id: "tedi-1",
										organization_id: "org-1",
										workflow_instance_id: "wf-1",
										execution_epoch: 1,
										restart_requested_at: null,
										restart_command_id: null,
										workflow_retired_at: null,
										runtime_environment: "production",
										status: "running",
										error: null,
										started_at: "2026-09-01T00:00:00.000Z",
										completed_at: null,
										paused_at: null,
										...row,
									}
								: null,
						all: async () => ({ results: [] }),
						run: async () => ({ success: true, meta: { changes: 0 } }),
					}),
				};
			},
			batch: async () => [],
		},
		WORKFLOWS: new Proxy(
			{},
			{
				get: (_target, method) => async () => {
					engine.push(String(method));
					throw new Error("engine touched");
				},
			},
		),
	};
	const response = await runtimeWorker.fetch!(
		new Request(`https://skill-runtime/${route}`, {
			method: "POST",
			headers: {
				Authorization: "Bearer service-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				runId: "run-1",
				expectedExecutionEpoch: 1,
				...body,
			}),
		}) as never,
		env as never,
		{ waitUntil() {}, passThroughOnException() {} } as never,
	);
	return {
		status: response.status,
		body: (await response.json().catch(() => ({}))) as { error?: string },
		engine,
		writes: statements.filter((sql) => !/^SELECT/i.test(sql)),
	};
}
const fences = [
	[
		{
			restart_requested_at: "2026-09-01T00:01:00.000Z",
			restart_command_id: "r-1",
		},
		"workflow_restart_in_progress",
	],
	[
		{ status: "failed", error: `${WORKFLOW_ADMISSION_CREATE_FAILED}: pending` },
		"workflow_admission_pending",
	],
	[
		{ workflow_retired_at: "2026-09-01T00:02:00.000Z" },
		"workflow_instance_retired",
	],
	[{ error: "REVOKED: key rotated" }, "workflow_instance_retired"],
] as const;
const routeBodies: Record<string, Record<string, unknown>> = {
	pause: {},
	resume: {},
	cancel: {},
	approve: { approvalId: "approval-1" },
	reject: { approvalId: "approval-1" },
	event: { type: "content-approved" },
};
for (const [route, body] of Object.entries(routeBodies)) {
	for (const [row, error] of fences) {
		const result = await control(route, body, row);
		assert.equal(result.status, 409, `/${route} fences ${error}`);
		assert.equal(result.body.error, error);
		assert.deepEqual(result.engine, [], `/${route} must not touch the engine`);
		assert.deepEqual(
			result.writes,
			[],
			`/${route} must not write before the fence`,
		);
	}
}
// /restart reconciles its own intent, but never starts a new epoch while the
// initial admission is ambiguous.
{
	const restartBody = { restartId: "restart-2" };
	const ownIntent = await control("restart", restartBody, fences[0][0]);
	assert.notEqual(ownIntent.body.error, "workflow_restart_in_progress");
	const ambiguous = await control("restart", restartBody, fences[1][0]);
	assert.equal(ambiguous.status, 409);
	assert.equal(ambiguous.body.error, "workflow_admission_pending");
	assert.deepEqual(ambiguous.engine, []);
}

assert.equal(workflowSubmissionOutcomeMatches("settled", "completed"), true);
assert.equal(workflowSubmissionOutcomeMatches("failed", "completed"), false);
assert.equal(workflowSubmissionOutcomeMatches("failed", "failed"), true);
assert.equal(workflowSubmissionOutcomeMatches("canceled", "canceled"), true);

const loaderIdentity = {
	skillId: "skill-1",
	tediId: "tedi-1",
	runId: "00000000-0000-4000-8000-000000000001",
	executionEpoch: 0,
	loaderConfigHash: "a".repeat(64),
};

let evidenceAttempts = 0;
assert.equal(
	await withWorkflowEvidenceRetry(
		"transient-test",
		async () => {
			evidenceAttempts += 1;
			if (evidenceAttempts < 3) throw new Error("transient D1 write");
			return "persisted";
		},
		{ attempts: 3, baseDelayMs: 0 },
	),
	"persisted",
);
assert.equal(evidenceAttempts, 3);
let logicalConflictAttempts = 0;
await assert.rejects(
	withWorkflowEvidenceRetry(
		"conflict-test",
		async () => {
			logicalConflictAttempts += 1;
			throw new Error("WORKFLOW_RESTART_ABORTED: operator won");
		},
		{ attempts: 5, baseDelayMs: 0 },
	),
	/WORKFLOW_RESTART_ABORTED/,
);
assert.equal(logicalConflictAttempts, 1);
const runtimePackage = (await Bun.file(
	new URL("../package.json", import.meta.url),
).json()) as { dependencies?: Record<string, string> };
assert.equal(
	runtimePackage.dependencies?.["@cloudflare/dynamic-workflows"],
	`^${DYNAMIC_WORKFLOWS_VERSION}`,
);
assert.equal(
	WORKFLOW_BRIDGE_COMPATIBILITY_VERSION,
	"v4-os-output-work-item-lineage",
);
const bunLock = await Bun.file(
	new URL("../../../bun.lock", import.meta.url),
).text();
assert.ok(
	bunLock.includes(
		`"@cloudflare/dynamic-workflows@${DYNAMIC_WORKFLOWS_VERSION}"`,
	),
);
assert.equal(
	skillRuntimeStubKey(loaderIdentity),
	skillRuntimeStubKey(loaderIdentity),
);
assert.notEqual(
	skillRuntimeStubKey(loaderIdentity),
	skillRuntimeStubKey({ ...loaderIdentity, loaderConfigHash: "b".repeat(64) }),
);
assert.doesNotThrow(() =>
	assertTenantRuntimeImports(
		'import { NonRetryableError } from "cloudflare:workflows"; export default {};',
	),
);
const runtimeProofSource = await Bun.file(
	new URL("../examples/runtime-proof/scripts/workflow.ts", import.meta.url),
).text();
assert.doesNotThrow(() => assertTenantRuntimeImports(runtimeProofSource));
// Exercise the actual mining asset with only its declared MCP capability.
// Missing REASON/network bindings make accidental inference dependencies fail.
const miningSource = await Bun.file(
	new URL("../examples/trajectory-mining/scripts/workflow.ts", import.meta.url),
).text();
assert.doesNotThrow(() => assertTenantRuntimeImports(miningSource));
const emptyMiningResult = {
	episodesExamined: 0,
	runsExamined: 0,
	patterns: [],
	proposed: [],
	skipped: [],
};
type MiningEnv = Parameters<typeof trajectoryMining.run>[2];
const miningCalls: unknown[] = [];
const miningEnv: MiningEnv = {
	__RUN_CONTEXT__: { tediId: "admitted-tedi" },
	MCP: {
		tedi: {
			mine_skill_candidates: async (input) => {
				miningCalls.push(input);
				return emptyMiningResult;
			},
		},
	},
};
const miningStep: Parameters<typeof trajectoryMining.run>[1] = {
	async do(_name, options, callback) {
		assert.equal(options.retries.limit, 1);
		assert.equal(options.timeout, "2 minutes");
		return callback();
	},
};
const miningResponse = (response: unknown): MiningEnv => ({
	...miningEnv,
	MCP: { tedi: { mine_skill_candidates: async () => response } },
});
assert.equal(
	(await trajectoryMining.run({}, miningStep, miningEnv)).outcome,
	"observation",
);
assert.deepEqual(miningCalls, [
	{
		tediId: "admitted-tedi",
		windowDays: 14,
		minSupport: 3,
		maxProposals: 3,
		dryRun: true,
	},
]);
assert.equal(
	(
		await trajectoryMining.run(
			{ payload: { dryRun: false } },
			miningStep,
			miningEnv,
		)
	).outcome,
	"no_change",
);
const proposalResult = { ...emptyMiningResult, proposed: [{ id: "draft-1" }] };
const proposalOutput = await trajectoryMining.run(
	{ payload: { dryRun: false } },
	miningStep,
	miningResponse(proposalResult),
);
assert.equal(proposalOutput.outcome, "proposal_created");
assert.deepEqual(proposalOutput.proposalIds, ["draft-1"]);
for (const payload of [
	{ tediId: "other-tedi" },
	{ windowDays: 0 },
	{ windowDays: 91 },
	{ minSupport: 2 },
	{ minSupport: 51 },
	{ maxProposals: 0 },
	{ maxProposals: 11 },
	{ maxProposals: 1.5 },
	{ dryRun: "false" },
	[],
]) {
	const before = miningCalls.length;
	await assert.rejects(() =>
		trajectoryMining.run({ payload }, miningStep, miningEnv),
	);
	assert.equal(
		miningCalls.length,
		before,
		"invalid input must fail before MCP",
	);
}
await assert.rejects(
	() =>
		trajectoryMining.run({}, miningStep, {
			...miningEnv,
			__RUN_CONTEXT__: { tediId: "" },
		}),
	/Admitted tedi identity/,
);
for (const response of [
	null,
	{ ok: false },
	{ ...emptyMiningResult, ok: false },
	{ ...emptyMiningResult, episodesExamined: -1 },
	{ ...emptyMiningResult, runsExamined: 0.5 },
	{ ...emptyMiningResult, patterns: null },
	{ ...emptyMiningResult, proposed: [{}] },
	...["failed", "canceled", "partial", "pending"].map((status) => ({
		...emptyMiningResult,
		completionEvidence: { status },
	})),
]) {
	await assert.rejects(() =>
		trajectoryMining.run({}, miningStep, miningResponse(response)),
	);
}
await assert.rejects(
	() =>
		trajectoryMining.run({}, miningStep, {
			...miningEnv,
			MCP: {
				tedi: {
					mine_skill_candidates: async () => {
						throw new Error("platform unavailable");
					},
				},
			},
		}),
	/platform unavailable/,
);
await assert.rejects(
	() => trajectoryMining.run({}, miningStep, miningResponse(proposalResult)),
	/Dry-run unexpectedly/,
);
await assert.rejects(
	() =>
		trajectoryMining.run(
			{ payload: { dryRun: false, maxProposals: 1 } },
			miningStep,
			miningResponse({
				...emptyMiningResult,
				proposed: [{ id: "draft-1" }, { id: "draft-2" }],
			}),
		),
	/proposal cap/,
);
assert.equal(
	(
		await trajectoryMining.run(
			{},
			miningStep,
			miningResponse({
				...emptyMiningResult,
				completionEvidence: { status: "succeeded" },
			}),
		)
	).outcome,
	"observation",
);
assert.match(
	runtimeProofSource,
	/if \(mode === "sensitive-error"\)[\s\S]*throw new NonRetryableError\([\s\S]*TEDIX_SENSITIVE_ERROR_MUST_NOT_PERSIST/,
);
assert.throws(
	() =>
		assertTenantRuntimeImports(
			'import/* tenant bypass */{ env }from"cloudflare:workers"; export default {};',
		),
	/WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED/,
);
assert.throws(
	() =>
		assertTenantRuntimeImports(
			'import { workflowCallContext } from "./workflow-context.js"; export default {};',
		),
	/WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED/,
);
assert.throws(
	() =>
		assertTenantRuntimeImports(
			'import/* comment */("./workflow-context.js"); export default {};',
		),
	/WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED/,
);
assert.throws(
	() =>
		assertTenantRuntimeImports(
			'String(import.meta.url); import("./" + "workflow-context.js"); export default {};',
		),
	/WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED/,
);
assert.throws(
	() =>
		assertTenantRuntimeImports(
			'import("./" + "workflow-context.js"); export default {};',
		),
	/WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED/,
);
assert.throws(
	() =>
		assertTenantRuntimeImports(
			String.raw`import "./workflow-\u0063ontext.js"; export default {};`,
		),
	/WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED/,
);
assert.throws(
	() =>
		assertTenantRuntimeImports(
			'export { env } from "cloudflare:workers"; export default {};',
		),
	/WORKFLOW_RUNTIME_IMPORT_NOT_ALLOWED/,
);

type FetchGateContext = {
	enabled: boolean;
	phase: "run" | "rollback" | "other";
	pendingOperations: Set<unknown>;
};
type FetchGateFactory = (
	getActiveContext: () => FetchGateContext | undefined,
	platformFetch: (...args: unknown[]) => Promise<unknown>,
	createBlockedError: () => Error,
	createOperation: (callback: () => Promise<unknown>) => Promise<unknown>,
	trackOperation: (
		active: FetchGateContext,
		operation: Promise<unknown>,
	) => Promise<unknown>,
	rejectOperation: (error: Error) => Promise<never>,
	prepareRequestArgs?: (args: unknown[]) => unknown[],
	validateResponse?: (response: unknown) => unknown,
) => (...args: unknown[]) => Promise<unknown>;
const createWorkflowFetchGate = new Function(
	`"use strict"; ${WORKFLOW_FETCH_GATE_FACTORY_SOURCE}; return createWorkflowFetchGate;`,
)() as FetchGateFactory;
const fetchCallContext = new AsyncLocalStorage<FetchGateContext>();
const forwardedFetches: unknown[][] = [];
const createTestFetchOperation = (callback: () => Promise<unknown>) =>
	Promise.resolve().then(callback);
const trackTestFetchOperation = (
	active: FetchGateContext,
	operation: Promise<unknown>,
) => {
	active.pendingOperations.add(operation);
	void operation.then(
		() => active.pendingOperations.delete(operation),
		() => active.pendingOperations.delete(operation),
	);
	return operation;
};
const rejectTestFetchOperation = (error: Error) => Promise.reject(error);
const gatedFetch = createWorkflowFetchGate(
	() => fetchCallContext.getStore(),
	async (...args) => {
		forwardedFetches.push(args);
		return { ok: true, input: args[0] };
	},
	() => new Error("WORKFLOW_NETWORK_OUTSIDE_STEP"),
	createTestFetchOperation,
	trackTestFetchOperation,
	rejectTestFetchOperation,
);
await assert.rejects(
	() => gatedFetch("https://outside.example"),
	/WORKFLOW_NETWORK_OUTSIDE_STEP/,
);
const aliasedFetch = gatedFetch;
await assert.rejects(
	() => aliasedFetch("https://alias.example"),
	/WORKFLOW_NETWORK_OUTSIDE_STEP/,
);
const computedGlobal = { fetch: gatedFetch };
const computedFetchKey: keyof typeof computedGlobal = "fetch";
await assert.rejects(
	() => computedGlobal[computedFetchKey]("https://computed.example"),
	/WORKFLOW_NETWORK_OUTSIDE_STEP/,
);
assert.equal(forwardedFetches.length, 0);

const activeFetchContext: FetchGateContext = {
	enabled: true,
	phase: "run",
	pendingOperations: new Set(),
};
assert.deepEqual(
	await fetchCallContext.run(activeFetchContext, () =>
		gatedFetch("https://inside.example"),
	),
	{
		ok: true,
		input: "https://inside.example",
	},
);
assert.equal(forwardedFetches.length, 1);
activeFetchContext.enabled = false;
await assert.rejects(
	() =>
		fetchCallContext.run(activeFetchContext, () =>
			aliasedFetch("https://floated.example"),
		),
	/WORKFLOW_NETWORK_OUTSIDE_STEP/,
);
await fetchCallContext.run(
	{ enabled: true, phase: "rollback", pendingOperations: new Set() },
	() => gatedFetch("https://rollback.example"),
);
assert.equal(forwardedFetches.length, 2);
await assert.rejects(
	() =>
		fetchCallContext.run(
			{ enabled: true, phase: "other", pendingOperations: new Set() },
			() => gatedFetch("https://other.example"),
		),
	/WORKFLOW_NETWORK_OUTSIDE_STEP/,
);

let releaseFloatedFetch: (() => void) | undefined;
const floatedGate = createWorkflowFetchGate(
	() => fetchCallContext.getStore(),
	() =>
		new Promise((resolve) => {
			releaseFloatedFetch = () => resolve({ ok: true });
		}),
	() => new Error("WORKFLOW_NETWORK_OUTSIDE_STEP"),
	createTestFetchOperation,
	trackTestFetchOperation,
	rejectTestFetchOperation,
);
const floatedContext: FetchGateContext = {
	enabled: true,
	phase: "run",
	pendingOperations: new Set(),
};
await fetchCallContext.run(floatedContext, async () => {
	const floated = floatedGate("https://floated-but-tracked.example");
	// Even when tenant code does not immediately await the request, the shared
	// context exposes it to the dispatch shim's drain before the step can close.
	assert.equal(floatedContext.pendingOperations.size, 1);
	await Promise.resolve();
	releaseFloatedFetch?.();
	await floated;
	await Promise.resolve();
	assert.equal(floatedContext.pendingOperations.size, 0);
});

const tenantModule = tenantWorkflowModuleSource(
	"globalThis.__tenantBodyEvaluated = true; export default {};",
);
assert.match(DISPATCH_SHIM, /BACKGROUND_ELIGIBILITY_REQUIRED/);
assert.match(DISPATCH_SHIM, /BACKGROUND_ELIGIBILITY_INVALID/);
assert.match(DISPATCH_SHIM, /BACKGROUND_INPUT_UNAVAILABLE/);
assert.match(DISPATCH_SHIM, /BACKGROUND_OUTCOME_REQUIRED/);
assert.ok(
	DISPATCH_SHIM.indexOf("await target.eligibility") <
		DISPATCH_SHIM.indexOf("await target.run"),
);
assert.match(DISPATCH_SHIM, /path: "background\/eligibility\.json"/);
assert.match(DISPATCH_SHIM, /path: "background\/outcome\.json"/);
assert.ok(
	tenantModule.indexOf("installWorkflowFetchGate();") <
		tenantModule.indexOf("globalThis.__tenantBodyEvaluated"),
);
assert.match(WORKFLOW_CONTEXT_MODULE, /new AsyncLocalStorage\(\)/);
assert.match(
	WORKFLOW_FETCH_GATE_MODULE,
	/apply\(nativeDefineProperty, NativeObject, \[globalThis, "fetch"/,
);
assert.match(
	DISPATCH_SHIM,
	/import \{ workflowCallContext \} from "\.\/workflow-context\.js"/,
);
assert.match(DISPATCH_SHIM, /drainWorkflowOperations\(active\)/);
assert.match(
	DISPATCH_SHIM,
	/WORKFLOW_INVALID_EVENT_TYPE: event type must use 1-100 letters, digits, hyphens, or underscores/,
);
assert.match(
	DISPATCH_SHIM,
	/return trackWorkflowOperation\(active, operation\)/,
);
assert.match(
	WORKFLOW_FETCH_GATE_MODULE,
	/while \(apply\(nativeSetSize, active\.pendingOperations, \[\]\) > 0\)/,
);
assert.match(
	WORKFLOW_FETCH_GATE_MODULE,
	/const outcomes = await allSettledWorkflowPromises/,
);
assert.match(WORKFLOW_FETCH_GATE_MODULE, /WORKFLOW_CACHE_API_DISABLED/);
assert.match(WORKFLOW_FETCH_GATE_MODULE, /WORKFLOW_WEBSOCKET_DISABLED/);
assert.match(WORKFLOW_FETCH_GATE_MODULE, /\[globalThis, "WebSocket", \{/);
assert.match(WORKFLOW_FETCH_GATE_MODULE, /hardenWorkflowPrimordials\(\)/);
assert.doesNotMatch(
	WORKFLOW_FETCH_GATE_MODULE,
	/NonRetryableError,\s*NonRetryableError\.prototype/,
);
assert.match(
	WORKFLOW_FETCH_GATE_MODULE,
	/NonRetryableError\.prototype, "name"/,
);
assert.match(WORKFLOW_FETCH_GATE_MODULE, /WORKFLOW_EVENT_SOURCE_DISABLED/);
assert.match(WORKFLOW_FETCH_GATE_MODULE, /WORKFLOW_BEACON_DISABLED/);
assert.match(WORKFLOW_FETCH_GATE_MODULE, /BlockedWorkflowWebSocketPair/);
assert.match(
	WORKFLOW_FETCH_GATE_MODULE,
	/\[nativeNavigatorPrototype, "sendBeacon", \{/,
);
assert.match(
	WORKFLOW_FETCH_GATE_MODULE,
	/\[NativeWebSocket\.prototype, "constructor", \{/,
);
for (const authority of [
	"fetch",
	"WebSocket",
	"WebSocketPair",
	"EventSource",
]) {
	assert.match(
		WORKFLOW_FETCH_GATE_MODULE,
		new RegExp(`\\[nativeGlobalPrototype, "${authority}", \\{`),
	);
}
assert.match(WORKFLOW_FETCH_GATE_MODULE, /sec-websocket-key/);
assert.match(WORKFLOW_FETCH_GATE_MODULE, /response && response\.webSocket/);
assert.ok(TENANT_COMPATIBILITY_FLAGS.includes("disallow_eval_during_startup"));
assert.ok(TENANT_COMPATIBILITY_FLAGS.includes("disallow_importable_env"));
assert.match(DISPATCH_SHIM, /active\.sensitiveEvidence/);
assert.match(DISPATCH_SHIM, /redactedMcpEvidence\(\)/);
assert.match(DISPATCH_SHIM, /durationMs: undefined/);
const fetchGateImportSuffix = '} from "./workflow-fetch-gate.js";';
const fetchGateImportEnd = DISPATCH_SHIM.indexOf(fetchGateImportSuffix);
const fetchGateImportStart = DISPATCH_SHIM.lastIndexOf(
	"import {",
	fetchGateImportEnd,
);
assert.ok(
	fetchGateImportStart >= 0 && fetchGateImportEnd > fetchGateImportStart,
	"dispatch shim must import the workflow fetch gate",
);
const fetchGateImportNames = DISPATCH_SHIM.slice(
	fetchGateImportStart + "import {".length,
	fetchGateImportEnd,
);
for (const importedName of fetchGateImportNames
	.split(",")
	.map((name) => name.trim())
	.filter(Boolean)) {
	const escapedName = importedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	assert.match(
		WORKFLOW_FETCH_GATE_MODULE,
		new RegExp(
			`export (?:async )?function ${escapedName}\\b|export \\{[^}]*\\b${escapedName}\\b`,
		),
		`workflow-fetch-gate.js must export ${importedName}`,
	);
}
assert.match(
	WORKFLOW_FETCH_GATE_MODULE,
	/export \{ createSensitiveWorkflowError \};/,
);
class TestNonRetryableError extends Error {}
const createSensitiveWorkflowError = new Function(
	"NonRetryableError",
	"createWorkflowError",
	"apply",
	"nativeDefineProperty",
	"NativeObject",
	`${SENSITIVE_WORKFLOW_ERROR_FACTORY_SOURCE}; return createSensitiveWorkflowError;`,
)(
	TestNonRetryableError,
	(message: string) => new Error(message),
	Reflect.apply,
	Object.defineProperty,
	Object,
) as (error: Error) => Error & { code?: string };
const outwardSensitiveError = createSensitiveWorkflowError(
	new Error("provider-secret-token"),
);
assert.doesNotMatch(outwardSensitiveError.message, /provider-secret-token/);
assert.equal(outwardSensitiveError.code, "WORKFLOW_SENSITIVE_ERROR_REDACTED");
assert.equal(outwardSensitiveError.name, "SensitiveWorkflowStepError");
assert.equal(outwardSensitiveError instanceof TestNonRetryableError, false);
const rawNonRetryable = new TestNonRetryableError("provider-secret-token");
const outwardNonRetryable = createSensitiveWorkflowError(rawNonRetryable);
assert.doesNotMatch(outwardNonRetryable.message, /provider-secret-token/);
assert.equal(outwardNonRetryable.code, "WORKFLOW_SENSITIVE_ERROR_REDACTED");
assert.equal(outwardNonRetryable.name, "Error");
assert.ok(outwardNonRetryable instanceof TestNonRetryableError);
assert.match(DISPATCH_SHIM, /const meta = freezeWorkflowValue/);
assert.doesNotMatch(DISPATCH_SHIM, /Promise\.reject/);
assert.doesNotMatch(DISPATCH_SHIM, /new AsyncLocalStorage\(\)/);

assert.equal(
	encodeWorkflowArtifactPathSegment("hidden..step"),
	"x:hidden%2E%2Estep",
);
for (const name of [".", ".."]) {
	const segment = encodeWorkflowArtifactPathSegment(name);
	const url = new URL(
		`skill://demo/runs/run-1/epochs/0/steps/${segment}/1/attempts/1.json`,
	);
	assert.ok(
		url.pathname.includes(`/steps/${segment}/`),
		`${name} must survive WHATWG URL path canonicalization`,
	);
}
assert.throws(
	() => encodeWorkflowArtifactPathSegment("🧪".repeat(100)),
	/between 1 and 160/,
);
assert.throws(() => encodeWorkflowArtifactPathSegment(""), /between 1 and 160/);

const first = await buildWorkflowMcpCallIdentity({
	runId: "00000000-0000-4000-8000-000000000001",
	executionEpoch: 0,
	namespace: "cms",
	method: "publish",
	context: baseContext,
});
const retry = await buildWorkflowMcpCallIdentity({
	runId: "00000000-0000-4000-8000-000000000001",
	executionEpoch: 0,
	namespace: "cms",
	method: "publish",
	context: { ...baseContext, attempt: 2 },
});
assert.equal(first.stepId, retry.stepId);
assert.equal(first.idempotencyKey, retry.idempotencyKey);
assert.notEqual(first.callId, retry.callId);

const nextCall = await buildWorkflowMcpCallIdentity({
	runId: "00000000-0000-4000-8000-000000000001",
	executionEpoch: 0,
	namespace: "cms",
	method: "publish",
	context: { ...baseContext, ordinal: 2 },
});
assert.notEqual(first.idempotencyKey, nextCall.idempotencyKey);

const restarted = await buildWorkflowMcpCallIdentity({
	runId: "00000000-0000-4000-8000-000000000001",
	executionEpoch: 1,
	namespace: "cms",
	method: "publish",
	context: baseContext,
});
assert.notEqual(first.stepId, restarted.stepId);
assert.notEqual(first.idempotencyKey, restarted.idempotencyKey);
assert.equal(isWorkflowMcpCallContext(baseContext), true);
assert.equal(isWorkflowMcpCallContext({ ...baseContext, ordinal: 0 }), false);

const deterministicRunId = await deriveIdempotentRunId({
	orgId: "org-1",
	skillId: "skill-1",
	tediId: "tedi-1",
	runtimeEnvironment: "production",
	idempotencyKey: "weekly-2026-07-11",
});
assert.equal(
	deterministicRunId,
	await deriveIdempotentRunId({
		orgId: "org-1",
		skillId: "skill-1",
		tediId: "tedi-1",
		runtimeEnvironment: "production",
		idempotencyKey: "weekly-2026-07-11",
	}),
);
assert.notEqual(
	deterministicRunId,
	await deriveIdempotentRunId({
		orgId: "org-1",
		skillId: "skill-1",
		tediId: "tedi-1",
		runtimeEnvironment: "development",
		idempotencyKey: "weekly-2026-07-11",
	}),
);
assert.match(
	deterministicRunId,
	/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const implicitAdmissionIdentity = {
	orgId: "org-1",
	skillId: "skill-1",
	tediId: "tedi-1",
	runtimeEnvironment: "production" as const,
	skillRevision: 3,
	params: { nested: { b: 2, a: 1 }, mode: "proof" },
	workflowSource: "export default {}",
	skillDoc: "---",
	capabilityManifest: { network: false },
	workItemId: null,
	originTediRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const implicitAdmissionFingerprint = await workflowAdmissionFingerprint(
	implicitAdmissionIdentity,
);
assert.equal(
	implicitAdmissionFingerprint,
	await workflowAdmissionFingerprint({
		...implicitAdmissionIdentity,
		params: { mode: "proof", nested: { a: 1, b: 2 } },
	}),
);
assert.notEqual(
	implicitAdmissionFingerprint,
	await workflowAdmissionFingerprint({
		...implicitAdmissionIdentity,
		params: { mode: "publish", nested: { a: 1, b: 2 } },
	}),
);
assert.notEqual(
	implicitAdmissionFingerprint,
	await workflowAdmissionFingerprint({
		...implicitAdmissionIdentity,
		originTediRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	}),
);
const implicitAdmissionSqlite = new Database(":memory:");
implicitAdmissionSqlite.exec(`
	CREATE TABLE skill_run_admission_dedup (
		fingerprint TEXT PRIMARY KEY NOT NULL,
		run_id TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		created_at TEXT NOT NULL
	);
`);
const implicitAdmissionDb = sqliteD1(implicitAdmissionSqlite);
const firstImplicitClaim = await claimImplicitWorkflowAdmission({
	db: implicitAdmissionDb,
	fingerprint: implicitAdmissionFingerprint,
	candidateRunId: "run-a",
	now: new Date("2026-07-24T10:00:00.000Z"),
	windowMs: 60_000,
});
assert.deepEqual(firstImplicitClaim, {
	runId: "run-a",
	deduplicated: false,
	fingerprint: implicitAdmissionFingerprint,
	expiresAt: "2026-07-24T10:01:00.000Z",
});
const duplicateImplicitClaim = await claimImplicitWorkflowAdmission({
	db: implicitAdmissionDb,
	fingerprint: implicitAdmissionFingerprint,
	candidateRunId: "run-b",
	now: new Date("2026-07-24T10:00:30.000Z"),
	windowMs: 60_000,
});
assert.equal(duplicateImplicitClaim.runId, "run-a");
assert.equal(duplicateImplicitClaim.deduplicated, true);
const expiredImplicitClaim = await claimImplicitWorkflowAdmission({
	db: implicitAdmissionDb,
	fingerprint: implicitAdmissionFingerprint,
	candidateRunId: "run-c",
	now: new Date("2026-07-24T10:01:00.000Z"),
	windowMs: 60_000,
});
assert.equal(expiredImplicitClaim.runId, "run-c");
assert.equal(expiredImplicitClaim.deduplicated, false);
await releaseImplicitWorkflowAdmission({
	db: implicitAdmissionDb,
	fingerprint: implicitAdmissionFingerprint,
	runId: "run-c",
});
const releasedImplicitClaim = await claimImplicitWorkflowAdmission({
	db: implicitAdmissionDb,
	fingerprint: implicitAdmissionFingerprint,
	candidateRunId: "run-d",
	now: new Date("2026-07-24T10:01:10.000Z"),
	windowMs: 60_000,
});
assert.equal(releasedImplicitClaim.runId, "run-d");
await pruneExpiredWorkflowAdmissionDedup(
	implicitAdmissionDb,
	new Date("2026-07-26T10:01:10.000Z"),
);
assert.deepEqual(
	implicitAdmissionSqlite
		.prepare("SELECT COUNT(*) AS count FROM skill_run_admission_dedup")
		.get(),
	{ count: 0 },
);
assert.equal(
	workflowAdmissionJsonEqual(
		{ mode: "proof", nested: { b: 2, a: 1 } },
		{ nested: { a: 1, b: 2 }, mode: "proof" },
	),
	true,
);
assert.equal(
	workflowAdmissionJsonEqual({ mode: "proof" }, { mode: "publish" }),
	false,
);
assert.equal(
	isRecoverableAdmissionFailure({
		status: "failed",
		error: "WORKFLOW_ADMISSION_CREATE_FAILED: transport unavailable",
		executionStarted: false,
	}),
	true,
);
assert.equal(
	isRecoverableAdmissionFailure({
		status: "failed",
		error: "workflow step failed",
		executionStarted: false,
	}),
	false,
);
assert.equal(
	isRecoverableAdmissionFailure({
		status: "failed",
		error: "WORKFLOW_ADMISSION_CREATE_FAILED: ambiguous",
		executionStarted: true,
	}),
	false,
);

const snapshotSqlite = new Database(":memory:");
snapshotSqlite.exec(`
	CREATE TABLE skill_runs (
		id TEXT PRIMARY KEY NOT NULL,
		skill_id TEXT NOT NULL,
		tedi_id TEXT NOT NULL,
		organization_id TEXT NOT NULL,
		params TEXT,
		execution_epoch INTEGER NOT NULL DEFAULT 0,
		runtime_environment TEXT NOT NULL,
		workflow_retired_at TEXT,
		error TEXT,
		started_at TEXT NOT NULL,
		skill_slug TEXT,
		skill_revision INTEGER,
		workflow_source TEXT,
		skill_doc TEXT,
		capability_manifest TEXT,
		created_by TEXT,
		work_item_id TEXT,
		origin_tedi_run_id TEXT
	);
	INSERT INTO skill_runs (
		id, skill_id, tedi_id, organization_id, params, execution_epoch,
		runtime_environment, started_at, skill_slug, skill_revision, workflow_source, skill_doc,
		capability_manifest
	) VALUES (
		'run-snapshot', 'skill-1', 'tedi-1', 'org-1', '{"mode":"proof"}', 2,
		'production',
		'2026-07-11T10:00:00.000Z', 'proof', 3, 'export default {}', '---',
		'{"network":false}'
	);
	INSERT INTO skill_runs (
		id, skill_id, tedi_id, organization_id, params, execution_epoch,
		runtime_environment, workflow_retired_at, error, started_at,
		skill_slug, skill_revision, workflow_source, skill_doc, capability_manifest
	) VALUES
		('run-retired-snapshot', 'skill-1', 'tedi-1', 'org-1', '{}', 2,
		 'production', '2026-07-11T10:01:00.000Z', NULL,
		 '2026-07-11T10:00:00.000Z', 'proof', 3, 'export default {}', '---', '{}'),
		('run-legacy-revoked-snapshot', 'skill-1', 'tedi-1', 'org-1', '{}', 2,
		 'production', NULL, 'REVOKED: privacy cleanup',
		 '2026-07-11T10:00:00.000Z', 'proof', 3, 'export default {}', '---', '{}'),
		('run-revoked-token-snapshot', 'skill-1', 'tedi-1', 'org-1', '{}', 2,
		 'production', NULL, 'REVOKED_TOKEN_REFRESH_FAILED',
		 '2026-07-11T10:00:00.000Z', 'proof', 3, 'export default {}', '---', '{}');
`);
const pinnedSnapshot = await loadSkillRunSnapshot(
	sqliteD1(snapshotSqlite),
	"run-snapshot",
);
assert.equal(pinnedSnapshot?.admittedAt, "2026-07-11T10:00:00.000Z");
assert.equal(pinnedSnapshot?.executionEpoch, 2);
assert.equal(pinnedSnapshot?.runtimeEnvironment, "production");
assert.deepEqual(pinnedSnapshot?.params, { mode: "proof" });
assert.equal(
	await loadSkillRunSnapshot(sqliteD1(snapshotSqlite), "run-retired-snapshot"),
	null,
);
assert.equal(
	await loadSkillRunSnapshot(
		sqliteD1(snapshotSqlite),
		"run-legacy-revoked-snapshot",
	),
	null,
);
assert.ok(
	await loadSkillRunSnapshot(
		sqliteD1(snapshotSqlite),
		"run-revoked-token-snapshot",
	),
);
assert.equal(skillRunEnvironmentMatches("production", "production"), true);
assert.equal(skillRunEnvironmentMatches("production", "development"), false);
assert.equal(skillRunEnvironmentMatches("staging", "staging"), true);
assert.equal(skillRunEnvironmentMatches("staging", "production"), false);

const environmentSqlite = new Database(":memory:");
environmentSqlite.exec(`
	CREATE TABLE skill_runs (
		id TEXT PRIMARY KEY NOT NULL,
		skill_id TEXT NOT NULL,
		tedi_id TEXT NOT NULL,
		organization_id TEXT NOT NULL,
		workflow_instance_id TEXT,
		execution_epoch INTEGER NOT NULL DEFAULT 0,
		restart_requested_at TEXT,
		restart_command_id TEXT,
		workflow_retired_at TEXT,
		runtime_environment TEXT NOT NULL,
		status TEXT NOT NULL,
		error TEXT,
		started_at TEXT NOT NULL,
		completed_at TEXT,
		paused_at TEXT
	);
		INSERT INTO skill_runs VALUES
		('prod-run', 'skill-1', 'tedi-1', 'org-1', 'prod-run', 0, NULL, NULL, NULL, 'production', 'running', NULL, '2026-07-11T00:00:00.000Z', NULL, NULL),
		('stage-run', 'skill-1', 'tedi-1', 'org-1', 'stage-run', 0, NULL, NULL, NULL, 'staging', 'running', NULL, '2026-07-11T00:00:00.000Z', NULL, NULL);
`);
const environmentDb = sqliteD1(environmentSqlite);
assert.equal(
	(await getSkillRun(environmentDb, "prod-run", "production"))?.runId,
	"prod-run",
);
assert.equal(await getSkillRun(environmentDb, "stage-run", "production"), null);
const immutableArtifactSqlite = new Database(":memory:");
immutableArtifactSqlite.exec(`
	CREATE TABLE skill_runs (
		id TEXT PRIMARY KEY NOT NULL,
		execution_epoch INTEGER NOT NULL DEFAULT 0,
		restart_requested_at TEXT,
		restart_command_id TEXT,
		workflow_retired_at TEXT,
		status TEXT NOT NULL DEFAULT 'completed',
		result TEXT,
		error TEXT,
		cost_summary TEXT,
		started_at TEXT DEFAULT CURRENT_TIMESTAMP,
		completed_at TEXT,
		paused_at TEXT
	);
	CREATE TABLE skill_run_artifacts (
		id TEXT PRIMARY KEY NOT NULL,
		run_id TEXT NOT NULL,
		path TEXT NOT NULL,
		mime_type TEXT NOT NULL DEFAULT 'application/json',
		size_bytes INTEGER NOT NULL DEFAULT 0,
		content_inline TEXT,
		content_r2_key TEXT,
		sha256 TEXT,
		attempt INTEGER NOT NULL DEFAULT 1,
		outcome TEXT NOT NULL DEFAULT 'success',
		created_at TEXT DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(run_id, path)
	);
	INSERT INTO skill_runs (id, restart_requested_at) VALUES
		('run-1', NULL),
		('run-revoked-token-collision', NULL),
		('run-abort-wins', NULL),
		('run-concurrent-abort', NULL),
		('run-start-wins', NULL),
		('run-open-restart', '2026-07-12T00:00:00.000Z'),
		('run-malformed-control', NULL);
`);
const immutableArtifactDb = sqliteD1(immutableArtifactSqlite);
immutableArtifactSqlite
	.prepare("UPDATE skill_runs SET status = 'running', error = ? WHERE id = ?")
	.run("REVOKED_TOKEN_REFRESH_FAILED", "run-revoked-token-collision");
assert.equal(
	await isWorkflowInstanceRetired(
		immutableArtifactDb,
		"run-revoked-token-collision",
	),
	false,
);
await recordWorkflowExecutionEpochStarted({
	db: immutableArtifactDb,
	runId: "run-revoked-token-collision",
	executionEpoch: 0,
});
assert.equal(
	await hasWorkflowExecutionEpochStarted(
		immutableArtifactDb,
		"run-revoked-token-collision",
		0,
	),
	true,
);
const collisionApproval = await claimWorkflowApprovalDecision({
	db: immutableArtifactDb,
	runId: "run-revoked-token-collision",
	executionEpoch: 0,
	approvalId: "token-refresh-review",
	decision: "approved",
	payload: {},
});
assert.equal(collisionApproval.deduplicated, false);
const collisionRestart = await claimWorkflowRestart({
	db: immutableArtifactDb,
	runId: "run-revoked-token-collision",
	restartId: "token-refresh-retry",
});
assert.equal(collisionRestart.deduplicated, false);
const sealed = await recordArtifactOnceForRun(immutableArtifactDb, "run-1", {
	path: "inputs.json",
	value: { version: 1 },
});
// Sealed bytes are content-addressed at admission.
assert.equal(sealed.sha256, await sha256Hex('{"version":1}'));
assert.equal(sealed.divergent, false);
// A replay presenting the same bytes is a benign no-op, not drift.
const replayed = await recordArtifactOnceForRun(immutableArtifactDb, "run-1", {
	path: "inputs.json",
	value: { version: 1 },
});
assert.equal(replayed.divergent, false);
assert.equal(replayed.sha256, sealed.sha256);
// A replay presenting different bytes cannot rewrite history, and says so.
const originalArtifactWarn = console.warn;
const artifactWarnings: unknown[] = [];
console.warn = (...values: unknown[]) => artifactWarnings.push(...values);
let diverged: Awaited<ReturnType<typeof recordArtifactOnceForRun>>;
try {
	diverged = await recordArtifactOnceForRun(immutableArtifactDb, "run-1", {
		path: "inputs.json",
		value: { version: 2 },
	});
} finally {
	console.warn = originalArtifactWarn;
}
assert.equal(diverged.divergent, true);
assert.equal(diverged.sha256, sealed.sha256);
assert.deepEqual(artifactWarnings, [
	{
		component: "skill-runtime.warning",
		service: "skill-runtime",
		event: "artifact.immutable_divergence",
		runId: "run-1",
		message: "Skill runtime diagnostic",
	},
]);
assert.doesNotMatch(JSON.stringify(artifactWarnings), /inputs\.json/);
assert.doesNotMatch(
	JSON.stringify(artifactWarnings),
	new RegExp(sealed.sha256!),
);
const sealedRow = immutableArtifactSqlite
	.prepare(
		"SELECT content_inline, sha256 FROM skill_run_artifacts WHERE run_id = 'run-1' AND path = 'inputs.json'",
	)
	.get() as { content_inline: string; sha256: string };
assert.equal(sealedRow.content_inline, '{"version":1}');
// The persisted digest still verifies the persisted bytes.
assert.equal(sealedRow.sha256, await sha256Hex(sealedRow.content_inline));
const immutableObjects = new Map<string, string>();
const immutableBucket = {
	put: async (key: string, value: string) => {
		immutableObjects.set(key, value);
	},
	delete: async (key: string) => {
		immutableObjects.delete(key);
	},
} as unknown as R2Bucket;
const largeImmutable = await recordArtifactOnceForRun(
	immutableArtifactDb,
	"run-1",
	{ path: "inputs-large.json", value: "x".repeat(17_000) },
	immutableBucket,
);
await recordArtifactOnceForRun(
	immutableArtifactDb,
	"run-1",
	{ path: "inputs-large.json", value: "y".repeat(17_000) },
	immutableBucket,
);
assert.equal(largeImmutable.storage, "r2");
assert.equal(immutableObjects.size, 1);
// R2-spilled evidence is content-addressed too — the digest covers the bytes
// in the bucket, and D1 holds it even though D1 never stores the payload.
assert.equal(
	largeImmutable.sha256,
	await sha256Hex(JSON.stringify("x".repeat(17_000))),
);
assert.equal(
	(
		immutableArtifactSqlite
			.prepare(
				"SELECT sha256 FROM skill_run_artifacts WHERE run_id = 'run-1' AND path = 'inputs-large.json'",
			)
			.get() as { sha256: string }
	).sha256,
	largeImmutable.sha256,
);
assert.equal(
	immutableObjects.get(
		(
			immutableArtifactSqlite
				.prepare(
					"SELECT content_r2_key FROM skill_run_artifacts WHERE run_id = 'run-1' AND path = 'inputs-large.json'",
				)
				.get() as { content_r2_key: string }
		).content_r2_key,
	),
	JSON.stringify("x".repeat(17_000)),
);

const runtimePin = {
	executionEpoch: 0,
	provenance: {
		source: {
			workflowSha256: "1".repeat(64),
			skillDocSha256: "2".repeat(64),
			skillRevision: 7,
			skillSlug: "runtime-pin-proof",
		},
		runtime: {
			workerVersionId: "worker-v1",
			workerVersionTag: "production",
			workerVersionTimestamp: "2026-07-13T00:00:00.000Z",
			executionCompatibilityHash: "c".repeat(64),
			dispatchShimVersion: "v1",
			compatibilityDate: "2026-06-11",
			dynamicWorkflowsVersion: "0.1.1",
			loaderConfigHash: "a".repeat(64),
			tenantCpuMs: 60_000,
			tenantSubRequests: 1_000,
		},
	},
};
await assertWorkflowExecutionEpochRuntimePin({
	db: immutableArtifactDb,
	runId: "run-1",
	pin: runtimePin,
});
// Same-runtime factory re-entry is a benign replay.
await assertWorkflowExecutionEpochRuntimePin({
	db: immutableArtifactDb,
	runId: "run-1",
	pin: runtimePin,
});
// A deploy or credential rotation selects a fresh immutable Loader config, but
// the same tenant-visible execution surface may safely resume the epoch.
await assertWorkflowExecutionEpochRuntimePin({
	db: immutableArtifactDb,
	runId: "run-1",
	pin: {
		...runtimePin,
		provenance: {
			...runtimePin.provenance,
			runtime: {
				...runtimePin.provenance.runtime,
				workerVersionId: "worker-v2",
				loaderConfigHash: "b".repeat(64),
			},
		},
	},
});
await assert.rejects(
	assertWorkflowExecutionEpochRuntimePin({
		db: immutableArtifactDb,
		runId: "run-1",
		pin: {
			...runtimePin,
			provenance: {
				...runtimePin.provenance,
				runtime: {
					...runtimePin.provenance.runtime,
					workerVersionId: "worker-v3",
					executionCompatibilityHash: "e".repeat(64),
					loaderConfigHash: "d".repeat(64),
				},
			},
		},
	}),
	/WORKFLOW_RUNTIME_DRIFT_BLOCKED: execution epoch 0 is pinned to execution surface.*restart the workflow/,
);
const {
	executionCompatibilityHash: _removedExecutionCompatibilityHash,
	...loaderOnlyRuntime
} = runtimePin.provenance.runtime;
await assert.rejects(
	assertWorkflowExecutionEpochRuntimePin({
		db: immutableArtifactDb,
		runId: "run-1",
		pin: {
			...runtimePin,
			executionEpoch: 2,
			provenance: {
				...runtimePin.provenance,
				runtime: loaderOnlyRuntime,
			},
		} as typeof runtimePin,
	}),
	/WORKFLOW_RUNTIME_PIN_UNREADABLE: run run-1 has an invalid runtime pin at epochs\/2\/runtime-pin.json/,
);
const runtimeEvidence = immutableArtifactSqlite
	.prepare(
		`SELECT path, outcome, sha256, content_inline FROM skill_run_artifacts
		 WHERE run_id = 'run-1'
		   AND (path = 'epochs/0/runtime-pin.json'
		     OR path LIKE 'epochs/0/runtime-compatible/%'
		     OR path LIKE 'epochs/0/runtime-drift/%')
		 ORDER BY path`,
	)
	.all() as Array<{
	path: string;
	outcome: string;
	sha256: string;
	content_inline: string;
}>;
assert.deepEqual(
	runtimeEvidence.map(({ path, outcome }) => ({ path, outcome })),
	[
		{
			path: `epochs/0/runtime-compatible/${"b".repeat(64)}.json`,
			outcome: "success",
		},
		{
			path: `epochs/0/runtime-drift/${"d".repeat(64)}.json`,
			outcome: "failure",
		},
		{ path: "epochs/0/runtime-pin.json", outcome: "success" },
	],
);
for (const artifact of runtimeEvidence) {
	assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
}
const driftEvidence = JSON.parse(
	runtimeEvidence.find((artifact) => artifact.outcome === "failure")!
		.content_inline,
) as Record<string, unknown>;
assert.equal(Object.hasOwn(driftEvidence, "legacyPinnedRuntime"), false);
// A deliberate restart owns a new epoch and may adopt the new runtime.
await assertWorkflowExecutionEpochRuntimePin({
	db: immutableArtifactDb,
	runId: "run-1",
	pin: {
		...runtimePin,
		executionEpoch: 1,
		provenance: {
			...runtimePin.provenance,
			runtime: {
				...runtimePin.provenance.runtime,
				workerVersionId: "worker-v3",
				executionCompatibilityHash: "e".repeat(64),
				loaderConfigHash: "d".repeat(64),
			},
		},
	},
});

await recordWorkflowExecutionEpochStarted({
	db: immutableArtifactDb,
	runId: "run-1",
	executionEpoch: 1,
});
assert.equal(
	await hasWorkflowExecutionEpochStarted(immutableArtifactDb, "run-1", 1),
	true,
);
await recordWorkflowExecutionEpochOutcome({
	db: immutableArtifactDb,
	runId: "run-1",
	executionEpoch: 1,
	outcome: "completed",
	terminalFingerprint: "completed-fingerprint",
});
const epochEvidence = immutableArtifactSqlite
	.prepare(
		`SELECT path, content_inline, sha256 FROM skill_run_artifacts
		 WHERE run_id = 'run-1'
		   AND path IN ('epochs/1/started.json', 'epochs/1/completed.json')
		 ORDER BY path`,
	)
	.all() as Array<{ path: string; content_inline: string; sha256: string }>;
assert.equal(epochEvidence.length, 2);
for (const artifact of epochEvidence) {
	assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
	assert.equal(artifact.sha256, await sha256Hex(artifact.content_inline));
}
// Exact terminal retries are idempotent, but the first terminal outcome wins.
await recordWorkflowExecutionEpochOutcome({
	db: immutableArtifactDb,
	runId: "run-1",
	executionEpoch: 1,
	outcome: "completed",
	terminalFingerprint: "completed-fingerprint",
});
await assert.rejects(
	recordWorkflowExecutionEpochOutcome({
		db: immutableArtifactDb,
		runId: "run-1",
		executionEpoch: 1,
		outcome: "failed",
		terminalFingerprint: "failed-fingerprint",
	}),
	/WORKFLOW_EPOCH_OUTCOME_CONFLICT/,
);
assert.deepEqual(
	await getWorkflowExecutionEpochOutcome(immutableArtifactDb, "run-1", 1),
	{
		outcome: "completed",
		terminalFingerprint: "completed-fingerprint",
	},
);
// Started and terminal evidence are independent. A late static-factory replay
// repairs a missing start record even if the catch path already wrote a
// terminal fence.
await recordWorkflowExecutionEpochOutcome({
	db: immutableArtifactDb,
	runId: "run-1",
	executionEpoch: 2,
	outcome: "failed",
	terminalFingerprint: "factory-failure",
});
await recordWorkflowExecutionEpochStarted({
	db: immutableArtifactDb,
	runId: "run-1",
	executionEpoch: 2,
});
assert.equal(
	await hasWorkflowExecutionEpochStarted(immutableArtifactDb, "run-1", 2),
	true,
);

// The abort receipt and epoch-start evidence are a two-sided SQLite lock. If
// the operator abort commits first, the static factory cannot enter tenant
// code for that epoch.
const abortWinsRequest = {
	db: immutableArtifactDb,
	runId: "run-abort-wins",
	restartId: "restart-abort-wins",
};
const abortWinsClaim = await claimWorkflowRestart(abortWinsRequest);
const abortWinsPending = await bindWorkflowRestartExecutionEpoch({
	db: immutableArtifactDb,
	runId: abortWinsRequest.runId,
	path: abortWinsClaim.path,
	pendingContent: abortWinsClaim.pendingContent,
	executionEpoch: 8,
});
await finalizeWorkflowRestart({
	...abortWinsRequest,
	path: abortWinsClaim.path,
	pendingContent: abortWinsPending,
	result: { status: "unknown", executionEpoch: 8 },
});
await abortAmbiguousWorkflowRestart({
	...abortWinsRequest,
	executionEpoch: 8,
	reason: "verified epoch never started",
});
immutableArtifactSqlite
	.prepare(
		`UPDATE skill_runs
		    SET execution_epoch = 8,
		        restart_requested_at = '2026-07-12T00:00:00.000Z',
		        restart_command_id = ?
		  WHERE id = ?`,
	)
	.run(abortWinsRequest.restartId, abortWinsRequest.runId);
assert.equal(
	await finalizeAbortedSkillRunRestart(
		immutableArtifactDb,
		abortWinsRequest.runId,
		8,
		abortWinsRequest.restartId,
	),
	true,
);
await assert.rejects(
	recordWorkflowExecutionEpochStarted({
		db: immutableArtifactDb,
		runId: abortWinsRequest.runId,
		executionEpoch: 8,
	}),
	/WORKFLOW_INSTANCE_RETIRED/,
);
assert.equal(
	await hasWorkflowExecutionEpochStarted(
		immutableArtifactDb,
		abortWinsRequest.runId,
		8,
	),
	false,
);
await assert.rejects(
	claimWorkflowRestart({
		db: immutableArtifactDb,
		runId: abortWinsRequest.runId,
		restartId: "restart-after-operator-abort",
	}),
	(error: unknown) => {
		assert.ok(error instanceof WorkflowRestartConflictError);
		assert.match(error.message, /permanently retired/);
		return true;
	},
);
assert.equal(
	(
		immutableArtifactSqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM skill_run_artifacts
			 WHERE run_id = ? AND path LIKE 'controls/restarts/%'`,
			)
			.get(abortWinsRequest.runId) as { count: number }
	).count,
	1,
);
await assert.rejects(
	recordWorkflowExecutionEpochStarted({
		db: immutableArtifactDb,
		runId: abortWinsRequest.runId,
		executionEpoch: 9,
	}),
	/WORKFLOW_INSTANCE_RETIRED/,
);
assert.equal(
	await hasWorkflowExecutionEpochStarted(
		immutableArtifactDb,
		abortWinsRequest.runId,
		9,
	),
	false,
);
assert.ok(
	(
		immutableArtifactSqlite
			.prepare("SELECT workflow_retired_at FROM skill_runs WHERE id = ?")
			.get(abortWinsRequest.runId) as { workflow_retired_at: string | null }
	).workflow_retired_at,
);
immutableArtifactSqlite
	.prepare("DELETE FROM skill_run_artifacts WHERE run_id = ?")
	.run(abortWinsRequest.runId);
await assert.rejects(
	claimWorkflowRestart({
		db: immutableArtifactDb,
		runId: abortWinsRequest.runId,
		restartId: "restart-after-artifact-revocation",
	}),
	/permanently retired/,
);
await assert.rejects(
	recordWorkflowExecutionEpochStarted({
		db: immutableArtifactDb,
		runId: abortWinsRequest.runId,
		executionEpoch: 10,
	}),
	/WORKFLOW_INSTANCE_RETIRED/,
);
await assert.rejects(
	recordWorkflowExecutionEpochOutcome({
		db: immutableArtifactDb,
		runId: abortWinsRequest.runId,
		executionEpoch: 10,
		outcome: "failed",
		terminalFingerprint: "must-not-regrow-after-revoke",
	}),
	/WORKFLOW_INSTANCE_RETIRED/,
);
for (const decision of ["approved", "rejected"] as const) {
	await assert.rejects(
		claimWorkflowApprovalDecision({
			db: immutableArtifactDb,
			runId: abortWinsRequest.runId,
			executionEpoch: 8,
			approvalId: `approval-after-revoke-${decision}`,
			decision,
			payload: {},
		}),
		/permanently retired/,
	);
}
assert.equal(
	(
		immutableArtifactSqlite
			.prepare(
				"SELECT COUNT(*) AS count FROM skill_run_artifacts WHERE run_id = ?",
			)
			.get(abortWinsRequest.runId) as { count: number }
	).count,
	0,
);
await assert.rejects(
	claimWorkflowRestart({
		db: immutableArtifactDb,
		runId: "run-open-restart",
		restartId: "restart-must-not-pass-open-intent",
	}),
	(error: unknown) => {
		assert.ok(error instanceof WorkflowRestartConflictError);
		assert.match(error.message, /another restart intent is open/);
		return true;
	},
);
assert.equal(
	(
		immutableArtifactSqlite
			.prepare(
				"SELECT COUNT(*) AS count FROM skill_run_artifacts WHERE run_id = 'run-open-restart'",
			)
			.get() as { count: number }
	).count,
	0,
);

// Identical concurrent operator aborts collapse to one CAS winner and one
// deduplicated re-read, with a single durable resolution.
const concurrentAbortRequest = {
	db: immutableArtifactDb,
	runId: "run-concurrent-abort",
	restartId: "restart-concurrent-abort",
};
const concurrentAbortClaim = await claimWorkflowRestart(concurrentAbortRequest);
const concurrentAbortPending = await bindWorkflowRestartExecutionEpoch({
	db: immutableArtifactDb,
	runId: concurrentAbortRequest.runId,
	path: concurrentAbortClaim.path,
	pendingContent: concurrentAbortClaim.pendingContent,
	executionEpoch: 10,
});
await finalizeWorkflowRestart({
	...concurrentAbortRequest,
	path: concurrentAbortClaim.path,
	pendingContent: concurrentAbortPending,
	result: { status: "unknown", executionEpoch: 10 },
});
const concurrentAborts = await Promise.all([
	abortAmbiguousWorkflowRestart({
		...concurrentAbortRequest,
		executionEpoch: 10,
		reason: "same operator resolution",
	}),
	abortAmbiguousWorkflowRestart({
		...concurrentAbortRequest,
		executionEpoch: 10,
		reason: "same operator resolution",
	}),
]);
assert.deepEqual(concurrentAborts.map((result) => result.deduplicated).sort(), [
	false,
	true,
]);

// In the opposite interleaving, the start INSERT executes while abort is
// between its receipt read and CAS update. The start wins and the abort cannot
// overwrite it, proving both states cannot commit for the same epoch.
const startWinsRequest = {
	db: immutableArtifactDb,
	runId: "run-start-wins",
	restartId: "restart-start-wins",
};
const startWinsClaim = await claimWorkflowRestart(startWinsRequest);
const startWinsPending = await bindWorkflowRestartExecutionEpoch({
	db: immutableArtifactDb,
	runId: startWinsRequest.runId,
	path: startWinsClaim.path,
	pendingContent: startWinsClaim.pendingContent,
	executionEpoch: 9,
});
await finalizeWorkflowRestart({
	...startWinsRequest,
	path: startWinsClaim.path,
	pendingContent: startWinsPending,
	result: { status: "unknown", executionEpoch: 9 },
});
const [abortRace, startRace] = await Promise.allSettled([
	abortAmbiguousWorkflowRestart({
		...startWinsRequest,
		executionEpoch: 9,
		reason: "raced the static factory",
	}),
	recordWorkflowExecutionEpochStarted({
		db: immutableArtifactDb,
		runId: startWinsRequest.runId,
		executionEpoch: 9,
	}),
]);
assert.equal(startRace.status, "fulfilled");
assert.equal(abortRace.status, "rejected");
if (abortRace.status === "rejected") {
	assert.ok(abortRace.reason instanceof WorkflowRestartConflictError);
}
assert.equal(
	await hasWorkflowExecutionEpochStarted(
		immutableArtifactDb,
		startWinsRequest.runId,
		9,
	),
	true,
);
const startWinsReceipt = immutableArtifactSqlite
	.prepare(
		"SELECT content_inline, outcome FROM skill_run_artifacts WHERE run_id = ? AND path = ?",
	)
	.get(startWinsRequest.runId, startWinsClaim.path) as {
	content_inline: string;
	outcome: string;
};
assert.equal(JSON.parse(startWinsReceipt.content_inline).status, "unknown");
assert.equal(startWinsReceipt.outcome, "pending");

// Malformed legacy control content must not make JSON inspection abort the
// start INSERT for an unrelated, valid epoch.
immutableArtifactSqlite
	.prepare(
		`INSERT INTO skill_run_artifacts
		 (id, run_id, path, content_inline, outcome)
		 VALUES (?, ?, ?, ?, 'pending')`,
	)
	.run(
		"malformed-control",
		"run-malformed-control",
		"controls/restarts/malformed.json",
		"not-json",
	);
await recordWorkflowExecutionEpochStarted({
	db: immutableArtifactDb,
	runId: "run-malformed-control",
	executionEpoch: 11,
});
assert.equal(
	await hasWorkflowExecutionEpochStarted(
		immutableArtifactDb,
		"run-malformed-control",
		11,
	),
	true,
);

const reconcileScanSqlite = new Database(":memory:");
reconcileScanSqlite.exec(`
	CREATE TABLE skill_runs (
		id TEXT PRIMARY KEY NOT NULL,
		workflow_instance_id TEXT NOT NULL,
		organization_id TEXT NOT NULL,
		skill_id TEXT NOT NULL,
		tedi_id TEXT NOT NULL,
		params TEXT,
		status TEXT NOT NULL,
		error TEXT,
		execution_epoch INTEGER NOT NULL DEFAULT 0,
		restart_requested_at TEXT,
		restart_command_id TEXT,
		workflow_retired_at TEXT,
		runtime_environment TEXT NOT NULL,
		last_reconciled_at TEXT,
		started_at TEXT NOT NULL
	);
	INSERT INTO skill_runs
		(id, workflow_instance_id, organization_id, skill_id, tedi_id, params,
		 status, error, execution_epoch, restart_requested_at, restart_command_id,
		 runtime_environment, last_reconciled_at, started_at)
	VALUES
		('prod-old', 'wf-prod-old', 'org-1', 'skill-1', 'tedi-1', '{}', 'running', NULL, 0, NULL, NULL, 'production', NULL, '2026-07-11T00:00:00.000Z'),
		('stage-run', 'wf-stage', 'org-1', 'skill-1', 'tedi-1', '{}', 'running', NULL, 0, NULL, NULL, 'staging', NULL, '2026-07-11T00:00:30.000Z'),
		('prod-run', 'wf-prod', 'org-1', 'skill-1', 'tedi-1', '{}', 'queued', NULL, 0, NULL, NULL, 'production', NULL, '2026-07-11T00:01:00.000Z'),
		('prod-marker-collision', 'wf-marker-collision', 'org-1', 'skill-1', 'tedi-1', '{}', 'running', 'REVOKED_TOKEN_REFRESH_FAILED', 0, NULL, NULL, 'production', NULL, '2026-07-11T00:01:30.000Z'),
		('prod-admission', 'wf-admission', 'org-1', 'skill-1', 'tedi-1', '{}', 'failed', 'WORKFLOW_ADMISSION_CREATE_FAILED: timeout', 0, NULL, NULL, 'production', NULL, '2026-07-11T00:02:00.000Z'),
		('prod-done', 'wf-done', 'org-1', 'skill-1', 'tedi-1', '{}', 'completed', NULL, 0, NULL, NULL, 'production', NULL, '2026-07-11T00:03:00.000Z');
`);
const reconcileScanDb = sqliteD1(reconcileScanSqlite);
const productionScan = await listNonTerminalRuns(
	reconcileScanDb,
	"production",
	10,
);
assert.deepEqual(
	productionScan.map((row) => row.runId),
	["prod-old", "prod-run", "prod-marker-collision", "prod-admission"],
);
assert.equal(productionScan.at(-1)?.admissionRecovery, true);
assert.deepEqual(
	(await listNonTerminalRuns(reconcileScanDb, "staging", 10)).map(
		(row) => row.runId,
	),
	["stage-run"],
);
await touchSkillRunReconciled(reconcileScanDb, "prod-old");
assert.equal(
	(await listNonTerminalRuns(reconcileScanDb, "production", 1))[0]?.runId,
	"prod-run",
);

const lifecycleSqlite = new Database(":memory:");
lifecycleSqlite.exec(`
	CREATE TABLE skill_runs (
		id TEXT PRIMARY KEY NOT NULL,
		execution_epoch INTEGER NOT NULL DEFAULT 0,
		restart_requested_at TEXT,
		restart_command_id TEXT,
		workflow_retired_at TEXT,
		status TEXT NOT NULL,
		result TEXT,
		error TEXT,
		cost_summary TEXT,
		started_at TEXT,
			completed_at TEXT,
			paused_at TEXT
		);
		CREATE TABLE skill_run_artifacts (
			id TEXT PRIMARY KEY NOT NULL,
			run_id TEXT NOT NULL,
			path TEXT NOT NULL,
			mime_type TEXT NOT NULL DEFAULT 'application/json',
			size_bytes INTEGER NOT NULL DEFAULT 0,
			content_inline TEXT,
			content_r2_key TEXT,
			sha256 TEXT,
			attempt INTEGER NOT NULL DEFAULT 1,
			outcome TEXT NOT NULL DEFAULT 'success',
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE tedi_rationale_records (
			id TEXT PRIMARY KEY NOT NULL,
			run_id TEXT,
			evidence TEXT NOT NULL,
			outcome TEXT,
			outcome_status TEXT NOT NULL DEFAULT 'pending',
			tool_call_refs TEXT,
			proof_ref TEXT,
			completed_at TEXT
		);
		INSERT INTO skill_runs (id, status, result, started_at, completed_at)
	VALUES ('run-cas', 'completed', '{"old":true}', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:01.000Z');
	INSERT INTO skill_runs (id, status, started_at)
	VALUES ('run-stale-active', 'running', '2026-07-10T00:00:00.000Z');
	INSERT INTO skill_runs (id, status, error, started_at)
	VALUES ('run-revoked-token-collision', 'failed', 'REVOKED_TOKEN_REFRESH_FAILED', '2026-07-10T00:00:00.000Z');
	INSERT INTO skill_runs (
		id, status, result, cost_summary, started_at, completed_at
	) VALUES (
		'run-abort-terminal', 'completed', '{"old":true}', '{"schemaVersion":1}',
		'2026-07-09T00:00:00.000Z', '2026-07-09T00:00:01.000Z'
	);
	INSERT INTO skill_runs (id, status, started_at)
	VALUES ('run-rationale-failure', 'running', '2026-07-11T00:00:02.000Z');
	INSERT INTO tedi_rationale_records
		(id, run_id, evidence, outcome, outcome_status, proof_ref, completed_at)
	VALUES (
		'dispatch-rationale', 'run-rationale-failure',
		'{"kind":"skill_workflow_dispatch"}',
		'Workflow run created.', 'success',
		'{"kind":"run","ref":"run-rationale-failure"}',
		'2026-07-11T00:00:02.000Z'
	);
	INSERT INTO tedi_rationale_records
		(id, run_id, evidence, outcome_status)
	VALUES (
		'workflow-receipt-rationale', 'run-rationale-failure',
		'{"kind":"workflow_receipt"}', 'pending'
	);
	INSERT INTO skill_run_artifacts
		(id, run_id, path, content_inline, attempt, outcome)
	VALUES
		('call-attempt-1', 'run-rationale-failure',
		 'epochs/0/steps/read/1/attempts/1/calls/main/1.json',
		 '{"kind":"workflow_mcp_call","status":"succeeded","namespace":"home","method":"read_home_run_set","idempotencyKey":"logical-read"}',
		 1, 'success'),
		('call-attempt-2', 'run-rationale-failure',
		 'epochs/0/steps/read/1/attempts/2/calls/main/1.json',
		 '{"kind":"workflow_mcp_call","status":"succeeded","namespace":"home","method":"read_home_run_set","idempotencyKey":"logical-read"}',
		 2, 'success');
`);
const lifecycleDb = sqliteD1(lifecycleSqlite);
assert.equal(
	await reconcileSkillRun(lifecycleDb, "run-rationale-failure", {
		status: "failed",
		error: "NonRetryableError: fixture failed",
	}),
	true,
);
const reconciledDispatchRationale = lifecycleSqlite
	.prepare(
		"SELECT outcome_status AS outcomeStatus, outcome, tool_call_refs AS toolCallRefs, proof_ref AS proofRef FROM tedi_rationale_records WHERE id = 'dispatch-rationale'",
	)
	.get() as {
	outcomeStatus: string;
	outcome: string;
	toolCallRefs: string;
	proofRef: string | null;
};
assert.equal(reconciledDispatchRationale.outcomeStatus, "failure");
assert.match(reconciledDispatchRationale.outcome, /NonRetryableError/);
assert.deepEqual(JSON.parse(reconciledDispatchRationale.toolCallRefs), [
	"run-rationale-failure:step:0:0:home.read_home_run_set",
]);
assert.equal(reconciledDispatchRationale.proofRef, null);
const reconciledWorkflowReceipt = lifecycleSqlite
	.prepare(
		"SELECT outcome_status AS outcomeStatus, outcome, tool_call_refs AS toolCallRefs, proof_ref AS proofRef FROM tedi_rationale_records WHERE id = 'workflow-receipt-rationale'",
	)
	.get() as {
	outcomeStatus: string;
	outcome: string;
	toolCallRefs: string;
	proofRef: string | null;
};
assert.equal(reconciledWorkflowReceipt.outcomeStatus, "failure");
assert.match(reconciledWorkflowReceipt.outcome, /NonRetryableError/);
assert.deepEqual(JSON.parse(reconciledWorkflowReceipt.toolCallRefs), [
	"run-rationale-failure:step:0:0:home.read_home_run_set",
]);
assert.equal(reconciledWorkflowReceipt.proofRef, null);
lifecycleSqlite.exec(`
	INSERT INTO skill_runs (id, status, error, started_at)
	VALUES ('run-admission-recovery', 'failed', 'WORKFLOW_ADMISSION_CREATE_FAILED: timeout', '2026-07-11T00:00:02.000Z');
	INSERT INTO tedi_rationale_records
		(id, run_id, evidence, outcome_status)
	VALUES (
		'completed-workflow-receipt-rationale', 'run-admission-recovery',
		'{"kind":"workflow_receipt"}', 'pending'
	);
`);
assert.equal(
	await updateSkillRunAfterControl(
		lifecycleDb,
		"run-admission-recovery",
		"running",
		{ restart: true, requireAdmissionMarker: true },
	),
	true,
);
assert.equal(
	(
		lifecycleSqlite
			.prepare(
				"SELECT started_at FROM skill_runs WHERE id = 'run-admission-recovery'",
			)
			.get() as { started_at: string }
	).started_at,
	"2026-07-11T00:00:02.000Z",
);
assert.equal(
	await reconcileSkillRun(lifecycleDb, "run-admission-recovery", {
		status: "completed",
		result: { ok: true },
		error: null,
	}),
	true,
);
const recoveredAdmission = lifecycleSqlite
	.prepare(
		"SELECT status, result, error, completed_at FROM skill_runs WHERE id = 'run-admission-recovery'",
	)
	.get() as {
	status: string;
	result: string;
	error: string | null;
	completed_at: string | null;
};
assert.equal(recoveredAdmission.status, "completed");
assert.equal(recoveredAdmission.result, '{"ok":true}');
assert.equal(recoveredAdmission.error, null);
assert.ok(recoveredAdmission.completed_at);
const completedWorkflowReceipt = lifecycleSqlite
	.prepare(
		"SELECT outcome_status AS outcomeStatus, proof_ref AS proofRef FROM tedi_rationale_records WHERE id = 'completed-workflow-receipt-rationale'",
	)
	.get() as { outcomeStatus: string; proofRef: string };
assert.equal(completedWorkflowReceipt.outcomeStatus, "partial");
assert.deepEqual(JSON.parse(completedWorkflowReceipt.proofRef), {
	kind: "run",
	ref: "run-admission-recovery",
});
// A late concurrent admission recovery may not reset terminal truth after
// another observer already completed the recovered execution.
assert.equal(
	await updateSkillRunAfterControl(
		lifecycleDb,
		"run-admission-recovery",
		"running",
		{ restart: true, requireAdmissionMarker: true },
	),
	false,
);
assert.equal(
	await reserveSkillRunExecutionEpoch(lifecycleDb, "run-cas", 0, "restart-1"),
	1,
);
assert.equal(
	await reserveSkillRunExecutionEpoch(
		lifecycleDb,
		"run-revoked-token-collision",
		0,
		"restart-token-refresh",
	),
	1,
);
assert.equal(
	await reserveSkillRunExecutionEpoch(lifecycleDb, "run-cas", 0, "restart-2"),
	null,
);
assert.equal(
	(
		lifecycleSqlite
			.prepare("SELECT restart_command_id FROM skill_runs WHERE id = 'run-cas'")
			.get() as { restart_command_id: string }
	).restart_command_id,
	"restart-1",
);
assert.equal(
	await updateSkillRunAfterControl(lifecycleDb, "run-cas", "queued", {
		restart: true,
		expectedExecutionEpoch: 1,
		requireRestartIntent: true,
	}),
	true,
);
const firstRestartStartedAt = (
	lifecycleSqlite
		.prepare("SELECT started_at FROM skill_runs WHERE id = 'run-cas'")
		.get() as { started_at: string }
).started_at;
assert.notEqual(firstRestartStartedAt, "2026-07-11T00:00:00.000Z");
assert.equal(
	await updateSkillRunAfterControl(lifecycleDb, "run-cas", "queued", {
		restart: true,
		expectedExecutionEpoch: 1,
		requireRestartIntent: true,
	}),
	true,
);
assert.equal(
	(
		lifecycleSqlite
			.prepare("SELECT started_at FROM skill_runs WHERE id = 'run-cas'")
			.get() as { started_at: string }
	).started_at,
	firstRestartStartedAt,
);
assert.equal(await clearSkillRunRestartIntent(lifecycleDb, "run-cas", 1), true);

assert.equal(
	await reserveSkillRunExecutionEpoch(
		lifecycleDb,
		"run-stale-active",
		0,
		"restart-stale-active",
	),
	1,
);
const staleActiveIntentAt = (
	lifecycleSqlite
		.prepare(
			"SELECT restart_requested_at FROM skill_runs WHERE id = 'run-stale-active'",
		)
		.get() as { restart_requested_at: string }
).restart_requested_at;
for (let attempt = 0; attempt < 2; attempt += 1) {
	assert.equal(
		await updateSkillRunAfterControl(
			lifecycleDb,
			"run-stale-active",
			"queued",
			{
				restart: true,
				expectedExecutionEpoch: 1,
				requireRestartIntent: true,
			},
		),
		true,
	);
	assert.equal(
		(
			lifecycleSqlite
				.prepare(
					"SELECT started_at FROM skill_runs WHERE id = 'run-stale-active'",
				)
				.get() as { started_at: string }
		).started_at,
		staleActiveIntentAt,
	);
}
assert.equal(
	await finalizeAbortedSkillRunRestart(
		lifecycleDb,
		"run-stale-active",
		1,
		"restart-stale-active",
	),
	true,
);
const staleActiveAborted = lifecycleSqlite
	.prepare(
		`SELECT status, result, error, cost_summary, started_at, completed_at,
		        paused_at, restart_requested_at, restart_command_id
		   FROM skill_runs WHERE id = 'run-stale-active'`,
	)
	.get() as {
	status: string;
	result: string | null;
	error: string | null;
	cost_summary: string | null;
	started_at: string;
	completed_at: string | null;
	paused_at: string | null;
	restart_requested_at: string | null;
	restart_command_id: string | null;
};
assert.equal(staleActiveAborted.status, "canceled");
assert.equal(staleActiveAborted.result, null);
assert.equal(staleActiveAborted.error, null);
assert.equal(staleActiveAborted.cost_summary, null);
assert.equal(staleActiveAborted.started_at, staleActiveIntentAt);
assert.ok(staleActiveAborted.completed_at);
assert.equal(staleActiveAborted.paused_at, null);
assert.equal(staleActiveAborted.restart_requested_at, null);
assert.equal(staleActiveAborted.restart_command_id, null);
assert.equal(
	await finalizeAbortedSkillRunRestart(
		lifecycleDb,
		"run-stale-active",
		1,
		"restart-stale-active",
	),
	false,
);

assert.equal(
	await reserveSkillRunExecutionEpoch(
		lifecycleDb,
		"run-abort-terminal",
		0,
		"restart-abort-terminal",
	),
	1,
);
const terminalAbortIntentAt = (
	lifecycleSqlite
		.prepare(
			"SELECT restart_requested_at FROM skill_runs WHERE id = 'run-abort-terminal'",
		)
		.get() as { restart_requested_at: string }
).restart_requested_at;
assert.equal(
	await finalizeAbortedSkillRunRestart(
		lifecycleDb,
		"run-abort-terminal",
		1,
		"restart-abort-terminal",
	),
	true,
);
const terminalAborted = lifecycleSqlite
	.prepare(
		`SELECT status, result, cost_summary, started_at, completed_at,
		        restart_requested_at, restart_command_id
		   FROM skill_runs WHERE id = 'run-abort-terminal'`,
	)
	.get() as {
	status: string;
	result: string | null;
	cost_summary: string | null;
	started_at: string;
	completed_at: string | null;
	restart_requested_at: string | null;
	restart_command_id: string | null;
};
assert.equal(terminalAborted.status, "canceled");
assert.equal(terminalAborted.result, null);
assert.equal(terminalAborted.cost_summary, null);
assert.equal(terminalAborted.started_at, terminalAbortIntentAt);
assert.ok(terminalAborted.completed_at);
assert.equal(terminalAborted.restart_requested_at, null);
assert.equal(terminalAborted.restart_command_id, null);
assert.equal(
	await reconcileSkillRun(lifecycleDb, "run-cas", {
		status: "completed",
		result: { epoch: 1 },
		expectedExecutionEpoch: 1,
	}),
	true,
);
// A stale same-epoch read/control may never regress terminal truth.
assert.equal(
	await reconcileSkillRun(lifecycleDb, "run-cas", {
		status: "running",
		expectedExecutionEpoch: 1,
	}),
	false,
);
assert.equal(
	await updateSkillRunAfterControl(lifecycleDb, "run-cas", "queued", {
		expectedExecutionEpoch: 1,
	}),
	false,
);
// The restart handler's late provisional reset must not erase a completion
// after the reconciler has released the intent fence.
assert.equal(
	await updateSkillRunAfterControl(lifecycleDb, "run-cas", "queued", {
		restart: true,
		expectedExecutionEpoch: 1,
		requireRestartIntent: true,
	}),
	false,
);
assert.equal(
	await reserveSkillRunExecutionEpoch(lifecycleDb, "run-cas", 1, "restart-2"),
	2,
);
assert.equal(
	await reconcileSkillRun(lifecycleDb, "run-cas", {
		status: "failed",
		error: "stale epoch one poll",
		expectedExecutionEpoch: 1,
	}),
	false,
);
const lifecycleRow = lifecycleSqlite
	.prepare(
		"SELECT execution_epoch, status, result, error, restart_command_id FROM skill_runs WHERE id = 'run-cas'",
	)
	.get() as {
	execution_epoch: number;
	status: string;
	result: string;
	error: string | null;
	restart_command_id: string;
};
assert.equal(lifecycleRow.execution_epoch, 2);
assert.equal(lifecycleRow.status, "completed");
assert.deepEqual(JSON.parse(lifecycleRow.result), { epoch: 1 });
assert.equal(lifecycleRow.error, null);
assert.equal(lifecycleRow.restart_command_id, "restart-2");

assert.equal(WORKFLOW_APPROVAL_EVENT_TYPE, "approval");
assert.deepEqual(
	buildWorkflowApprovalEvent({
		approved: false,
		reason: "needs sources",
		approvalId: "approval-1",
		metadata: { reviewer: "operator" },
	}),
	{
		type: "approval",
		payload: {
			approved: false,
			reason: "needs sources",
			metadata: { reviewer: "operator", approvalId: "approval-1" },
		},
	},
);

const approvalStore = createRestartReceiptDb();
const approvalClaim = await claimWorkflowApprovalDecision({
	db: approvalStore.db,
	runId: "00000000-0000-4000-8000-000000000001",
	executionEpoch: 0,
	approvalId: "publish/approval 1",
	decision: "approved",
	reason: "sources verified",
	payload: { reviewer: "operator", score: 1 },
});
assert.equal(approvalClaim.deduplicated, false);
assert.equal(
	approvalClaim.path,
	"epochs/0/controls/approvals/x:publish%2Fapproval%201.json",
);
await assert.rejects(
	claimWorkflowApprovalDecision({
		db: approvalStore.db,
		runId: "00000000-0000-4000-8000-000000000001",
		executionEpoch: 0,
		approvalId: "publish/approval 1",
		decision: "approved",
		reason: "sources verified",
		payload: { reviewer: "operator", score: 2 },
	}),
	(error: unknown) => {
		assert.ok(error instanceof WorkflowApprovalDecisionConflictError);
		assert.match(error.message, /different decision, reason, or payload/);
		return true;
	},
);
await assert.rejects(
	claimWorkflowApprovalDecision({
		db: approvalStore.db,
		runId: "00000000-0000-4000-8000-000000000001",
		executionEpoch: 0,
		approvalId: "publish/approval 1",
		decision: "approved",
		reason: "different operator rationale",
		payload: { reviewer: "operator", score: 1 },
	}),
	(error: unknown) => {
		assert.ok(error instanceof WorkflowApprovalDecisionConflictError);
		assert.match(error.message, /different decision, reason, or payload/);
		return true;
	},
);
assert.ok(approvalClaim.pendingContent);
await finalizeWorkflowApprovalDecision({
	db: approvalStore.db,
	runId: "00000000-0000-4000-8000-000000000001",
	path: approvalClaim.path,
	executionEpoch: 0,
	approvalId: "publish/approval 1",
	decision: "approved",
	requestDigest: approvalClaim.requestDigest,
	pendingContent: approvalClaim.pendingContent!,
	delivered: true,
});
const duplicateApproval = await claimWorkflowApprovalDecision({
	db: approvalStore.db,
	runId: "00000000-0000-4000-8000-000000000001",
	executionEpoch: 0,
	approvalId: "publish/approval 1",
	decision: "approved",
	reason: "sources verified",
	payload: { score: 1, reviewer: "operator" },
});
assert.equal(duplicateApproval.deduplicated, true);
const nextEpochApproval = await claimWorkflowApprovalDecision({
	db: approvalStore.db,
	runId: "00000000-0000-4000-8000-000000000001",
	executionEpoch: 1,
	approvalId: "publish/approval 1",
	decision: "approved",
	reason: "sources verified",
	payload: { reviewer: "operator", score: 1 },
});
assert.equal(nextEpochApproval.deduplicated, false);

const restartStore = createRestartReceiptDb();
const restartRequest = {
	db: restartStore.db,
	runId: "00000000-0000-4000-8000-000000000001",
	restartId: "operator/restart 1",
	from: { name: "publish", count: 2, type: "do" as const },
};
const restartClaim = await claimWorkflowRestart(restartRequest);
assert.equal(restartClaim.deduplicated, false);
assert.equal(
	restartClaim.path,
	"controls/restarts/x:operator%2Frestart%201.json",
);
await assert.rejects(claimWorkflowRestart(restartRequest), (error: unknown) => {
	assert.ok(error instanceof WorkflowRestartConflictError);
	assert.equal(error.receiptStatus, "pending");
	return true;
});
await assert.rejects(
	claimWorkflowRestart({
		...restartRequest,
		from: { ...restartRequest.from, count: 3 },
	}),
	(error: unknown) => {
		assert.ok(error instanceof WorkflowRestartConflictError);
		assert.match(error.message, /different from request/);
		return true;
	},
);
const boundRestartContent = await bindWorkflowRestartExecutionEpoch({
	db: restartStore.db,
	runId: restartRequest.runId,
	path: restartClaim.path,
	pendingContent: restartClaim.pendingContent,
	executionEpoch: 4,
});
await finalizeWorkflowRestart({
	...restartRequest,
	path: restartClaim.path,
	pendingContent: boundRestartContent,
	result: { status: "accepted", executionEpoch: 4 },
});
const acceptedRestart = await claimWorkflowRestart(restartRequest);
assert.equal(acceptedRestart.deduplicated, true);
assert.equal(acceptedRestart.receipt.status, "accepted");
assert.equal(acceptedRestart.receipt.executionEpoch, 4);
assert.equal(
	restartStore.rows.get(`${restartRequest.runId}:${restartClaim.path}`)
		?.outcome,
	"success",
);
await assert.rejects(
	finalizeWorkflowRestart({
		...restartRequest,
		path: restartClaim.path,
		pendingContent: boundRestartContent,
		result: { status: "rejected" },
	}),
	(error: unknown) => {
		assert.ok(error instanceof WorkflowRestartConflictError);
		return true;
	},
);

const acceptedReceipt = acceptedRestart.receipt;
assert.equal(
	await fingerprintWorkflowOutput({ answer: 42 }),
	await fingerprintWorkflowOutput({ answer: 42 }),
);
assert.notEqual(
	await fingerprintWorkflowOutput({ answer: 42 }),
	await fingerprintWorkflowOutput({ answer: 43 }),
);
assert.notEqual(
	await fingerprintWorkflowOutput("same"),
	await fingerprintWorkflowError("same"),
);
assert.equal(
	workflowRestartBarrierState({
		restartRequestedAt: null,
		acceptedRestart: null,
		engineStatus: "completed",
		executionEpochOutcome: null,
		engineTerminalFingerprint: null,
	}),
	"none",
);
assert.equal(
	workflowRestartBarrierState({
		restartRequestedAt: "2026-07-11T10:00:00.000Z",
		acceptedRestart: acceptedReceipt,
		engineStatus: "completed",
		executionEpochOutcome: null,
		engineTerminalFingerprint: "new-output",
	}),
	"blocked",
);
assert.equal(
	workflowRestartBarrierState({
		restartRequestedAt: "2026-07-11T10:00:00.000Z",
		acceptedRestart: acceptedReceipt,
		engineStatus: "failed",
		executionEpochOutcome: {
			outcome: "failed",
			terminalFingerprint: "new-error",
		},
		engineTerminalFingerprint: "new-error",
	}),
	"released",
);
assert.equal(
	workflowRestartBarrierState({
		restartRequestedAt: "2026-07-11T10:00:00.000Z",
		acceptedRestart: acceptedReceipt,
		engineStatus: "completed",
		executionEpochOutcome: {
			outcome: "completed",
			terminalFingerprint: "new-output",
		},
		engineTerminalFingerprint: "old-output",
	}),
	"blocked",
);
assert.equal(
	workflowRestartBarrierState({
		restartRequestedAt: "2026-07-11T10:00:00.000Z",
		acceptedRestart: acceptedReceipt,
		engineStatus: "completed",
		executionEpochOutcome: {
			outcome: "completed",
			terminalFingerprint: "new-output",
		},
		engineTerminalFingerprint: "new-output",
	}),
	"released",
);
assert.equal(
	workflowRestartBarrierState({
		restartRequestedAt: "2026-07-11T10:00:00.000Z",
		acceptedRestart: acceptedReceipt,
		engineStatus: "running",
		executionEpochOutcome: null,
		engineTerminalFingerprint: null,
	}),
	"released",
);
assert.equal(
	workflowRestartBarrierState({
		restartRequestedAt: "2026-07-11T10:00:00.000Z",
		acceptedRestart: acceptedReceipt,
		engineStatus: "paused",
		executionEpochOutcome: null,
		engineTerminalFingerprint: null,
	}),
	"released",
);
assert.equal(
	workflowRestartBarrierState({
		restartRequestedAt: "2026-07-11T10:00:00.000Z",
		acceptedRestart: acceptedReceipt,
		engineStatus: "canceled",
		executionEpochOutcome: null,
		engineTerminalFingerprint: null,
	}),
	"released",
);
assert.equal(
	workflowRestartBarrierState({
		restartRequestedAt: "2026-07-11T10:00:00.000Z",
		acceptedRestart: null,
		engineStatus: "canceled",
		executionEpochOutcome: null,
		engineTerminalFingerprint: null,
	}),
	"blocked",
);

const unknownStore = createRestartReceiptDb();
const unknownRequest = {
	db: unknownStore.db,
	runId: restartRequest.runId,
	restartId: "restart-unknown",
};
const unknownClaim = await claimWorkflowRestart(unknownRequest);
const boundUnknownContent = await bindWorkflowRestartExecutionEpoch({
	db: unknownStore.db,
	runId: unknownRequest.runId,
	path: unknownClaim.path,
	pendingContent: unknownClaim.pendingContent,
	executionEpoch: 5,
});
await finalizeWorkflowRestart({
	...unknownRequest,
	path: unknownClaim.path,
	pendingContent: boundUnknownContent,
	result: { status: "unknown", executionEpoch: 5 },
});
await assert.rejects(claimWorkflowRestart(unknownRequest), (error: unknown) => {
	assert.ok(error instanceof WorkflowRestartConflictError);
	assert.equal(error.receiptStatus, "unknown");
	return true;
});
const recoveredUnknown = await resolveAcceptedWorkflowRestart({
	db: unknownStore.db,
	runId: unknownRequest.runId,
	executionEpoch: 5,
	restartCommandId: unknownRequest.restartId,
	executionEpochStarted: true,
});
assert.equal(recoveredUnknown?.status, "accepted");
assert.equal(recoveredUnknown?.executionEpoch, 5);

const abortStore = createRestartReceiptDb();
const abortRequest = {
	db: abortStore.db,
	runId: restartRequest.runId,
	restartId: "restart-operator-abort",
	from: { name: "publish", count: 2, type: "do" as const },
};
const abortClaim = await claimWorkflowRestart(abortRequest);
const boundAbortContent = await bindWorkflowRestartExecutionEpoch({
	db: abortStore.db,
	runId: abortRequest.runId,
	path: abortClaim.path,
	pendingContent: abortClaim.pendingContent,
	executionEpoch: 6,
});
await finalizeWorkflowRestart({
	...abortRequest,
	path: abortClaim.path,
	pendingContent: boundAbortContent,
	result: { status: "unknown", executionEpoch: 6 },
});
await assert.rejects(
	abortAmbiguousWorkflowRestart({
		...abortRequest,
		executionEpoch: 6,
		from: { ...abortRequest.from, count: 3 },
		reason: "verified no new epoch start evidence",
	}),
	(error: unknown) => {
		assert.ok(error instanceof WorkflowRestartConflictError);
		assert.match(error.message, /does not match/);
		return true;
	},
);
assert.deepEqual(
	await abortAmbiguousWorkflowRestart({
		...abortRequest,
		executionEpoch: 6,
		reason: "verified no new epoch start evidence",
	}),
	{ deduplicated: false },
);
const abortedRow = abortStore.rows.get(
	`${abortRequest.runId}:${abortClaim.path}`,
);
assert.equal(abortedRow?.outcome, "failure");
const abortedResolution = JSON.parse(
	abortedRow?.contentInline ?? "null",
).resolution;
assert.equal(abortedResolution.action, "operator_abort");
assert.equal(abortedResolution.reason, "verified no new epoch start evidence");
assert.match(abortedResolution.resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
assert.deepEqual(
	await abortAmbiguousWorkflowRestart({
		...abortRequest,
		executionEpoch: 6,
		reason: "verified no new epoch start evidence",
		dedupeOnly: true,
	}),
	{ deduplicated: true },
);
await assert.rejects(
	abortAmbiguousWorkflowRestart({
		...abortRequest,
		executionEpoch: 6,
		reason: "a different audit reason",
		dedupeOnly: true,
	}),
	(error: unknown) => {
		assert.ok(error instanceof WorkflowRestartConflictError);
		assert.match(error.message, /different reason/);
		return true;
	},
);
await assert.rejects(claimWorkflowRestart(abortRequest), (error: unknown) => {
	assert.ok(error instanceof WorkflowRestartConflictError);
	assert.match(error.message, /permanently retired/);
	return true;
});
assert.equal(abortStore.rows.size, 1);

const inactivePendingStore = createRestartReceiptDb();
const inactivePendingRequest = {
	db: inactivePendingStore.db,
	runId: restartRequest.runId,
	restartId: "restart-inactive-pending",
};
const inactivePendingClaim = await claimWorkflowRestart(inactivePendingRequest);
const inactivePendingContent = await bindWorkflowRestartExecutionEpoch({
	db: inactivePendingStore.db,
	runId: inactivePendingRequest.runId,
	path: inactivePendingClaim.path,
	pendingContent: inactivePendingClaim.pendingContent,
	executionEpoch: 7,
});
await assert.rejects(
	abortAmbiguousWorkflowRestart({
		...inactivePendingRequest,
		executionEpoch: 7,
		reason: "must not mutate an inactive pending receipt",
		dedupeOnly: true,
	}),
	(error: unknown) => {
		assert.ok(error instanceof WorkflowRestartConflictError);
		assert.match(error.message, /no matching completed operator abort/);
		return true;
	},
);
assert.equal(
	inactivePendingStore.rows.get(
		`${inactivePendingRequest.runId}:${inactivePendingClaim.path}`,
	)?.contentInline,
	inactivePendingContent,
);

const abortCasStore = createRestartReceiptDb();
const abortCasRequest = {
	db: abortCasStore.db,
	runId: restartRequest.runId,
	restartId: "restart-abort-cas",
};
const abortCasClaim = await claimWorkflowRestart(abortCasRequest);
const boundAbortCasContent = await bindWorkflowRestartExecutionEpoch({
	db: abortCasStore.db,
	runId: abortCasRequest.runId,
	path: abortCasClaim.path,
	pendingContent: abortCasClaim.pendingContent,
	executionEpoch: 7,
});
await finalizeWorkflowRestart({
	...abortCasRequest,
	path: abortCasClaim.path,
	pendingContent: boundAbortCasContent,
	result: { status: "unknown", executionEpoch: 7 },
});
const abortCasKey = `${abortCasRequest.runId}:${abortCasClaim.path}`;
abortCasStore.beforeNextUpdate(() => {
	const raced = abortCasStore.rows.get(abortCasKey);
	assert.ok(raced);
	abortCasStore.rows.set(abortCasKey, {
		contentInline: JSON.stringify({
			...JSON.parse(raced.contentInline),
			status: "accepted",
			updatedAt: new Date().toISOString(),
		}),
		outcome: "success",
	});
});
await assert.rejects(
	abortAmbiguousWorkflowRestart({
		...abortCasRequest,
		executionEpoch: 7,
		reason: "operator attempted abort during acceptance race",
	}),
	(error: unknown) => {
		assert.ok(error instanceof WorkflowRestartConflictError);
		assert.match(error.message, /receipt changed/);
		return true;
	},
);
assert.equal(
	JSON.parse(abortCasStore.rows.get(abortCasKey)?.contentInline ?? "null")
		.status,
	"accepted",
);

const rejectedStore = createRestartReceiptDb();
const rejectedRequest = {
	db: rejectedStore.db,
	runId: restartRequest.runId,
	restartId: "restart-rejected",
	from: null,
};
const rejectedClaim = await claimWorkflowRestart(rejectedRequest);
const boundRejectedContent = await bindWorkflowRestartExecutionEpoch({
	db: rejectedStore.db,
	runId: rejectedRequest.runId,
	path: rejectedClaim.path,
	pendingContent: rejectedClaim.pendingContent,
	executionEpoch: 6,
});
await finalizeWorkflowRestart({
	...rejectedRequest,
	path: rejectedClaim.path,
	pendingContent: boundRejectedContent,
	result: { status: "rejected", executionEpoch: 6 },
});
const rejectedRestart = await claimWorkflowRestart(rejectedRequest);
assert.equal(rejectedRestart.deduplicated, true);
assert.equal(rejectedRestart.receipt.status, "rejected");
assert.equal(
	rejectedStore.rows.get(`${rejectedRequest.runId}:${rejectedClaim.path}`)
		?.outcome,
	"failure",
);

// ── Terminal usage stamping: crash backstop + epoch pinning ────────────────
// Full drizzle-compatible tables so recordSkillRunOutcome (invoked inside
// reconcileSkillRun) can actually stamp the ledger, unlike the minimal
// lifecycle fixture above where stamping fail-softs.
const usageStampSqlite = new Database(":memory:");
usageStampSqlite.exec(`
	CREATE TABLE skill_entries (
		id TEXT PRIMARY KEY NOT NULL,
		organization_id TEXT NOT NULL,
		tedi_id TEXT,
		domain_id TEXT,
		title TEXT NOT NULL,
		slug TEXT,
		description TEXT,
		content TEXT NOT NULL,
		files TEXT,
		input_schema TEXT,
		success_count INTEGER NOT NULL DEFAULT 0,
		failure_count INTEGER NOT NULL DEFAULT 0,
		last_used_at TEXT,
		avg_duration_ms INTEGER,
		revision INTEGER NOT NULL DEFAULT 1,
		revision_reasoning TEXT,
		supersedes_id TEXT,
		source_skill_id TEXT,
		source_revision INTEGER,
		visibility TEXT NOT NULL DEFAULT 'private',
		agent_skills_format TEXT,
		r2_path TEXT,
		app_id TEXT,
		tool_ids TEXT,
		summary TEXT,
		tags TEXT,
		audience TEXT,
		preconditions TEXT,
		lifecycle_state TEXT DEFAULT 'draft',
		review_flagged_at TEXT,
		review_flag_reason TEXT,
		pace_layer TEXT,
		proposed_by_tedi_id TEXT,
		created_at TEXT DEFAULT CURRENT_TIMESTAMP,
		updated_at TEXT DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE skill_runs (
		id TEXT PRIMARY KEY NOT NULL,
		organization_id TEXT NOT NULL,
		skill_id TEXT NOT NULL,
		tedi_id TEXT NOT NULL,
		workflow_instance_id TEXT NOT NULL UNIQUE,
		execution_epoch INTEGER NOT NULL DEFAULT 0,
		restart_requested_at TEXT,
		restart_command_id TEXT,
		workflow_retired_at TEXT,
		runtime_environment TEXT NOT NULL,
		last_reconciled_at TEXT,
		status TEXT NOT NULL DEFAULT 'queued',
		params TEXT,
		result TEXT,
		error TEXT,
		capability_manifest TEXT,
		cost_summary TEXT,
		workflow_source TEXT,
		skill_doc TEXT,
		skill_revision INTEGER,
		skill_slug TEXT,
		started_at TEXT DEFAULT CURRENT_TIMESTAMP,
		completed_at TEXT,
		paused_at TEXT,
		created_by TEXT,
		work_item_id TEXT,
		origin_tedi_run_id TEXT
	);
	CREATE TABLE skill_usage_events (
		id TEXT PRIMARY KEY NOT NULL,
		organization_id TEXT NOT NULL,
		tedi_id TEXT,
		skill_id TEXT NOT NULL,
		run_id TEXT NOT NULL,
		execution_epoch INTEGER NOT NULL DEFAULT 0,
		source TEXT NOT NULL,
		outcome TEXT NOT NULL,
		error TEXT,
		started_at TEXT,
		finished_at TEXT,
		duration_ms INTEGER,
		created_at TEXT DEFAULT CURRENT_TIMESTAMP
	);
	CREATE UNIQUE INDEX uniq_skill_usage_events_run
		ON skill_usage_events (run_id, execution_epoch);
	CREATE TABLE skill_run_artifacts (
		id TEXT PRIMARY KEY NOT NULL,
		run_id TEXT NOT NULL,
		path TEXT NOT NULL,
		mime_type TEXT NOT NULL DEFAULT 'application/json',
		size_bytes INTEGER NOT NULL DEFAULT 0,
		content_inline TEXT,
		content_r2_key TEXT,
		sha256 TEXT,
		attempt INTEGER NOT NULL DEFAULT 1,
		outcome TEXT NOT NULL DEFAULT 'success',
		created_at TEXT DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE tedi_rationale_records (
		id TEXT PRIMARY KEY NOT NULL,
		run_id TEXT,
		evidence TEXT NOT NULL,
		outcome TEXT,
		outcome_status TEXT NOT NULL DEFAULT 'pending',
		tool_call_refs TEXT,
		proof_ref TEXT,
		completed_at TEXT
	);
	INSERT INTO skill_entries (id, organization_id, tedi_id, title, slug, content)
	VALUES ('skill-stamp', 'org-1', 'tedi-1', 'Stamped skill', 'stamped-skill', '# Skill');
	INSERT INTO skill_runs (
		id, organization_id, skill_id, tedi_id, workflow_instance_id,
		runtime_environment, status, workflow_source, skill_doc, started_at,
		completed_at
	) VALUES (
		'run-crash', 'org-1', 'skill-stamp', 'tedi-1', 'wf-crash',
		'production', 'completed', 'export default {}', '# Skill',
		'2026-07-16T00:00:00.000Z', '2026-07-16T00:05:00.000Z'
	);
	INSERT INTO skill_runs (
		id, organization_id, skill_id, tedi_id, workflow_instance_id,
		runtime_environment, status, workflow_source, skill_doc, started_at
	) VALUES (
		'run-race-stamp', 'org-1', 'skill-stamp', 'tedi-1', 'wf-race',
		'production', 'running', 'export default {}', '# Skill',
		'2026-07-16T01:00:00.000Z'
	);
`);

const usageEventRows = () =>
	usageStampSqlite
		.prepare(
			`SELECT run_id AS runId, execution_epoch AS executionEpoch,
			        outcome, error
			   FROM skill_usage_events ORDER BY execution_epoch ASC`,
		)
		.all() as Array<{
		runId: string;
		executionEpoch: number;
		outcome: string;
		error: string | null;
	}>;

// Crash backstop: the row is already terminal (a previous reconciler won the
// CAS then crashed before stamping). This pass loses the CAS but must still
// stamp the observed terminal-but-unstamped outcome.
{
	const stampDb = sqliteD1(usageStampSqlite);
	assert.equal(
		await reconcileSkillRun(stampDb, "run-crash", {
			status: "completed",
			result: { ok: true },
		}),
		false,
	);
	const stamped = usageEventRows().filter((row) => row.runId === "run-crash");
	assert.equal(stamped.length, 1);
	assert.equal(stamped[0]?.outcome, "success");
	assert.equal(stamped[0]?.executionEpoch, 0);
	// Idempotent: a second backstop pass may not double-count.
	assert.equal(
		await reconcileSkillRun(stampDb, "run-crash", {
			status: "completed",
			result: { ok: true },
		}),
		false,
	);
	assert.equal(
		usageEventRows().filter((row) => row.runId === "run-crash").length,
		1,
	);
	assert.equal(
		(
			usageStampSqlite
				.prepare(
					"SELECT success_count AS successCount FROM skill_entries WHERE id = 'skill-stamp'",
				)
				.get() as { successCount: number }
		).successCount,
		1,
	);
}

// Epoch-restart race: an operator restart reservation lands between the
// terminal CAS and the usage stamp's re-read. The stamp must carry the
// CAS-captured epoch (0), not the bumped one, so the restarted epoch's own
// terminal stamp is never suppressed.
{
	let raceArmed = true;
	const racingDb: D1Database = {
		...sqliteD1(usageStampSqlite),
		prepare: (query: string) => {
			if (
				raceArmed &&
				/^\s*select/i.test(query) &&
				query.includes('from "skill_runs"')
			) {
				raceArmed = false;
				usageStampSqlite
					.prepare(
						`UPDATE skill_runs
						    SET execution_epoch = execution_epoch + 1,
						        restart_requested_at = '2026-07-16T01:01:00.000Z',
						        restart_command_id = 'restart-race'
						  WHERE id = 'run-race-stamp'`,
					)
					.run();
			}
			return sqliteD1(usageStampSqlite).prepare(query);
		},
	} as unknown as D1Database;

	assert.equal(
		await reconcileSkillRun(racingDb, "run-race-stamp", {
			status: "failed",
			error: "step boom",
		}),
		true,
	);
	const raced = usageEventRows().filter(
		(row) => row.runId === "run-race-stamp",
	);
	assert.equal(raced.length, 1);
	assert.equal(raced[0]?.executionEpoch, 0);
	assert.equal(raced[0]?.outcome, "failure");
	assert.equal(raced[0]?.error, "step boom");

	// The restarted epoch (1) later completes and stamps its own slot.
	usageStampSqlite
		.prepare(
			`UPDATE skill_runs
			    SET status = 'running', error = NULL,
			        restart_requested_at = NULL, restart_command_id = NULL
			  WHERE id = 'run-race-stamp'`,
		)
		.run();
	assert.equal(
		await reconcileSkillRun(sqliteD1(usageStampSqlite), "run-race-stamp", {
			status: "completed",
			result: { ok: true },
			expectedExecutionEpoch: 1,
		}),
		true,
	);
	const bothEpochs = usageEventRows().filter(
		(row) => row.runId === "run-race-stamp",
	);
	assert.deepEqual(
		bothEpochs.map((row) => [row.executionEpoch, row.outcome]),
		[
			[0, "failure"],
			[1, "success"],
		],
	);
}

// Parse the generated module, then assert the critical Cloudflare-native
// primitives cannot silently disappear during future shim refactors.
new Bun.Transpiler({ loader: "js" }).transformSync(DISPATCH_SHIM);
const inspectMcpCompletionFailure = new Function(
	`${MCP_COMPLETION_FAILURE_INSPECTOR_SOURCE}; return workflowMcpCompletionFailure;`,
)() as (result: unknown) => {
	status: "failed" | "canceled";
	detail: string;
	nonRetryable: boolean;
} | null;
const inspectMcpProviderConfirmation = new Function(
	"testWorkflowRegex",
	"sliceWorkflowString",
	`${MCP_PROVIDER_CONFIRMATION_INSPECTOR_SOURCE}; return workflowMcpProviderConfirmation;`,
)(
	(pattern: RegExp, value: string) => pattern.test(value),
	(value: string, start: number, end: number) => value.slice(start, end),
) as (result: unknown) => string;
assert.equal(
	inspectMcpProviderConfirmation({
		completionEvidence: {
			status: "succeeded",
			providerConfirmation: "gmail-message:18f0a1",
		},
	}),
	"gmail-message:18f0a1",
);
for (const result of [
	null,
	{},
	{ completionEvidence: { status: "succeeded" } },
	{ completionEvidence: { providerConfirmation: "   " } },
	{ completionEvidence: { evidenceRefs: ["gmail-message:18f0a1"] } },
	{ completionEvidence: { target: "gmail-message:18f0a1" } },
	{ completionEvidence: { providerConfirmation: 123 } },
]) {
	assert.equal(inspectMcpProviderConfirmation(result), "unknown");
}
assert.deepEqual(
	inspectMcpCompletionFailure({
		ok: false,
		error: "BAD_REQUEST: gadgetId must be a number",
		completionEvidence: {
			operation: "revise_os_output",
			status: "failed",
			retry: { blocked: false, retryable: true },
		},
	}),
	{
		status: "failed",
		detail: "BAD_REQUEST: gadgetId must be a number",
		nonRetryable: true,
	},
);
assert.deepEqual(
	inspectMcpCompletionFailure({
		ok: false,
		error:
			'BAD_REQUEST: Input validation failed: (root): Unrecognized key: "tediId"',
		completionEvidence: {
			operation: "list_work_items",
			status: "failed",
			retry: { blocked: false, retryable: true },
		},
	}),
	{
		status: "failed",
		detail:
			'BAD_REQUEST: Input validation failed: (root): Unrecognized key: "tediId"',
		nonRetryable: true,
	},
);
assert.deepEqual(
	inspectMcpCompletionFailure({
		completionEvidence: {
			operation: "cancel_skill_workflow",
			status: "canceled",
			retry: { blocked: true, retryable: false },
		},
	}),
	{
		status: "canceled",
		detail: "cancel_skill_workflow reported canceled",
		nonRetryable: true,
	},
);
assert.equal(
	inspectMcpCompletionFailure({
		ok: false,
		completionEvidence: { status: "partial" },
	}),
	null,
);
assert.match(WORKFLOW_CONTEXT_MODULE, /AsyncLocalStorage/);
assert.match(DISPATCH_SHIM, /NonRetryableError/);
assert.match(
	DISPATCH_SHIM,
	/step\.do\(name, config, callback, wrappedRollback\)/,
);
assert.match(DISPATCH_SHIM, /step\.do\(name, callback, wrappedRollback\)/);
assert.match(DISPATCH_SHIM, /step\.sleepUntil\(name, timestamp\)/);
assert.match(
	DISPATCH_SHIM,
	/function attemptPath\(executionEpoch, stepPathSegment, stepCount, attempt\)/,
);
assert.match(DISPATCH_SHIM, /"epochs\/" \+ executionEpoch \+ "\/steps\/"/);
assert.match(DISPATCH_SHIM, /workflow_step_sensitive_output/);
assert.doesNotMatch(DISPATCH_SHIM, /\/completed\.json/);
assert.doesNotMatch(DISPATCH_SHIM, /\/failed\.json/);
assert.match(DISPATCH_SHIM, /providerConfirmation: "unknown"/);
assert.match(
	DISPATCH_SHIM,
	/providerConfirmation = workflowMcpProviderConfirmation\(result\)/,
);
assert.match(DISPATCH_SHIM, /MCP_TOOL_REPORTED_FAILURE/);
assert.match(DISPATCH_SHIM, /nextOrdinal: 1/);
assert.ok(DISPATCH_SHIM.includes("MCP upstream returned\\s+(\\d{3})"));
assert.match(DISPATCH_SHIM, /workflowName: event\.workflowName/);
assert.doesNotMatch(DISPATCH_SHIM, /DEFAULT_STEP_DO_CONFIG/);

console.log("workflow runtime tests passed");
