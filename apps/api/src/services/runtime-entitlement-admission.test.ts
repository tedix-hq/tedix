import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	budget: vi.fn(),
	find: vi.fn(),
	insert: vi.fn(),
}));
vi.mock("./runtime-budget-admission", () => ({
	authorizeRuntimeBudget: mocks.budget,
}));
vi.mock("@tedix/db/queries/provider-executions", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/provider-executions")>()),
	findProviderExecutionAdmission: mocks.find,
	buildProviderExecutionInsertStatement: mocks.insert,
}));
import { authorizeRuntimeInference } from "./runtime-entitlement-admission";
const now = Date.parse("2026-09-20T07:00:00.000Z");
const execution = {
	provider: "azure-openai" as const,
	requestModel: "custom",
	gatewayAccountId: "account",
	gatewayId: "gateway",
	transportKind: "gateway-https" as const,
	apiKind: "azure-responses" as const,
	providerResource: "resource",
	providerOrigin: "https://resource.openai.azure.com",
	deployment: "custom",
};
function request(mode: "managed" | "external" | "disabled") {
	return {
		organizationId: "org",
		settlementMode: mode,
		source: "kernel" as const,
		execution,
		workItemId: null,
		estimatedInputTokens: 10,
		estimatedOutputTokens: 20,
		idempotencyKey: "attempt-key",
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.find.mockResolvedValue(null);
	mocks.budget.mockImplementation(async (input) => {
		if (input.execution) mocks.find.mockResolvedValue(input.execution);
		return {
			allowed: true,
			settlementMode: input.request.settlementMode,
			reservationId: input.execution?.billingReservationId ?? null,
			expiresAt: null,
			estimatedChargeMicros: null,
		};
	});
	mocks.insert.mockImplementation((_db, input) => {
		mocks.find.mockResolvedValue(input);
		return Promise.resolve();
	});
});
afterEach(() => vi.restoreAllMocks());
describe("provider execution admission", () => {
	it.each(["managed", "external", "disabled"] as const)(
		"issues a required persisted execution in %s",
		async (mode) => {
			const result = await authorizeRuntimeInference({
				plane: "organization_kernel" as const,
				db: {} as never,
				env: { TEDIX_BILLING_SETTLEMENT_MODE: mode },
				request: request(mode),
				nowMs: now,
			});
			expect(result).toMatchObject({
				allowed: true,
				attributionVersion: 3,
				executionId: expect.any(String),
				sendBefore: "2026-09-20T07:10:00.000Z",
			});
			if (mode !== "managed") expect(mocks.insert).toHaveBeenCalledOnce();
		},
	);
	it("does not grant admission when the managed batch produced no receipt", async () => {
		mocks.budget.mockResolvedValue({
			allowed: true,
			settlementMode: "managed",
			reservationId: "reservation",
			expiresAt: null,
			estimatedChargeMicros: 0,
		});
		await expect(
			authorizeRuntimeInference({
				plane: "organization_kernel" as const,
				db: {} as never,
				env: { TEDIX_BILLING_SETTLEMENT_MODE: "managed" },
				request: request("managed"),
				nowMs: now,
			}),
		).rejects.toThrow(/not persisted/);
	});
	it("denial never inserts an execution", async () => {
		mocks.budget.mockResolvedValue({
			allowed: false,
			code: "payment_required",
			entitlement: null,
		});
		expect(
			await authorizeRuntimeInference({
				plane: "organization_kernel" as const,
				db: {} as never,
				env: { TEDIX_BILLING_SETTLEMENT_MODE: "external" },
				request: request("external"),
				nowMs: now,
			}),
		).toMatchObject({ allowed: false });
		expect(mocks.insert).not.toHaveBeenCalled();
	});
	it("matching retry retains its ID and deadline; expired retry fails", async () => {
		const input = {
			plane: "organization_kernel" as const,
			db: {} as never,
			env: { TEDIX_BILLING_SETTLEMENT_MODE: "external" },
			request: request("external"),
			nowMs: now,
		};
		const first = await authorizeRuntimeInference(input);
		expect(
			await authorizeRuntimeInference({ ...input, nowMs: now + 1000 }),
		).toEqual(first);
		await expect(
			authorizeRuntimeInference({ ...input, nowMs: now + 600000 }),
		).rejects.toThrow(/expired/);
	});
	it("rejects cross-account replay of the admission key", async () => {
		const input = {
			plane: "organization_kernel" as const,
			db: {} as never,
			env: { TEDIX_BILLING_SETTLEMENT_MODE: "external" },
			request: request("external"),
			nowMs: now,
		};
		await authorizeRuntimeInference(input);
		await expect(
			authorizeRuntimeInference({
				...input,
				request: {
					...input.request,
					execution: { ...execution, gatewayAccountId: "foreign" },
				},
			}),
		).rejects.toThrow(/identity conflict/);
	});
});

