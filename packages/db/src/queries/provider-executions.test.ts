import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import {
	FiniteExecutionAuthorizationSchema,
	HistoricalExposureSchema,
	HistoricalExposureInputSchema,
} from "@tedix/api-contract/schemas/billing";
import { historicalRequestHash } from "./billing/historical-exposure";
import { is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import * as billing from "../schema/billing";
import type { NewProviderExecutionAttemptRow } from "../schema/provider-executions";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { providerDeploymentScope } from "@tedix/api-contract/schemas/provider-execution";
import {
	assertProviderExecutionMatches,
	buildProviderExecutionInsertStatement,
	findProviderExecutionAdmission,
	prepareProviderExecutionAdmission,
} from "./provider-executions";
import { reserveBillingUsage } from "./billing/reservations";
const now = "2026-09-20T07:00:00.000Z";
function receipt(
	overrides: Partial<NewProviderExecutionAttemptRow> = {},
): NewProviderExecutionAttemptRow {
	const identity = {
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
	return {
		...identity,
		id: "execution",
		organizationId: "org",
		source: "kernel",
		idempotencyKey: "attempt-key",
		settlementMode: "external",
		billingReservationId: null,
		authorizedAt: now,
		sendBefore: "2026-09-20T07:10:00.000Z",
		deploymentScope: providerDeploymentScope(identity),
		...overrides,
	};
}
async function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE organizations(id TEXT PRIMARY KEY, metadata TEXT NOT NULL DEFAULT '{}'); CREATE TABLE tedis(id TEXT PRIMARY KEY, organization_id TEXT, isolate_agent_id TEXT); INSERT INTO organizations(id) VALUES ('org');",
	);
	sqlite.exec(
		schemaDdl(
			...Object.values(billing).filter((value): value is SQLiteTable =>
				is(value, SQLiteTable),
			),
		),
	);
	const migration = readFileSync(
		new URL(
			"../../drizzle/20260920072429_provider_execution_cost_provenance/migration.sql",
			import.meta.url,
		),
		"utf8",
	);
	sqlite.exec(migration.split("--> statement-breakpoint")[0]!);
	sqlite.exec(
		"CREATE UNIQUE INDEX uniq_provider_execution_admission ON provider_execution_attempts(organization_id,idempotency_key)",
	);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../drizzle/20260923094659_jev_provider_execution/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../drizzle/20261005083924_provider_execution_origin/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	sqlite.exec("INSERT INTO tedis VALUES ('tedi','org','root')");
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(billing.billingPlanVersions).values({
		id: "plan",
		planKey: "growth",
		version: 1,
		status: "active",
		name: "Plan",
		includedMonthlyTokens: 100000,
		maxTedis: 10,
		maxCronJobsPerTedi: 10,
		maxIterationsPerTask: 10,
		defaultDailyTokenLimit: 100000,
		defaultDailyMessageLimit: 1000,
		effectiveAt: now,
	});
	await db.insert(billing.billingAccounts).values({
		organizationId: "org",
		planVersionId: "plan",
		status: "active",
		billingMode: "internal",
		periodStart: "2026-09-01T00:00:00.000Z",
		periodEnd: "2026-10-01T00:00:00.000Z",
	});
	return { sqlite, db };
}
describe("immutable provider execution admission", () => {
	it("defers the insert until awaited, and retains exact identity", async () => {
		const { db, sqlite } = await setup();
		const input = receipt();
		const statement = buildProviderExecutionInsertStatement(db, input);
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM provider_execution_attempts")
				.get(),
		).toEqual({ n: 0 });
		await statement;
		const stored = await findProviderExecutionAdmission(
			db,
			"org",
			"attempt-key",
		);
		expect(stored?.deployment).toBe("custom");
		expect(() =>
			assertProviderExecutionMatches(
				stored!,
				receipt({ gatewayAccountId: "other" }),
			),
		).toThrow();
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM billing_usage_reservations")
				.get(),
		).toEqual({ n: 0 });
	});
	it("atomically writes a managed reservation and execution", async () => {
		const { db } = await setup();
		const execution = receipt({
			settlementMode: "managed",
			billingReservationId: "reservation",
		});
		const result = await reserveBillingUsage(db, {
			id: "reservation",
			organizationId: "org",
			source: "kernel",
			provider: "azure-openai",
			model: "custom",
			estimatedInputTokens: 10,
			estimatedOutputTokens: 20,
			idempotencyKey: "attempt-key",
			expiresAt: execution.sendBefore,
			now,
			execution,
		});
		expect(result.allowed).toBe(true);
		expect(
			(await findProviderExecutionAdmission(db, "org", "attempt-key"))
				?.billingReservationId,
		).toBe("reservation");
	});
	it("rolls reservation back if receipt persistence fails", async () => {
		const { db, sqlite } = await setup();
		sqlite.exec(
			"CREATE TRIGGER reject_receipt BEFORE INSERT ON provider_execution_attempts BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END;",
		);
		const execution = receipt({
			settlementMode: "managed",
			billingReservationId: "reservation",
		});
		await expect(
			reserveBillingUsage(db, {
				id: "reservation",
				organizationId: "org",
				source: "kernel",
				provider: "azure-openai",
				model: "custom",
				estimatedInputTokens: 10,
				estimatedOutputTokens: 20,
				idempotencyKey: "attempt-key",
				expiresAt: execution.sendBefore,
				now,
				execution,
			}),
		).rejects.toThrow();
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM billing_usage_reservations")
				.get(),
		).toEqual({ n: 0 });
	});
	it("cannot insert a managed receipt without its admitted reservation", async () => {
		const { db } = await setup();
		await buildProviderExecutionInsertStatement(
			db,
			receipt({ settlementMode: "managed", billingReservationId: "absent" }),
		);
		expect(
			await findProviderExecutionAdmission(db, "org", "attempt-key"),
		).toBeNull();
	});
	it("actual migration CHECK rejects null Azure deployment and unknown transports", async () => {
		const { db, sqlite } = await setup();
		await buildProviderExecutionInsertStatement(db, receipt());
		expect(() =>
			sqlite.exec("UPDATE provider_execution_attempts SET deployment=NULL"),
		).toThrow();
		expect(() =>
			sqlite.exec(
				"UPDATE provider_execution_attempts SET transport_kind='anything'",
			),
		).toThrow();
	});
});