describe("server-owned inference caller plane", () => {
	it("does not infer kernel authority from a remote request source", async () => {
		await expect(
			authorizeRuntimeInference({
				db: {} as never,
				env: {
					TEDIX_BILLING_SETTLEMENT_MODE: "external",
					SECRETS_MASTER_KEY: "secret",
				},
				plane: "remote_runtime",
				request: { ...request("external"), originToken: "invalid" },
				nowMs: now,
			}),
		).rejects.toThrow(/signature/);
		expect(mocks.find).not.toHaveBeenCalled();
		expect(mocks.budget).not.toHaveBeenCalled();
	});
	it("rejects absent server authority even when source is kernel", async () => {
		await expect(
			authorizeRuntimeInference({
				db: {} as never,
				env: { TEDIX_BILLING_SETTLEMENT_MODE: "external" },
				request: request("external"),
			} as never),
		).rejects.toThrow(/server-owned/);
		expect(mocks.find).not.toHaveBeenCalled();
	});
});

import { DatabaseSync } from "node:sqlite";
import { is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { createDbClient } from "@tedix/db/client";
import * as tables from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { signRuntimeInferenceOrigin } from "@tedix/auth/runtime-inference-origin";
import { reserveBillingUsage } from "@tedix/db/queries/billing/reservations";
const zeroOrigin = () => ({
	kind: "unselected_native" as const,
	root: {
		owner: { orgId: "org", tediId: "tedi", objectId: "a".repeat(64) },
		objectName: "root",
		className: "AgentTediDO" as const,
		path: [],
		generation: 0 as const,
	},
	selected: {
		owner: { orgId: "org", tediId: "tedi", objectId: "a".repeat(64) },
		className: "AgentTediDO" as const,
		identityName: "root",
		facetName: null,
		path: [],
		generation: 0 as const,
	},
	configurationHash: "b".repeat(64),
});
async function nativeFixture(mode: "managed" | "external" | "disabled") {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			...Object.values(tables).filter((value): value is SQLiteTable =>
				is(value, SQLiteTable),
			),
		),
	);
	sqlite
		.prepare(
			"INSERT INTO organizations(id,name,slug) VALUES ('org','org','org')",
		)
		.run();
	sqlite
		.prepare(
			"INSERT INTO tedis(id,organization_id,name,slug,isolate_agent_id) VALUES ('tedi','org','tedi','tedi','root')",
		)
		.run();
	sqlite.exec(
		"INSERT INTO billing_plan_versions(id,plan_key,version,status,name,included_monthly_tokens,max_tedis,max_cron_jobs_per_tedi,max_iterations_per_task,default_daily_token_limit,default_daily_message_limit,effective_at,created_at) VALUES ('plan','growth',1,'active','Plan',100000,10,10,10,100000,1000,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'); INSERT INTO billing_accounts(organization_id,plan_version_id,status,billing_mode,period_start,period_end,created_at,updated_at) VALUES ('org','plan','active','internal','2026-01-01T00:00:00Z','2100-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
	);
	const db = createDbClient(createD1Facade(sqlite));
	const owner = await vi.importActual<
		typeof import("@tedix/db/queries/provider-executions")
	>("@tedix/db/queries/provider-executions");
	mocks.find.mockImplementation(owner.findProviderExecutionAdmission);
	mocks.insert.mockImplementation(owner.buildProviderExecutionInsertStatement);
	mocks.budget.mockImplementation(async (input) => {
		if (mode !== "managed")
			return {
				allowed: true,
				settlementMode: mode,
				reservationId: null,
				expiresAt: null,
				estimatedChargeMicros: null,
			};
		const result = await reserveBillingUsage(db, {
			id: input.execution.billingReservationId,
			execution: input.execution,
			executionGuard: input.executionGuard,
			organizationId: input.request.organizationId,
			tediId: input.request.tediId,
			runId: input.request.runId,
			source: "kernel",
			provider: execution.provider,
			model: execution.requestModel,
			estimatedInputTokens: 10,
			estimatedOutputTokens: 20,
			idempotencyKey: "attempt-key",
			expiresAt: input.execution.sendBefore,
			now: new Date().toISOString(),
		});
		if (!result.allowed) throw new Error(result.code);
		return {
			allowed: true,
			settlementMode: mode,
			reservationId: result.reservation.id,
			expiresAt: result.reservation.expiresAt,
			estimatedChargeMicros: result.reservation.estimatedChargeMicros,
		};
	});
	const projection = { ...request(mode), tediId: "tedi" };
	const token = await signRuntimeInferenceOrigin({
		secret: "secret",
		request: projection,
		origin: zeroOrigin(),
	});
	return {
		sqlite,
		db,
		owner,
		input: {
			db,
			env: {
				TEDIX_BILLING_SETTLEMENT_MODE: mode,
				SECRETS_MASTER_KEY: "secret",
			},
			plane: "remote_runtime" as const,
			request: { ...projection, originToken: token },
		},
	};
}
describe("native admission owning D1 guard", () => {
	it.each(["managed", "external", "disabled"] as const)(
		"keeps immutable %s receipt and denies changed canonical custody",
		async (mode) => {
			const f = await nativeFixture(mode);
			const first = await authorizeRuntimeInference(f.input);
			const stored = f.sqlite
				.prepare("SELECT * FROM provider_execution_attempts")
				.get();
			expect(await authorizeRuntimeInference(f.input)).toEqual(first);
			expect(
				f.sqlite.prepare("SELECT * FROM provider_execution_attempts").get(),
			).toEqual(stored);
			f.sqlite.exec("UPDATE tedis SET isolate_agent_id='changed'");
			await expect(authorizeRuntimeInference(f.input)).rejects.toThrow(
				/policy/,
			);
			expect(
				f.sqlite.prepare("SELECT * FROM provider_execution_attempts").get(),
			).toEqual(stored);
		},
	);
	it.each(["external", "disabled"] as const)(
		"refuses %s insert when custody changes after preparation",
		async (mode) => {
			const f = await nativeFixture(mode);
			mocks.insert.mockImplementation(async (...args) => {
				f.sqlite.exec("UPDATE tedis SET isolate_agent_id='changed'");
				return f.owner.buildProviderExecutionInsertStatement(
					...(args as Parameters<
						typeof f.owner.buildProviderExecutionInsertStatement
					>),
				);
			});
			await expect(authorizeRuntimeInference(f.input)).rejects.toThrow(
				/not persisted/,
			);
			expect(
				f.sqlite
					.prepare("SELECT count(*) n FROM provider_execution_attempts")
					.get(),
			).toEqual({ n: 0 });
		},
	);
	it("rolls the managed hold back if custody changes inside the reservation batch", async () => {
		const f = await nativeFixture("managed");
		f.sqlite.exec(
			"CREATE TRIGGER mutate_custody AFTER INSERT ON billing_usage_reservations BEGIN UPDATE tedis SET isolate_agent_id='changed'; END",
		);
		await expect(authorizeRuntimeInference(f.input)).rejects.toThrow();
		expect(
			f.sqlite
				.prepare("SELECT count(*) n FROM provider_execution_attempts")
				.get(),
		).toEqual({ n: 0 });
		expect(
			f.sqlite
				.prepare("SELECT count(*) n FROM billing_usage_reservations")
				.get(),
		).toEqual({ n: 0 });
		expect(
			f.sqlite.prepare("SELECT isolate_agent_id FROM tedis").get(),
		).toEqual({ isolate_agent_id: "root" });
	});
});