describe("populated canonical cost migration", () => {
	it("preserves historical values, attribution and the org guard trigger", () => {
		const sqlite = new DatabaseSync(":memory:");
		const directory = new URL("../../drizzle/", import.meta.url);
		const target = "20260920072429_provider_execution_cost_provenance";
		for (const entry of readdirSync(directory, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() && /^\d/.test(entry.name) && entry.name < target,
			)
			.sort((a, b) => a.name.localeCompare(b.name)))
			sqlite.exec(
				readFileSync(new URL(`${entry.name}/migration.sql`, directory), "utf8"),
			);
		sqlite.exec(
			"INSERT INTO organizations(id,name,slug) VALUES ('migration-org','Migration org','migration-org')",
		);
		const insert = sqlite.prepare(
			"INSERT INTO tedi_call_costs(id,gateway_log_id,gateway_id,snapshot_at,model,org_id,session_type,input_tokens,output_tokens,total_tokens,estimated_cost_usd,data_quality) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
		);
		insert.run(
			"zero",
			"zero",
			"gateway",
			now,
			"known-zero",
			"migration-org",
			"kernel",
			3,
			4,
			7,
			0,
			"ok",
		);
		insert.run(
			"precise",
			"precise",
			"gateway",
			now,
			"historical",
			"migration-org",
			"kernel",
			3,
			4,
			7,
			0.123456789012345,
			"ok",
		);
		insert.run(
			"held",
			"held",
			"gateway",
			now,
			"unknown",
			null,
			"unattributed",
			33,
			44,
			77,
			0,
			"quarantined_no_pricing",
		);
		const before = sqlite
			.prepare("SELECT * FROM tedi_call_costs ORDER BY id")
			.all();
		const trigger = sqlite
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type='trigger' AND name='require_org_id_for_attributed_calls'",
			)
			.get();
		sqlite.exec(
			readFileSync(new URL(`${target}/migration.sql`, directory), "utf8"),
		);
		const after = sqlite
			.prepare("SELECT * FROM tedi_call_costs ORDER BY id")
			.all();
		expect(
			after.map((row) =>
				Object.fromEntries(
					Object.keys(before[0]!).map((key) => [key, row[key]]),
				),
			),
		).toEqual(before);
		expect(
			after.every(
				(row) =>
					row.cost_basis === "legacy_estimate" &&
					row.provider_execution_id === null,
			),
		).toBe(true);
		expect(
			sqlite
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type='trigger' AND name='require_org_id_for_attributed_calls'",
				)
				.get(),
		).toEqual(trigger);
		expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(() =>
			insert.run(
				"invalid",
				"invalid",
				"gateway",
				now,
				"model",
				null,
				"kernel",
				1,
				1,
				2,
				0,
				"ok",
			),
		).toThrow();
		sqlite.exec(
			"UPDATE tedi_call_costs SET estimated_cost_usd=NULL,cost_basis='unknown',cost_reason='missing_rate' WHERE id='held'",
		);
		expect(
			sqlite
				.prepare(
					"SELECT estimated_cost_usd,total_tokens,data_quality FROM tedi_call_costs WHERE id='held'",
				)
				.get(),
		).toEqual({
			estimated_cost_usd: null,
			total_tokens: 77,
			data_quality: "quarantined_no_pricing",
		});
		sqlite.close();
	});
});