it.each(["reserved", "settled"] as const)(
	"managed %s retry stays linked and cannot promote legacy provenance",
	async (status) => {
		const f = await nativeFixture("managed");
		const first = await authorizeRuntimeInference(f.input);
		f.sqlite
			.prepare("UPDATE billing_usage_reservations SET status=?")
			.run(status);
		expect(await authorizeRuntimeInference(f.input)).toEqual(first);
		f.sqlite.exec(
			"UPDATE provider_execution_attempts SET origin=NULL,origin_hash=NULL",
		);
		await expect(authorizeRuntimeInference(f.input)).rejects.toThrow(
			/provenance/,
		);
		expect(
			f.sqlite.prepare("SELECT origin FROM provider_execution_attempts").get(),
		).toEqual({ origin: null });
	},
);

it.each(["managed", "external", "disabled"] as const)(
	"positive native generation in %s cannot claim gen0 or bypass a finite permit",
	async (mode) => {
		const f = await nativeFixture(mode);
		const zero = zeroOrigin();
		const owner = zero.root.owner;
		const accepted = {
			owner,
			runId: "run",
			sessionKey: "session",
			principalId: "human",
			inputHash: "e".repeat(64),
			requestHash: "f".repeat(64),
			generation: 1,
		};
		const origin = {
			kind: "accepted_native",
			root: { ...zero.root, generation: 1, accepted },
			selected: { ...zero.selected, generation: 1, accepted },
			operation: null,
			configurationHash: null,
		};
		const projection = { ...request(mode), tediId: "tedi", runId: "run" };
		const token = await signRuntimeInferenceOrigin({
			secret: "secret",
			request: projection,
			origin,
		});
		await expect(
			authorizeRuntimeInference({
				...f.input,
				request: { ...projection, originToken: token },
			}),
		).rejects.toThrow();
		expect(
			f.sqlite
				.prepare("SELECT count(*) n FROM provider_execution_attempts")
				.get(),
		).toEqual({ n: 0 });
		expect(
			f.sqlite
				.prepare("SELECT count(*) n FROM billing_usage_reservations")
				.get(),
		).toEqual({ n: 0 });
	},
);

import {
	FiniteExecutionAuthorizationSchema,
	HistoricalExposureSchema,
} from "@tedix/api-contract/schemas/billing";
import {
	historicalRequestHash,
	historicalExposureSet,
	recordHistoricalExposure,
	recordFiniteExecutionAuthorization,
} from "@tedix/db/queries/billing/historical-exposure";
async function finiteFixture(mode: "managed" | "external" | "disabled") {
	const f = await nativeFixture(mode);
	const org = "00000000-0000-4000-8000-000000000001",
		tedi = "00000000-0000-4000-8000-000000000002",
		user = "00000000-0000-4000-8000-000000000003",
		plan = "00000000-0000-4000-8000-000000000004";
	f.sqlite.prepare("UPDATE organizations SET id=?").run(org);
	f.sqlite
		.prepare("UPDATE tedis SET id=?,organization_id=?,isolate_agent_id='old'")
		.run(tedi, org);
	f.sqlite.prepare("UPDATE billing_plan_versions SET id=?").run(plan);
	f.sqlite
		.prepare("UPDATE billing_accounts SET organization_id=?,plan_version_id=?")
		.run(org, plan);
	await f.db.insert(tables.organizationMembers).values({
		id: "member",
		organizationId: org,
		userId: user,
		descopeUserId: "human",
		email: "human@example.test",
		role: "owner",
		status: "active",
	});
	const observedAt = new Date().toISOString();
	const inspection = {
		tediId: tedi,
		operationId: "exposure",
		rootObjectId: "c".repeat(64),
		objectId: "c".repeat(64),
		targetPath: [],
		expectedGeneration: 1,
		snapshotId: "d".repeat(64),
		sourceHash: "e".repeat(64),
	};
	const exposure = HistoricalExposureSchema.parse({
		id: crypto.randomUUID(),
		organizationId: org,
		tediId: tedi,
		rootObjectName: "old",
		rootObjectId: inspection.rootObjectId,
		targetPath: [],
		objectName: "old",
		objectId: inspection.objectId,
		className: "AgentTediDO",
		generation: 1,
		snapshotId: inspection.snapshotId,
		sourceHash: inspection.sourceHash,
		manifestHash: null,
		originalRunId: null,
		originalWorkId: null,
		originalPeriod: null,
		usage: null,
		costMicros: null,
		effects: "UNKNOWN",
		exposure: "UNKNOWN",
		workflowCount: 0,
		fiberCount: 0,
		identityCount: 1,
		observedBy: "human",
		observedUserId: user,
		observedAt,
		requestHash: await historicalRequestHash([org, "human", user, inspection]),
	});
	await recordHistoricalExposure(f.db, {
		operationId: "exposure",
		payload: exposure,
	});
	f.sqlite.exec("UPDATE tedis SET isolate_agent_id='root'");
	const set = await historicalExposureSet(f.db, org, tedi);
	const input = {
		kind: "authorize_fresh_execution",
		tediId: tedi,
		operationId: "permit",
		expectedRevision: 0,
		exposureSetHash: set.hash,
		freshRootName: "root",
		freshRootId: "a".repeat(64),
		preparedGeneration: 1,
		executionGeneration: 2,
		leafScopes: [],
		funding: {
			accountId: org,
			entitlementVersion: 1,
			settlementMode: mode,
			billingMode: "internal",
			status: "active",
			planVersionId: plan,
			planVersion: 1,
			periodStart: "2026-01-01T00:00:00Z",
			periodEnd: "2100-01-01T00:00:00Z",
			stripeEnvironment: null,
		},
		maxSendDurationSeconds: 30,
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		acknowledgeUnboundedUnknownExposure: true,
		acknowledgeOutstandingSendWindowAfterRevocation: true,
	};
	const grant = FiniteExecutionAuthorizationSchema.parse({
		id: crypto.randomUUID(),
		organizationId: org,
		tediId: tedi,
		revision: 1,
		kind: "decision",
		decisionId: null,
		recordedBy: "human",
		recordedUserId: user,
		recordedAt: observedAt,
		requestHash: await historicalRequestHash([org, "human", user, input]),
		input,
		authority: "finite_execution_permit",
		preparation: {
			state: "held",
			generation: 1,
			inspectionHash: "f".repeat(64),
			receiver: "raw-cutover-v1",
		},
		exposures: [exposure],
		exposureOperations: [{ id: exposure.id, operationId: "exposure" }],
	});
	expect(await recordFiniteExecutionAuthorization(f.db, grant)).not.toBeNull();
	const zero = zeroOrigin(),
		owner = { orgId: org, tediId: tedi, objectId: "a".repeat(64) };
	const accepted = {
		owner,
		runId: "run",
		sessionKey: "session",
		principalId: "human",
		inputHash: "e".repeat(64),
		requestHash: "f".repeat(64),
		generation: 2,
	};
	const origin = {
		kind: "accepted_native",
		root: { ...zero.root, owner, generation: 2, accepted },
		selected: { ...zero.selected, owner, generation: 2, accepted },
		operation: null,
		configurationHash: null,
	};
	const projection = {
		...request(mode),
		organizationId: org,
		tediId: tedi,
		runId: "run",
	};
	const originToken = await signRuntimeInferenceOrigin({
		secret: "secret",
		request: projection,
		origin,
	});
	return {
		...f,
		grant,
		input: { ...f.input, request: { ...projection, originToken } },
	};
}
it.each(["managed", "external", "disabled"] as const)(
	"uses current finite permit and immutable bounded %s window",
	async (mode) => {
		const f = await finiteFixture(mode);
		const start = Date.now();
		const first = await authorizeRuntimeInference(f.input);
		expect(first.allowed).toBe(true);
		if (!first.allowed) throw new Error("Denied finite fixture");
		expect(Date.parse(first.sendBefore) - start).toBeLessThanOrEqual(31000);
		expect(await authorizeRuntimeInference(f.input)).toEqual(first);
		expect(
			f.sqlite.prepare("SELECT policy FROM provider_execution_attempts").get()
				?.policy,
		).toContain(f.grant.id);
		f.sqlite.exec("UPDATE organization_members SET status='inactive'");
		await expect(authorizeRuntimeInference(f.input)).rejects.toThrow(/policy/);
	},
);
it.each(["member", "funding", "set", "revocation"] as const)(
	"denies finite %s race after preparation without any hold or receipt",
	async (change) => {
		const f = await finiteFixture("managed");
		const reserve = mocks.budget.getMockImplementation()!;
		mocks.budget.mockImplementation(async (input) => {
			if (change === "member")
				f.sqlite.exec("UPDATE organization_members SET status='inactive'");
			if (change === "funding")
				f.sqlite.exec("UPDATE billing_accounts SET status='suspended'");
			if (change === "set")
				f.sqlite.exec(
					"UPDATE billing_historical_exposures SET request_hash='changed'",
				);
			if (change === "revocation")
				f.sqlite.exec(
					"UPDATE billing_historical_decisions SET kind='revocation'",
				);
			return reserve(input);
		});
		await expect(authorizeRuntimeInference(f.input)).rejects.toThrow();
		expect(
			f.sqlite
				.prepare("SELECT count(*) n FROM provider_execution_attempts")
				.get(),
		).toEqual({ n: 0 });
		expect(
			f.sqlite
				.prepare("SELECT count(*) n FROM billing_usage_reservations")
				.get(),
		).toEqual({ n: 0 });
	},
);
it("does not select an older valid permit beneath a malformed latest decision", async () => {
	const f = await finiteFixture("external");
	f.sqlite
		.prepare(
			"INSERT INTO billing_historical_decisions(id,organization_id,tedi_id,revision,kind,decision_id,operation_id,request_hash,payload,recorded_by,recorded_user_id,recorded_at) VALUES (?,?,?,2,'decision',NULL,'latest',?,'{}','human',?,?)",
		)
		.run(
			crypto.randomUUID(),
			f.grant.organizationId,
			f.grant.tediId,
			"a".repeat(64),
			f.grant.recordedUserId,
			new Date().toISOString(),
		);
	await expect(authorizeRuntimeInference(f.input)).rejects.toThrow(
		/not persisted/,
	);
	expect(
		f.sqlite
			.prepare("SELECT count(*) n FROM provider_execution_attempts")
			.get(),
	).toEqual({ n: 0 });
});