it("does not attach a receipt to a reservation for a different model", async () => {
	const { db } = await setup();
	await reserveBillingUsage(db, {
		id: "reservation",
		organizationId: "org",
		source: "kernel",
		provider: "azure-openai",
		model: "other",
		estimatedInputTokens: 10,
		estimatedOutputTokens: 20,
		idempotencyKey: "attempt-key",
		expiresAt: "2026-09-20T07:10:00.000Z",
		now,
	});
	await buildProviderExecutionInsertStatement(
		db,
		receipt({ settlementMode: "managed", billingReservationId: "reservation" }),
	);
	expect(
		await findProviderExecutionAdmission(db, "org", "attempt-key"),
	).toBeNull();
});

it("persists direct TypeSafe admission without invented Cloudflare fields", async () => {
	const { db, sqlite } = await setup();
	const identity = {
		provider: "typesafe" as const,
		requestModel: "jev-1.13.0",
		transportKind: "direct-https" as const,
		apiKind: "typesafe-systemone" as const,
		gatewayAccountId: null,
		gatewayId: null,
		providerOrigin: "https://api.typesafe.ai",
		providerResource: null,
		deployment: null,
	};
	await buildProviderExecutionInsertStatement(
		db,
		receipt({
			...identity,
			deploymentScope: providerDeploymentScope(identity),
		}),
	);
	const row = await findProviderExecutionAdmission(db, "org", "attempt-key");
	expect(row).toMatchObject(identity);
	expect(() =>
		sqlite.exec("UPDATE provider_execution_attempts SET gateway_id='fake'"),
	).toThrow();
	expect(() =>
		sqlite.exec(
			"UPDATE provider_execution_attempts SET provider_origin='https://evil.test'",
		),
	).toThrow();
});