describe("bounded admission failure diagnostics", () => {
	it.each([
		"find_existing",
		"budget_admission",
		"unmanaged_insert",
		"final_guarded_read",
	] as const)(
		"preserves the original exception at %s without logging request or query text",
		async (phase) => {
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			const original = new Error(
				"private SQL params customer-text originToken secret-token",
				{
					cause: new Error(
						"D1_ERROR: CHECK constraint failed: private-table private-value",
					),
				},
			);
			original.name = "secret-exception-name";
			const mode = phase === "unmanaged_insert" ? "external" : "managed";
			if (phase === "find_existing") mocks.find.mockRejectedValueOnce(original);
			if (phase === "budget_admission")
				mocks.budget.mockRejectedValueOnce(original);
			if (phase === "unmanaged_insert")
				mocks.insert.mockRejectedValueOnce(original);
			if (phase === "final_guarded_read") {
				mocks.find.mockResolvedValueOnce(null).mockRejectedValueOnce(original);
				mocks.budget.mockResolvedValueOnce({
					allowed: true,
					settlementMode: mode,
				});
			}
			await expect(
				authorizeRuntimeInference({
					db: {} as never,
					env: { TEDIX_BILLING_SETTLEMENT_MODE: mode },
					plane: "organization_kernel",
					request: { ...request(mode), metadata: { text: "customer-text" } },
				}),
			).rejects.toBe(original);
			expect(log).toHaveBeenCalledTimes(1);
			expect(log.mock.calls[0][1]).toMatchObject({
				phase,
				plane: "organization_kernel",
				settlementMode: mode,
				hasFiniteAuthorization: false,
				causeChain: [
					{
						messageClass: [
							"D1_ERROR",
							"constraint failed",
							"CHECK constraint failed",
						],
					},
				],
			});
			expect(JSON.stringify(log.mock.calls)).not.toMatch(
				/private|customer-text|secret|originToken|sha256|params/,
			);
		},
	);
	it.each([
		"verify_origin",
		"read_latest_decision",
		"prepare_native_guard",
	] as const)(
		"reports actual native %s failure with verified context only",
		async (phase) => {
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			const f = await nativeFixture("managed");
			if (phase === "verify_origin")
				f.input.request.originToken = "private-invalid-token";
			if (phase === "read_latest_decision")
				f.sqlite.exec("DROP TABLE billing_historical_decisions");
			if (phase === "prepare_native_guard")
				f.sqlite.exec("DROP TABLE billing_historical_exposures");
			await expect(authorizeRuntimeInference(f.input)).rejects.toThrow();
			const metadata = log.mock.calls[0][1] as Record<string, unknown>;
			expect(metadata).toMatchObject({
				phase,
				plane: "remote_runtime",
				settlementMode: "managed",
			});
			if (phase === "verify_origin")
				expect(metadata.originKind).toBeUndefined();
			else
				expect(metadata).toMatchObject({
					originKind: "unselected_native",
					rootClass: "AgentTediDO",
					selectedClass: "AgentTediDO",
					rootGeneration: 0,
					selectedGeneration: 0,
				});
			expect(JSON.stringify(log.mock.calls)).not.toMatch(
				/private-invalid|billing_historical|rootObject|objectId|objectName|sha256|originToken/,
			);
		},
	);
	it("reports managed rollback as a JSON category without claiming policy refusal", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const f = await nativeFixture("managed");
		f.sqlite.exec(
			"CREATE TRIGGER diagnostic_race AFTER INSERT ON billing_usage_reservations BEGIN UPDATE tedis SET isolate_agent_id='private-changed'; END",
		);
		await expect(authorizeRuntimeInference(f.input)).rejects.toThrow();
		expect(log.mock.calls[0][1]).toMatchObject({
			phase: "budget_admission",
			messageClass: ["malformed JSON"],
		});
		expect(JSON.stringify(log.mock.calls)).not.toMatch(
			/private-changed|provider_admission_refused|policy_refusal/,
		);
		expect(
			f.sqlite
				.prepare("SELECT count(*) n FROM billing_usage_reservations")
				.get(),
		).toEqual({ n: 0 });
		expect(
			f.sqlite
				.prepare("SELECT count(*) n FROM provider_execution_attempts")
				.get(),
		).toEqual({ n: 0 });
	});
	it.each(["console", "classification"] as const)(
		"cannot mask the original failure when %s throws",
		async (failure) => {
			const original = new Error("original-secret");
			const log = vi.spyOn(console, "error").mockImplementation(() => {
				if (failure === "console") throw new Error("logger failure");
			});
			if (failure === "classification")
				Object.defineProperty(original, "message", {
					get() {
						throw new Error("message getter failure");
					},
				});
			mocks.find.mockRejectedValueOnce(original);
			await expect(
				authorizeRuntimeInference({
					db: {} as never,
					env: { TEDIX_BILLING_SETTLEMENT_MODE: "managed" },
					plane: "organization_kernel",
					request: request("managed"),
				}),
			).rejects.toBe(original);
			if (failure === "classification") expect(log).not.toHaveBeenCalled();
		},
	);
});

it("reports an accepted claim and finite authorization without exposing their payloads", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const f = await finiteFixture("managed");
	const original = new Error("private-finite-secret");
	mocks.budget.mockRejectedValueOnce(original);
	await expect(authorizeRuntimeInference(f.input)).rejects.toBe(original);
	expect(log.mock.calls[0][1]).toMatchObject({
		phase: "budget_admission",
		originKind: "accepted_native",
		rootClass: "AgentTediDO",
		selectedClass: "AgentTediDO",
		hasFiniteAuthorization: true,
	});
	const metadata = log.mock.calls[0][1] as Record<string, unknown>;
	expect(metadata.rootGeneration).toBeGreaterThan(0);
	expect(metadata.selectedGeneration).toBeGreaterThan(0);
	expect(JSON.stringify(log.mock.calls)).not.toMatch(
		/private|requestHash|inputHash|objectId|objectName|authorizationId|originToken|sha256/,
	);
});
it("distinguishes an actual original guarded replay read from the reservation batch", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const f = await nativeFixture("managed");
	await authorizeRuntimeInference(f.input);
	const original = new Error("D1_ERROR: private guarded query");
	let reads = 0;
	mocks.find.mockImplementation((...args) => {
		if (++reads === 2) throw original;
		return f.owner.findProviderExecutionAdmission(
			args[0],
			args[1],
			args[2],
			args[3],
		);
	});
	await expect(authorizeRuntimeInference(f.input)).rejects.toBe(original);
	expect(log.mock.calls[0][1]).toMatchObject({
		phase: "replay_guard_read",
		messageClass: ["D1_ERROR"],
	});
	expect(
		f.sqlite.prepare("SELECT count(*) n FROM billing_usage_reservations").get(),
	).toEqual({ n: 1 });
	expect(
		f.sqlite
			.prepare("SELECT count(*) n FROM provider_execution_attempts")
			.get(),
	).toEqual({ n: 1 });
	expect(JSON.stringify(log.mock.calls)).not.toContain("private");
});