it("preserves populated execution ledger and indexes through Jev migration", () => {
	const sqlite = new DatabaseSync(":memory:");
	const root = new URL("../../drizzle/", import.meta.url);
	const target = "20260923094659_jev_provider_execution";
	for (const entry of readdirSync(root, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() && /^\d/.test(entry.name) && entry.name < target,
		)
		.sort((a, b) => a.name.localeCompare(b.name)))
		sqlite.exec(
			readFileSync(new URL(`${entry.name}/migration.sql`, root), "utf8"),
		);
	sqlite
		.prepare(
			`INSERT INTO provider_execution_attempts(id,organization_id,source,idempotency_key,settlement_mode,provider,request_model,gateway_account_id,gateway_id,transport_kind,api_kind,provider_resource,provider_origin,deployment,deployment_scope,authorized_at,send_before) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			"old",
			"org",
			"kernel",
			"key",
			"external",
			"azure-openai",
			"custom",
			"account",
			"gateway",
			"gateway-https",
			"azure-chat",
			"resource",
			"https://resource.openai.azure.com",
			"custom",
			"old-scope",
			now,
			"2026-09-20T07:10:00.000Z",
		);
	const before = sqlite
		.prepare("SELECT * FROM provider_execution_attempts")
		.all();
	sqlite.exec("PRAGMA foreign_keys=ON; BEGIN");
	sqlite.exec(readFileSync(new URL(`${target}/migration.sql`, root), "utf8"));
	sqlite.exec("COMMIT");
	expect(
		sqlite.prepare("SELECT * FROM provider_execution_attempts").all(),
	).toEqual(before);
	expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	expect(
		sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='provider_execution_attempts'",
			)
			.all()
			.map((row) => row.name),
	).toEqual(
		expect.arrayContaining([
			"uniq_provider_execution_admission",
			"idx_provider_execution_run",
		]),
	);
	sqlite.close();
});

it("rejects null provider origin in direct TypeSafe ledger rows", async () => {
	const { db, sqlite } = await setup();
	const identity = {
		provider: "typesafe" as const,
		requestModel: "jev-1.13.0",
		transportKind: "direct-https" as const,
		apiKind: "typesafe-systemone" as const,
		gatewayAccountId: null,
		gatewayId: null,
		providerOrigin: "https://api.typesafe.ai",
		providerResource: null,
		deployment: null,
	};
	await buildProviderExecutionInsertStatement(
		db,
		receipt({
			...identity,
			deploymentScope: providerDeploymentScope(identity),
		}),
	);
	expect(() =>
		sqlite.exec("UPDATE provider_execution_attempts SET provider_origin=NULL"),
	).toThrow();
});

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
const originalWindow = () => ({
	authorizedAt: new Date().toISOString(),
	sendBefore: new Date(Date.now() + 60000).toISOString(),
});
it.each(["external", "disabled"] as const)(
	"persists guarded %s origin and original window; changed custody cannot retry",
	async (mode) => {
		const f = await setup();
		const prepared = await prepareProviderExecutionAdmission(
			f.db,
			receipt({ ...originalWindow(), tediId: "tedi", settlementMode: mode }),
			zeroOrigin(),
		);
		await buildProviderExecutionInsertStatement(
			f.db,
			prepared.execution,
			prepared.guard,
		);
		const stored = await findProviderExecutionAdmission(
			f.db,
			"org",
			"attempt-key",
			prepared.guard,
		);
		expect(stored?.origin).toEqual(zeroOrigin());
		expect(stored?.originHash).toHaveLength(64);
		expect(stored?.policy).toBeNull();
		expect(() =>
			assertProviderExecutionMatches(stored!, {
				...prepared.execution,
				sendBefore: new Date(Date.now() + 90000).toISOString(),
			}),
		).toThrow(/window/);
		f.sqlite.exec("UPDATE tedis SET isolate_agent_id='changed'");
		expect(
			await findProviderExecutionAdmission(
				f.db,
				"org",
				"attempt-key",
				prepared.guard,
			),
		).toBeNull();
		expect(
			f.sqlite
				.prepare("SELECT count(*) n FROM provider_execution_attempts")
				.get(),
		).toEqual({ n: 1 });
	},
);
it("refuses provenance writes without private preparation and pins cloned evidence", async () => {
	const f = await setup();
	const p = await prepareProviderExecutionAdmission(
		f.db,
		receipt({ ...originalWindow(), tediId: "tedi" }),
		zeroOrigin(),
	);
	expect(() =>
		buildProviderExecutionInsertStatement(f.db, p.execution),
	).toThrow(/guard/);
	expect(() =>
		buildProviderExecutionInsertStatement(f.db, p.execution, {
			kind: "provider_execution_admission",
		}),
	).toThrow(/guard/);
	p.execution.origin!.root.objectName = "changed";
	expect(() =>
		buildProviderExecutionInsertStatement(f.db, p.execution, p.guard),
	).toThrow(/changed/);
});
it("fails a second managed guard inside the batch and rolls back its first reservation", async () => {
	const f = await setup();
	// Move the actual billing period to the live window; ordinary funds remain the normal owning predicate.
	f.sqlite
		.prepare("UPDATE billing_accounts SET period_start=?,period_end=?")
		.run(
			new Date(Date.now() - 86400000).toISOString(),
			new Date(Date.now() + 86400000).toISOString(),
		);
	const p = await prepareProviderExecutionAdmission(
		f.db,
		receipt({
			...originalWindow(),
			tediId: "tedi",
			settlementMode: "managed",
			billingReservationId: "reservation",
		}),
		zeroOrigin(),
	);
	f.sqlite.exec(
		"CREATE TRIGGER hold_between_statements AFTER INSERT ON billing_usage_reservations BEGIN UPDATE tedis SET isolate_agent_id='held'; END;",
	);
	await expect(
		reserveBillingUsage(f.db, {
			id: "reservation",
			organizationId: "org",
			tediId: "tedi",
			source: "kernel",
			provider: "azure-openai",
			model: "custom",
			estimatedInputTokens: 10,
			estimatedOutputTokens: 20,
			idempotencyKey: "attempt-key",
			expiresAt: p.execution.sendBefore,
			now: p.execution.authorizedAt,
			execution: p.execution,
			executionGuard: p.guard,
		}),
	).rejects.toThrow();
	expect(
		f.sqlite.prepare("SELECT count(*) n FROM billing_usage_reservations").get(),
	).toEqual({ n: 0 });
	expect(
		f.sqlite
			.prepare("SELECT count(*) n FROM provider_execution_attempts")
			.get(),
	).toEqual({ n: 0 });
	expect(
		f.sqlite.prepare("SELECT isolate_agent_id name FROM tedis").get(),
	).toEqual({ name: "root" });
});
it.each(["reserved", "settled"] as const)(
	"guarded %s reservation retries require the original execution and reservation link",
	async (status) => {
		const f = await setup();
		f.sqlite
			.prepare("UPDATE billing_accounts SET period_start=?,period_end=?")
			.run(
				new Date(Date.now() - 86400000).toISOString(),
				new Date(Date.now() + 86400000).toISOString(),
			);
		const p = await prepareProviderExecutionAdmission(
			f.db,
			receipt({
				...originalWindow(),
				tediId: "tedi",
				settlementMode: "managed",
				billingReservationId: "reservation",
			}),
			zeroOrigin(),
		);
		const input = {
			id: "reservation",
			organizationId: "org",
			tediId: "tedi",
			source: "kernel" as const,
			provider: "azure-openai",
			model: "custom",
			estimatedInputTokens: 10,
			estimatedOutputTokens: 20,
			idempotencyKey: "attempt-key",
			expiresAt: p.execution.sendBefore,
			now: p.execution.authorizedAt,
			execution: p.execution,
			executionGuard: p.guard,
		};
		expect((await reserveBillingUsage(f.db, input)).allowed).toBe(true);
		f.sqlite
			.prepare("UPDATE billing_usage_reservations SET status=?")
			.run(status);
		expect((await reserveBillingUsage(f.db, input)).allowed).toBe(true);
		f.sqlite.exec(
			"UPDATE provider_execution_attempts SET billing_reservation_id='wrong'",
		);
		const result = await reserveBillingUsage(f.db, input).catch(() => null);
		expect(result?.allowed ?? false).toBe(false);
		expect(
			f.sqlite
				.prepare("SELECT count(*) n FROM billing_usage_reservations")
				.get(),
		).toEqual({ n: 1 });
	},
);

it.each([
	"run_id",
	"work_item_id",
	"trace_id",
	"policy_hash",
	"policy",
] as const)(
	"keeps nullable %s identity exact on guarded receipt replay",
	async (column) => {
		const f = await setup();
		const p = await prepareProviderExecutionAdmission(
			f.db,
			receipt({ ...originalWindow(), tediId: "tedi" }),
			zeroOrigin(),
		);
		await buildProviderExecutionInsertStatement(f.db, p.execution, p.guard);
		expect(
			await findProviderExecutionAdmission(f.db, "org", "attempt-key", p.guard),
		).not.toBeNull();
		f.sqlite
			.prepare(`UPDATE provider_execution_attempts SET ${column}=?`)
			.run("");
		expect(
			await findProviderExecutionAdmission(f.db, "org", "attempt-key", p.guard),
		).toBeNull();
		f.sqlite
			.prepare(`UPDATE provider_execution_attempts SET ${column}=NULL`)
			.run();
		expect(
			await findProviderExecutionAdmission(f.db, "org", "attempt-key", p.guard),
		).not.toBeNull();
		expect(
			f.sqlite
				.prepare("SELECT count(*) n FROM provider_execution_attempts")
				.get(),
		).toEqual({ n: 1 });
	},
);
it("does not renew the original retry window or admit a corrupt finite ledger", async () => {
	const f = await setup();
	const p = await prepareProviderExecutionAdmission(
		f.db,
		receipt({ ...originalWindow(), tediId: "tedi" }),
		zeroOrigin(),
	);
	await buildProviderExecutionInsertStatement(f.db, p.execution, p.guard);
	const before = f.sqlite
		.prepare("SELECT * FROM provider_execution_attempts")
		.get();
	expect(
		await findProviderExecutionAdmission(f.db, "org", "attempt-key", p.guard),
	).not.toBeNull();
	expect(
		f.sqlite.prepare("SELECT * FROM provider_execution_attempts").get(),
	).toEqual(before);
	f.sqlite.exec(
		"INSERT INTO billing_historical_decisions(id,organization_id,tedi_id,revision,kind,operation_id,request_hash,payload,recorded_by,recorded_user_id,recorded_at) VALUES ('corrupt','org','tedi',1,'decision','corrupt','hash','{','human','user','2026-01-01')",
	);
	expect(
		await findProviderExecutionAdmission(f.db, "org", "attempt-key", p.guard),
	).toBeNull();
	expect(
		f.sqlite.prepare("SELECT * FROM provider_execution_attempts").get(),
	).toEqual(before);
});

async function depthAdmission(branch: "gen0" | "root" | "leaf") {
	const org = "00000000-0000-4000-8000-000000000001",
		tedi = "00000000-0000-4000-8000-000000000002",
		user = "00000000-0000-4000-8000-000000000003";
	const at = new Date().toISOString();
	const exposures = [];
	const operations = [];
	for (let i = 0; i < (branch === "leaf" ? 4 : 1); i++) {
		const objectId = i
			? (i + 10).toString(16).padStart(64, "0")
			: "c".repeat(64);
		const operationId = `depth-exposure-${i}`;
		const path = i
			? [
					{
						className: "ConversationFacet",
						name: `old-leaf-${i}`,
						objectId,
						identityName: `old-leaf-${i}`,
						identityVersion: "path-v2",
						registryHash: "a".repeat(64),
						parentGeneration: 1,
					},
				]
			: [];
		const inspection = HistoricalExposureInputSchema.parse({
			tediId: tedi,
			operationId,
			rootObjectId: "c".repeat(64),
			objectId,
			targetPath: path,
			expectedGeneration: 1,
			snapshotId: "d".repeat(64),
			sourceHash: "e".repeat(64),
		});
		const exposure = HistoricalExposureSchema.parse({
			id: crypto.randomUUID(),
			organizationId: org,
			tediId: tedi,
			rootObjectName: "old-root",
			rootObjectId: inspection.rootObjectId,
			targetPath: path,
			objectName: i ? `old-leaf-${i}` : "old-root",
			objectId,
			className: i ? "ConversationFacet" : "AgentTediDO",
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
			observedAt: at,
			requestHash: await historicalRequestHash([
				org,
				"human",
				user,
				inspection,
			]),
		});
		exposures.push(exposure);
		operations.push({ id: exposure.id, operationId });
	}
	const input = {
		kind: "authorize_fresh_execution",
		tediId: tedi,
		operationId: "depth-permit",
		expectedRevision: 0,
		exposureSetHash: await historicalRequestHash(
			exposures.map((e) => [e.id, e.requestHash]),
		),
		freshRootName: "depth-root",
		freshRootId: "a".repeat(64),
		preparedGeneration: 1,
		executionGeneration: 2,
		leafScopes:
			branch === "leaf"
				? [{ className: "ConversationFacet", generations: [2] }]
				: [],
		funding: {
			accountId: org,
			entitlementVersion: 1,
			settlementMode: "managed",
			billingMode: "internal",
			status: "active",
			planVersionId: "00000000-0000-4000-8000-000000000004",
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
		recordedAt: at,
		requestHash: await historicalRequestHash([org, "human", user, input]),
		input,
		authority: "finite_execution_permit",
		preparation: {
			state: "held",
			generation: 1,
			inspectionHash: "f".repeat(64),
			receiver: "raw-cutover-v1",
		},
		exposures,
		exposureOperations: operations,
	});
	const owner = { orgId: org, tediId: tedi, objectId: "a".repeat(64) };
	const accepted = {
		owner,
		runId: "run",
		sessionKey: "session",
		principalId: "human",
		inputHash: "e".repeat(64),
		requestHash: "f".repeat(64),
		generation: 2,
	};
	const leafOwner = { ...owner, objectId: "b".repeat(64) };
	const origin =
		branch === "gen0"
			? {
					...zeroOrigin(),
					root: { ...zeroOrigin().root, owner, objectName: "depth-root" },
					selected: {
						...zeroOrigin().selected,
						owner,
						identityName: "depth-root",
					},
				}
			: {
					kind: "accepted_native",
					root: {
						owner,
						objectName: "depth-root",
						className: "AgentTediDO",
						path: [],
						generation: 2,
						accepted,
					},
					selected:
						branch === "leaf"
							? {
									owner: leafOwner,
									className: "ConversationFacet",
									identityName: "depth-leaf",
									facetName: "chat",
									path: [{ className: "ConversationFacet", name: "chat" }],
									generation: 2,
									accepted: {
										...accepted,
										owner: leafOwner,
										runId: "leaf-run",
									},
								}
							: {
									owner,
									className: "AgentTediDO",
									identityName: "depth-root",
									facetName: null,
									path: [],
									generation: 2,
									accepted,
								},
					operation:
						branch === "leaf"
							? {
									parentRunId: "run",
									operationId: "leaf-run",
									sessionKey: "session",
									parentGeneration: 2,
								}
							: null,
					configurationHash: null,
				};
	const rows =
		branch === "gen0"
			? []
			: exposures.map((e, i) => ({
					id: e.id,
					operationId: operations[i]!.operationId,
					requestHash: e.requestHash,
					payload: e,
				}));
	const preparationDb = {
		select: () => ({
			from: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }),
		}),
	};
	return prepareProviderExecutionAdmission(
		preparationDb as never,
		receipt({
			organizationId: org,
			tediId: tedi,
			runId: branch === "gen0" ? null : "run",
			settlementMode: "managed",
			billingReservationId: "reservation",
			authorizedAt: at,
			sendBefore: new Date(Date.parse(at) + 20000).toISOString(),
		}),
		origin as never,
		branch === "gen0" ? null : grant,
	);
}

it.each(["gen0", "root", "leaf"] as const)(
	"prepares every actual %s admission statement under D1's depth-100 limit",
	async (branch) => {
		const fixture = await setup();
		const p = await depthAdmission(branch);
		const queries: Array<{ sql: string; params: unknown[] }> = [];
		const stop = new Error("captured both statements without executing them");
		const client = createDbClient({
			prepare(query: string) {
				const statement = {
					bind(...params: unknown[]) {
						queries.push({ sql: query, params });
						return statement;
					},
					raw: async () => [],
				};
				return statement;
			},
			batch: async () => {
				throw stop;
			},
		} as unknown as D1Database);
		await findProviderExecutionAdmission(
			client,
			p.execution.organizationId,
			p.execution.idempotencyKey,
			p.guard,
		);
		await expect(
			reserveBillingUsage(client, {
				id: "reservation",
				organizationId: p.execution.organizationId,
				tediId: p.execution.tediId!,
				source: "kernel",
				provider: p.execution.provider,
				model: p.execution.requestModel,
				estimatedInputTokens: 10,
				estimatedOutputTokens: 20,
				runId: p.execution.runId ?? undefined,
				idempotencyKey: p.execution.idempotencyKey,
				expiresAt: p.execution.sendBefore,
				now: p.execution.authorizedAt,
				execution: p.execution,
				executionGuard: p.guard,
			}),
		).rejects.toBe(stop);
		expect(queries).toHaveLength(4);
		const schema = fixture.sqlite
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
			)
			.all()
			.map((row) => (row as { sql: string }).sql)
			.join(";\n");
		// Disable Python's statement cache: changing the SQLite limit must force a fresh
		// preparation, otherwise a cached EXPLAIN can conceal the production regression.
		const result = execFileSync(
			"python3",
			[
				"-c",
				`
import json,sqlite3,sys
fixture=json.load(sys.stdin)
db=sqlite3.connect(':memory:',cached_statements=0)
db.executescript(fixture['schema'])
db.execute('CREATE TABLE IF NOT EXISTS organization_members(organization_id TEXT,descope_user_id TEXT,user_id TEXT,status TEXT,role TEXT)')
db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,100)
for query in fixture['queries']:
 db.execute('EXPLAIN '+query['sql'],query['params']).fetchall()
print(len(fixture['queries']))
`,
			],
			{ input: JSON.stringify({ schema, queries }), encoding: "utf8" },
		);
		expect(result.trim()).toBe("4");
		expect(
			fixture.sqlite
				.prepare("SELECT count(*) n FROM provider_execution_attempts")
				.get(),
		).toEqual({ n: 0 });
	},
);
