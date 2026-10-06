import { providerExecutionAttempts } from "../../schema/provider-executions";
import {
	prepareProviderExecutionAdmission,
	buildProviderExecutionInsertStatement,
	findProviderExecutionAdmission,
} from "../provider-executions";
import { reserveBillingUsage } from "./reservations";
import {
	ProviderExecutionOriginSchema,
	providerDeploymentScope,
} from "@tedix/api-contract/schemas/provider-execution";
import { sql } from "drizzle-orm";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { organizationMembers } from "../../schema/organization-members";
import { tedis } from "../../schema/tedis";
import {
	billingAccounts,
	billingPlanVersions,
	billingHistoricalExposures,
	billingHistoricalDecisions,
	billingUsageReservations,
	billingUsagePeriods,
	billingUsageCharges,
	billingCapacityAllocations,
} from "../../schema/billing";
import {
	FiniteExecutionAuthorizationSchema,
	FiniteExecutionRevocationSchema,
	HistoricalExposureSchema,
	HistoricalFreshDecisionSchema,
} from "@tedix/api-contract/schemas/billing";
import {
	recordFiniteExecutionAuthorization,
	recordFiniteExecutionRevocation,
	readFiniteExecutionAuthorizationForHuman,
	finiteExecutionEligibilityPredicate,
	nativeExecutionEligibilityPredicate,
	recordHistoricalExposure,
	recordHistoricalDecision,
	historicalExposureSet,
	historicalRequestHash,
} from "./historical-exposure";
const org = "00000000-0000-4000-8000-000000000001",
	tedi = "00000000-0000-4000-8000-000000000002",
	user = "00000000-0000-4000-8000-000000000003",
	plan = "00000000-0000-4000-8000-000000000004";
const iso = (n: number) => new Date(Date.now() + n).toISOString();
async function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			organizationMembers,
			tedis,
			billingAccounts,
			billingPlanVersions,
			billingHistoricalExposures,
			billingHistoricalDecisions,
		),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(organizationMembers).values({
		id: "member",
		organizationId: org,
		userId: user,
		descopeUserId: "human",
		email: "human@example.test",
		role: "owner",
		status: "active",
	});
	await db.insert(tedis).values({
		id: tedi,
		organizationId: org,
		slug: "test",
		name: "Test",
		isolateAgentId: "canonical",
	});
	const start = iso(-86400000),
		end = iso(86400000);
	await db.insert(billingPlanVersions).values({
		id: plan,
		planKey: "starter",
		version: 1,
		status: "active",
		name: "Starter",
		includedMonthlyTokens: 1,
		maxTedis: 1,
		maxCronJobsPerTedi: 1,
		maxIterationsPerTask: 1,
		defaultDailyTokenLimit: 1,
		defaultDailyMessageLimit: 1,
		effectiveAt: start,
	});
	await db.insert(billingAccounts).values({
		organizationId: org,
		planVersionId: plan,
		status: "active",
		billingMode: "internal",
		periodStart: start,
		periodEnd: end,
	});
	const funding = {
		accountId: org,
		entitlementVersion: 1,
		settlementMode: "managed" as const,
		billingMode: "internal" as const,
		status: "active" as const,
		planVersionId: plan,
		planVersion: 1,
		periodStart: start,
		periodEnd: end,
		stripeEnvironment: null,
	};
	const exposure = async (op = "exposure", gen = 1) =>
		HistoricalExposureSchema.parse({
			id: crypto.randomUUID(),
			organizationId: org,
			tediId: tedi,
			rootObjectName: "canonical",
			rootObjectId: "a".repeat(64),
			targetPath: [],
			objectName: "canonical",
			objectId: "a".repeat(64),
			className: "AgentTediDO",
			generation: gen,
			snapshotId: String(gen).repeat(64),
			sourceHash: "b".repeat(64),
			manifestHash: null,
			originalRunId: null,
			originalWorkId: null,
			originalPeriod: null,
			usage: null,
			costMicros: null,
			effects: "UNKNOWN",
			exposure: "UNKNOWN",
			workflowCount: 2,
			fiberCount: 3,
			identityCount: 4,
			observedBy: "human",
			observedUserId: user,
			observedAt: iso(0),
			requestHash: await historicalRequestHash(op),
		});
	const first = await exposure();
	await recordHistoricalExposure(db, {
		operationId: "exposure",
		payload: first,
	});
	const decision = async (op = "decision", rev = 0) => {
		const set = await historicalExposureSet(db, org, tedi);
		const input = {
			tediId: tedi,
			operationId: op,
			objectId: "a".repeat(64),
			expectedRevision: rev,
			exposureSetHash: set.hash,
			permittedGeneration: 3,
			permittedClasses: ["AgentTediDO"],
			funding,
			expiresAt: iso(3600000),
			acknowledgeUnboundedUnknownExposure: true,
		};
		const p = HistoricalFreshDecisionSchema.parse({
			id: crypto.randomUUID(),
			organizationId: org,
			tediId: tedi,
			revision: rev + 1,
			kind: "decision",
			decisionId: null,
			recordedBy: "human",
			recordedUserId: user,
			recordedAt: iso(0),
			requestHash: await historicalRequestHash(input),
			input,
			authority: "records_only",
		});
		return { p, set };
	};
	return { sqlite, db, first, exposure, decision, funding };
}
describe("append-only UNKNOWN historical exposure and human records", () => {
	it("retains null UNKNOWN across midnight/funding expiry and never mutates funding", async () => {
		const f = await setup();
		const before = f.sqlite.prepare("SELECT * FROM billing_accounts").all();
		f.sqlite.prepare("UPDATE billing_accounts SET period_end=?").run(iso(-1));
		const rows = await historicalExposureSet(f.db, org, tedi);
		expect(rows.rows[0]!.payload.exposure).toBe("UNKNOWN");
		expect(rows.rows[0]!.payload.costMicros).toBeNull();
		expect(rows.rows[0]!.payload.originalPeriod).toBeNull();
		expect(
			f.sqlite
				.prepare("SELECT COUNT(*) AS n FROM billing_historical_decisions")
				.get()!.n,
		).toBe(0);
		expect(before[0]!.credit_balance_micros).toBe(0);
	});
	it("fences immutable exposure retries and changed canonical membership/custody at INSERT", async () => {
		const f = await setup();
		expect(
			(await recordHistoricalExposure(f.db, {
				operationId: "exposure",
				payload: { ...f.first, id: crypto.randomUUID() },
			}))!.id,
		).toBe(f.first.id);
		expect(
			await recordHistoricalExposure(f.db, {
				operationId: "exposure",
				payload: { ...f.first, requestHash: "c".repeat(64) },
			}),
		).toBeNull();
		for (const mutation of [
			"UPDATE organization_members SET role='viewer'",
			"UPDATE organization_members SET user_id='foreign'",
			"UPDATE tedis SET isolate_agent_id='renamed'",
		]) {
			const g = await setup();
			g.sqlite.exec(mutation);
			expect(
				await recordHistoricalExposure(g.db, {
					operationId: "new",
					payload: await g.exposure("new", 2),
				}),
			).toBeNull();
		}
	});
	it("atomically pins complete recorded set, revision, physical name and funding", async () => {
		for (const mutation of [
			"exposure",
			"revision",
			"name",
			"period",
			"version",
			"member",
		]) {
			const f = await setup(),
				{ p, set } = await f.decision();
			if (mutation === "exposure")
				await recordHistoricalExposure(f.db, {
					operationId: "second",
					payload: await f.exposure("second", 2),
				});
			if (mutation === "revision") {
				const other = await f.decision("other");
				expect(
					await recordHistoricalDecision(f.db, other.p, "canonical", other.set),
				).not.toBeNull();
			}
			if (mutation === "name")
				f.sqlite.exec("UPDATE tedis SET isolate_agent_id='renamed'");
			if (mutation === "period")
				f.sqlite
					.prepare("UPDATE billing_accounts SET period_end=?")
					.run(iso(-1));
			if (mutation === "version")
				f.sqlite.exec("UPDATE billing_accounts SET entitlement_version=2");
			if (mutation === "member")
				f.sqlite.exec("UPDATE organization_members SET status='deactivated'");
			expect(
				await recordHistoricalDecision(
					f.db,
					p,
					mutation === "name" ? "renamed" : "canonical",
					set,
				),
			).toBeNull();
		}
	});
	it("serializes racing revisions and exact retries cannot renew expired/revoked records", async () => {
		const f = await setup(),
			a = await f.decision("a"),
			b = await f.decision("b");
		const results = await Promise.all([
			recordHistoricalDecision(f.db, a.p, "canonical", a.set),
			recordHistoricalDecision(f.db, b.p, "canonical", b.set),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		const original = results.find(Boolean)!;
		const i = {
			tediId: tedi,
			operationId: "revoke",
			expectedRevision: 1,
			decisionId: original.id,
		};
		const rev = HistoricalFreshDecisionSchema.parse({
			id: crypto.randomUUID(),
			organizationId: org,
			tediId: tedi,
			revision: 2,
			kind: "revocation",
			decisionId: original.id,
			recordedBy: "human",
			recordedUserId: user,
			recordedAt: iso(0),
			requestHash: await historicalRequestHash(i),
			input: i,
			authority: "records_only",
		});
		expect(
			await recordHistoricalDecision(f.db, rev, "canonical", a.set),
		).not.toBeNull();
		f.sqlite.prepare("UPDATE billing_accounts SET period_end=?").run(iso(-1));
		expect(
			(await recordHistoricalDecision(
				f.db,
				original.payload,
				"canonical",
				a.set,
			))!.payload,
		).toEqual(original.payload);
		expect(
			await recordHistoricalDecision(
				f.db,
				{ ...original.payload, requestHash: "f".repeat(64) },
				"canonical",
				a.set,
			),
		).toBeNull();
		expect(
			f.sqlite
				.prepare("SELECT COUNT(*) AS n FROM billing_historical_decisions")
				.get()!.n,
		).toBe(2);
	});
	it("refuses new expired decisions using database time even with an old app timestamp", async () => {
		const f = await setup(),
			{ p, set } = await f.decision();
		if (!("expiresAt" in p.input)) throw Error();
		p.recordedAt = iso(-2000);
		p.input.expiresAt = iso(-1000);
		expect(
			await recordHistoricalDecision(f.db, p, "canonical", set),
		).toBeNull();
	});
	it("uses canonical root SQL custody while retaining a distinct selected leaf and independent epoch", async () => {
		const f = await setup();
		const hop = {
			className: "Researcher",
			name: "original",
			identityVersion: "path-v2" as const,
			identityName: "original-identity",
			objectId: "d".repeat(64),
			registryHash: "e".repeat(64),
			parentGeneration: 1,
		};
		const leaf = HistoricalExposureSchema.parse({
			...(await f.exposure("leaf")),
			objectId: hop.objectId,
			objectName: hop.identityName,
			className: hop.className,
			targetPath: [hop],
			generation: 100,
			snapshotId: "f".repeat(64),
		});
		const row = await recordHistoricalExposure(f.db, {
			operationId: "leaf",
			payload: leaf,
		});
		expect(row).toMatchObject({
			objectName: "canonical",
			objectId: hop.objectId,
			payload: leaf,
		});
		const { p, set } = await f.decision();
		expect(
			await recordHistoricalDecision(f.db, p, "canonical", set),
		).not.toBeNull();
		expect(set.rows).toHaveLength(2);
		f.sqlite.exec(
			"DELETE FROM billing_historical_decisions; DELETE FROM billing_historical_exposures WHERE object_id='" +
				"a".repeat(64) +
				"'",
		);
		const onlyLeaf = await f.decision("only-leaf");
		expect(
			await recordHistoricalDecision(
				f.db,
				onlyLeaf.p,
				"canonical",
				onlyLeaf.set,
			),
		).toBeNull();
	});
	it("requires the permitted root generation to exceed every audited root epoch", async () => {
		const f = await setup(),
			{ p, set } = await f.decision();
		if (!("permittedGeneration" in p.input)) throw Error();
		p.input.permittedGeneration = f.first.generation;
		expect(
			await recordHistoricalDecision(f.db, p, "canonical", set),
		).toBeNull();
		expect(
			f.sqlite
				.prepare("SELECT count(*) AS n FROM billing_historical_decisions")
				.get()!.n,
		).toBe(0);
	});
	it("fences changed selected proof and payload even when row count/id/request hash remain unchanged", async () => {
		for (const column of [
			"payload",
			"object_id",
			"generation",
			"snapshot_id",
			"source_hash",
		]) {
			const f = await setup(),
				{ p, set } = await f.decision();
			if (column === "payload")
				f.sqlite
					.prepare("UPDATE billing_historical_exposures SET payload=?")
					.run(JSON.stringify({ ...f.first, rootObjectName: "forged" }));
			else
				f.sqlite
					.prepare(`UPDATE billing_historical_exposures SET ${column}=?`)
					.run(column === "generation" ? 2 : "f".repeat(64));
			expect(
				await recordHistoricalDecision(f.db, p, "canonical", set),
			).toBeNull();
			expect(
				f.sqlite
					.prepare("SELECT count(*) AS n FROM billing_historical_decisions")
					.get()!.n,
			).toBe(0);
		}
	});
	it("exposure retry cannot change physical root proof or selected identity with a reused hash", async () => {
		const f = await setup();
		const root = "f".repeat(64);
		expect(
			await recordHistoricalExposure(f.db, {
				operationId: "exposure",
				payload: { ...f.first, rootObjectId: root, objectId: root },
			}),
		).toBeNull();
		f.sqlite.exec("UPDATE organization_members SET status='deactivated'");
		expect(
			await recordHistoricalExposure(f.db, {
				operationId: "exposure",
				payload: f.first,
			}),
		).toBeNull();
	});
});

async function finiteFixture() {
	const f = await setup();
	f.sqlite
		.prepare("UPDATE tedis SET isolate_agent_id='fresh' WHERE id=?")
		.run(tedi);
	const set = await historicalExposureSet(f.db, org, tedi);
	const input = {
		kind: "authorize_fresh_execution" as const,
		tediId: tedi,
		operationId: "finite",
		expectedRevision: 0,
		exposureSetHash: set.hash,
		freshRootName: "fresh",
		freshRootId: "d".repeat(64),
		preparedGeneration: 7,
		executionGeneration: 8,
		leafScopes: [
			{ className: "ConversationFacet" as const, generations: [1, 2] },
		],
		funding: f.funding,
		maxSendDurationSeconds: 60,
		expiresAt: iso(3600000),
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
		recordedAt: iso(0),
		requestHash: await historicalRequestHash([org, "human", user, input]),
		input,
		authority: "finite_execution_permit",
		preparation: {
			state: "held",
			generation: 7,
			inspectionHash: "c".repeat(64),
			receiver: "raw-cutover-v1",
		},
		exposures: set.rows.map((r) => r.payload),
		exposureOperations: set.rows.map((r) => ({
			id: r.id,
			operationId: r.operationId,
		})),
	});
	const origin = {
		rootObjectId: grant.input.freshRootId,
		rootObjectName: "fresh",
		rootGeneration: 8,
		objectId: grant.input.freshRootId,
		className: "AgentTediDO",
		generation: 8,
		settlementMode: "managed",
		sendBefore: iso(30000),
	};
	const eligible = async (g = grant, o = origin) => {
		const rows = await f.db.all(
			sql`SELECT CASE WHEN ${await finiteExecutionEligibilityPredicate(g, o)} THEN 1 ELSE 0 END AS allowed`,
		);
		return (rows as { allowed: number }[])[0]!.allowed;
	};
	return { ...f, grant, origin, eligible };
}
describe("explicit finite permission events on real D1 SQLite", () => {
	it("preserves old root UNKNOWN and funds while granting a distinct prepared root without precreating leaves", async () => {
		const f = await finiteFixture();
		const old = f.sqlite
			.prepare("SELECT * FROM billing_historical_exposures")
			.all();
		const funds = f.sqlite.prepare("SELECT * FROM billing_accounts").all();
		const row = await recordFiniteExecutionAuthorization(f.db, f.grant);
		expect(row?.payload).toEqual(f.grant);
		expect(
			f.sqlite.prepare("SELECT * FROM billing_historical_exposures").all(),
		).toEqual(old);
		expect(f.sqlite.prepare("SELECT * FROM billing_accounts").all()).toEqual(
			funds,
		);
		expect(await f.eligible()).toBe(1);
		expect(
			await f.eligible(f.grant, {
				...f.origin,
				objectId: "e".repeat(64),
				className: "ConversationFacet",
				generation: 1,
			}),
		).toBe(1);
		for (const patch of [
			{ rootGeneration: 7 },
			{ rootObjectId: "e".repeat(64) },
			{ className: "Researcher" },
			{ generation: 9 },
			{ settlementMode: "external" },
			{ sendBefore: iso(61000) },
		])
			expect(await f.eligible(f.grant, { ...f.origin, ...patch })).toBe(0);
	});
	for (const mutation of [
		"member",
		"canonical",
		"funding",
		"period",
		"payload",
		"operation",
		"append",
		"selected",
	])
		it(`denies atomic append after ${mutation} changes`, async () => {
			const f = await finiteFixture();
			if (mutation === "member")
				f.sqlite.exec("UPDATE organization_members SET status='invited'");
			if (mutation === "canonical")
				f.sqlite.exec("UPDATE tedis SET isolate_agent_id='another'");
			if (mutation === "funding")
				f.sqlite.exec("UPDATE billing_accounts SET entitlement_version=2");
			if (mutation === "period")
				f.sqlite
					.prepare("UPDATE billing_accounts SET period_end=?")
					.run(iso(-1));
			if (mutation === "payload")
				f.sqlite
					.prepare("UPDATE billing_historical_exposures SET payload=?")
					.run(JSON.stringify({ ...f.first, observedBy: "tampered" }));
			if (mutation === "operation")
				f.sqlite.exec(
					"UPDATE billing_historical_exposures SET operation_id='changed'",
				);
			if (mutation === "selected")
				f.sqlite.exec(
					"UPDATE billing_historical_exposures SET object_id='changed'",
				);
			if (mutation === "append") {
				f.sqlite.exec("UPDATE tedis SET isolate_agent_id='canonical'");
				await recordHistoricalExposure(f.db, {
					operationId: "extra",
					payload: await f.exposure("extra", 2),
				});
				f.sqlite.exec("UPDATE tedis SET isolate_agent_id='fresh'");
			}
			expect(
				await recordFiniteExecutionAuthorization(f.db, f.grant),
			).toBeNull();
			expect(
				f.sqlite
					.prepare("SELECT count(*) AS n FROM billing_historical_decisions")
					.get()!.n,
			).toBe(0);
		});
	it("only one concurrent revision wins and newer grants invalidate old eligibility", async () => {
		const f = await finiteFixture();
		const second = FiniteExecutionAuthorizationSchema.parse({
			...f.grant,
			id: crypto.randomUUID(),
			input: { ...f.grant.input, operationId: "second" },
			requestHash: "f".repeat(64),
		});
		second.requestHash = await historicalRequestHash([
			org,
			"human",
			user,
			second.input,
		]);
		const results = await Promise.all([
			recordFiniteExecutionAuthorization(f.db, f.grant),
			recordFiniteExecutionAuthorization(f.db, second),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		const winning = results.find(Boolean)!.payload;
		expect(winning.authority).toBe("finite_execution_permit");
		const next = FiniteExecutionAuthorizationSchema.parse({
			...f.grant,
			id: crypto.randomUUID(),
			revision: 2,
			input: { ...f.grant.input, operationId: "next", expectedRevision: 1 },
			requestHash: "a".repeat(64),
		});
		next.requestHash = await historicalRequestHash([
			org,
			"human",
			user,
			next.input,
		]);
		expect(await recordFiniteExecutionAuthorization(f.db, next)).not.toBeNull();
		expect(await f.eligible(f.grant)).toBe(0);
		expect(await f.eligible(next)).toBe(1);
	});
	it("revocation denies eligibility and exact retry never reactivates or renews", async () => {
		const f = await finiteFixture();
		await recordFiniteExecutionAuthorization(f.db, f.grant);
		const input = {
			kind: "revoke_fresh_execution" as const,
			tediId: tedi,
			operationId: "revoke-finite",
			authorizationId: f.grant.id,
			expectedRevision: 1,
		};
		const event = FiniteExecutionRevocationSchema.parse({
			id: crypto.randomUUID(),
			organizationId: org,
			tediId: tedi,
			revision: 2,
			kind: "revocation",
			decisionId: f.grant.id,
			input,
			recordedBy: "human",
			recordedUserId: user,
			recordedAt: iso(0),
			requestHash: await historicalRequestHash([org, "human", user, input]),
			authority: "finite_execution_permit",
			freshRootName: "fresh",
			freshRootId: f.grant.input.freshRootId,
		});
		event.requestHash = await historicalRequestHash([
			org,
			"human",
			user,
			event.input,
		]);
		expect(await recordFiniteExecutionRevocation(f.db, event)).not.toBeNull();
		expect(await f.eligible()).toBe(0);
		const retry = await recordFiniteExecutionAuthorization(f.db, {
			...f.grant,
			id: crypto.randomUUID(),
			recordedAt: iso(1000),
		});
		expect(retry?.payload).toEqual(f.grant);
		expect(await f.eligible()).toBe(0);
		expect(
			(
				await recordFiniteExecutionRevocation(f.db, {
					...event,
					id: crypto.randomUUID(),
				})
			)?.payload,
		).toEqual(event);
		expect(
			await recordFiniteExecutionAuthorization(f.db, {
				...f.grant,
				requestHash: "e".repeat(64),
			}),
		).toBeNull();
	});
	it("stored grant tampering and stale membership cannot become eligibility or retry evidence", async () => {
		const f = await finiteFixture();
		await recordFiniteExecutionAuthorization(f.db, f.grant);
		f.sqlite.prepare("UPDATE billing_historical_decisions SET payload=?").run(
			JSON.stringify({
				...f.grant,
				input: { ...f.grant.input, maxSendDurationSeconds: 600 },
			}),
		);
		expect(await f.eligible()).toBe(0);
		expect(
			await readFiniteExecutionAuthorizationForHuman(f.db, f.grant),
		).toBeNull();
	});
	it("records_only revocation cannot revoke a finite permit", async () => {
		const f = await finiteFixture();
		await recordFiniteExecutionAuthorization(f.db, f.grant);
		const input = {
			tediId: tedi,
			operationId: "record-only-revoke",
			expectedRevision: 1,
			decisionId: f.grant.id,
		};
		const event = HistoricalFreshDecisionSchema.parse({
			id: crypto.randomUUID(),
			organizationId: org,
			tediId: tedi,
			revision: 2,
			kind: "revocation",
			decisionId: f.grant.id,
			input,
			recordedBy: "human",
			recordedUserId: user,
			recordedAt: iso(0),
			requestHash: "f".repeat(64),
			authority: "records_only",
		});
		expect(
			await recordHistoricalDecision(
				f.db,
				event,
				"fresh",
				await historicalExposureSet(f.db, org, tedi),
			),
		).toBeNull();
		expect(await f.eligible()).toBe(1);
	});
});

describe("immutable finite ledger scalar and payload agreement", () => {
	for (const [column, value] of [
		["revision", 99],
		["operation_id", "wrong"],
		["decision_id", "wrong"],
		["kind", "revocation"],
		["recorded_by", "wrong"],
		["recorded_user_id", plan],
		["recorded_at", "2020-01-01T00:00:00.000Z"],
	])
		it(`corrupt grant ${column} cannot remain eligible or exact evidence`, async () => {
			const f = await finiteFixture();
			await recordFiniteExecutionAuthorization(f.db, f.grant);
			if (column === "decision_id" || column === "kind")
				f.sqlite.exec("PRAGMA ignore_check_constraints=ON");
			f.sqlite
				.prepare(`UPDATE billing_historical_decisions SET ${column}=?`)
				.run(value);
			expect(await f.eligible()).toBe(0);
			expect(
				await readFiniteExecutionAuthorizationForHuman(f.db, f.grant),
			).toBeNull();
			expect(
				await recordFiniteExecutionAuthorization(f.db, f.grant),
			).toBeNull();
		});
	it("coherently changed input with unchanged request digest fails canonical request validation", async () => {
		const f = await finiteFixture();
		await recordFiniteExecutionAuthorization(f.db, f.grant);
		const corrupted = {
			...f.grant,
			input: { ...f.grant.input, maxSendDurationSeconds: 600 },
		};
		f.sqlite
			.prepare("UPDATE billing_historical_decisions SET payload=?")
			.run(JSON.stringify(corrupted));
		expect(await f.eligible(corrupted)).toBe(0);
		expect(
			await readFiniteExecutionAuthorizationForHuman(f.db, corrupted),
		).toBeNull();
	});
	it("current original human membership is required by eligibility even after successful recording", async () => {
		const f = await finiteFixture();
		await recordFiniteExecutionAuthorization(f.db, f.grant);
		f.sqlite.exec("UPDATE organization_members SET status='invited'");
		expect(await f.eligible()).toBe(0);
		expect(
			await readFiniteExecutionAuthorizationForHuman(f.db, f.grant),
		).toBeNull();
	});
	for (const [column, value] of [
		["revision", 99],
		["operation_id", "wrong"],
		["recorded_by", "wrong"],
		["recorded_user_id", plan],
		["recorded_at", "2020-01-01T00:00:00.000Z"],
	])
		it(`corrupt revocation ${column} cannot return as an exact original event`, async () => {
			const f = await finiteFixture();
			await recordFiniteExecutionAuthorization(f.db, f.grant);
			const input = {
				kind: "revoke_fresh_execution" as const,
				tediId: tedi,
				operationId: "revoke",
				expectedRevision: 1,
				authorizationId: f.grant.id,
			};
			const event = FiniteExecutionRevocationSchema.parse({
				id: crypto.randomUUID(),
				organizationId: org,
				tediId: tedi,
				revision: 2,
				kind: "revocation",
				decisionId: f.grant.id,
				input,
				freshRootName: "fresh",
				freshRootId: f.grant.input.freshRootId,
				recordedBy: "human",
				recordedUserId: user,
				recordedAt: iso(0),
				requestHash: await historicalRequestHash([org, "human", user, input]),
				authority: "finite_execution_permit",
			});
			expect(await recordFiniteExecutionRevocation(f.db, event)).not.toBeNull();
			f.sqlite
				.prepare(
					`UPDATE billing_historical_decisions SET ${column}=? WHERE kind='revocation'`,
				)
				.run(value);
			expect(await recordFiniteExecutionRevocation(f.db, event)).toBeNull();
		});
});

it("expired original permission remains immutable evidence and revocable, never a renewed send window", async () => {
	const f = await finiteFixture();
	const expired = FiniteExecutionAuthorizationSchema.parse({
		...f.grant,
		recordedAt: iso(-20000),
		input: { ...f.grant.input, expiresAt: iso(-10000) },
	});
	expired.requestHash = await historicalRequestHash([
		org,
		"human",
		user,
		expired.input,
	]);
	// Retained event issued in the past; seed its native immutable ledger row rather than fake app time on a new INSERT.
	await f.db.insert(billingHistoricalDecisions).values({
		id: expired.id,
		organizationId: org,
		tediId: tedi,
		revision: 1,
		kind: "decision",
		decisionId: null,
		operationId: expired.input.operationId,
		requestHash: expired.requestHash,
		payload: expired,
		recordedBy: "human",
		recordedUserId: user,
		recordedAt: expired.recordedAt,
	});
	expect(await f.eligible(expired)).toBe(0);
	expect(
		(await readFiniteExecutionAuthorizationForHuman(f.db, expired))?.payload,
	).toEqual(expired);
	expect(
		(
			await recordFiniteExecutionAuthorization(f.db, {
				...expired,
				id: crypto.randomUUID(),
			})
		)?.payload,
	).toEqual(expired);
	const input = {
		kind: "revoke_fresh_execution" as const,
		tediId: tedi,
		operationId: "expired-revoke",
		expectedRevision: 1,
		authorizationId: expired.id,
	};
	const revoke = FiniteExecutionRevocationSchema.parse({
		id: crypto.randomUUID(),
		organizationId: org,
		tediId: tedi,
		revision: 2,
		kind: "revocation",
		decisionId: expired.id,
		input,
		freshRootName: "fresh",
		freshRootId: expired.input.freshRootId,
		recordedBy: "human",
		recordedUserId: user,
		recordedAt: iso(0),
		requestHash: await historicalRequestHash([org, "human", user, input]),
		authority: "finite_execution_permit",
	});
	expect(await recordFiniteExecutionRevocation(f.db, revoke)).not.toBeNull();
	expect(await f.eligible(expired)).toBe(0);
	f.sqlite
		.prepare("UPDATE billing_accounts SET period_start=?,period_end=?")
		.run(iso(0), iso(86400000));
	expect(
		await readFiniteExecutionAuthorizationForHuman(f.db, expired),
	).toBeNull();
	expect(await f.eligible(expired)).toBe(0);
});

it.each([
	["revision", "grant"],
	["authority", "grant"],
	["authority", "revocation"],
	["kind", "revocation"],
	["decision_id", "revocation"],
	["organization_id", "grant"],
	["tedi_id", "grant"],
	["organization_id", "revocation"],
	["tedi_id", "revocation"],
])(
	"finite history %s %s drift cannot revive an old permit or redefine append CAS",
	async (column, source) => {
		const f = await finiteFixture();
		expect(
			await recordFiniteExecutionAuthorization(f.db, f.grant),
		).not.toBeNull();
		const next = FiniteExecutionAuthorizationSchema.parse({
			...f.grant,
			id: crypto.randomUUID(),
			revision: 2,
			input: { ...f.grant.input, operationId: "newer", expectedRevision: 1 },
		});
		next.requestHash = await historicalRequestHash([
			org,
			"human",
			user,
			next.input,
		]);
		const revokeInput = {
			kind: "revoke_fresh_execution" as const,
			tediId: tedi,
			operationId: "revoke-new",
			expectedRevision: 1,
			authorizationId: f.grant.id,
		};
		const revoke = FiniteExecutionRevocationSchema.parse({
			id: crypto.randomUUID(),
			organizationId: org,
			tediId: tedi,
			revision: 2,
			kind: "revocation",
			decisionId: f.grant.id,
			authority: "finite_execution_permit",
			input: revokeInput,
			freshRootName: "fresh",
			freshRootId: f.grant.input.freshRootId,
			recordedBy: "human",
			recordedUserId: user,
			recordedAt: iso(0),
			requestHash: await historicalRequestHash([
				org,
				"human",
				user,
				revokeInput,
			]),
		});
		if (source === "grant") {
			expect(
				await recordFiniteExecutionAuthorization(f.db, next),
			).not.toBeNull();
		} else {
			expect(
				await recordFiniteExecutionRevocation(f.db, revoke),
			).not.toBeNull();
		}
		expect(await f.eligible()).toBe(0);
		// Fault injection bypasses physical CHECKs to test retained damaged projections, not valid new writes.
		f.sqlite.exec("PRAGMA ignore_check_constraints=ON");
		const target = source === "grant" ? next.id : revoke.id;
		const value =
			column === "revision"
				? 0
				: column === "kind"
					? "decision"
					: crypto.randomUUID();
		if (column === "authority") {
			f.sqlite
				.prepare(
					"UPDATE billing_historical_decisions SET payload=json_set(payload,'$.authority','records_only') WHERE id=?",
				)
				.run(target);
		} else {
			f.sqlite
				.prepare(
					`UPDATE billing_historical_decisions SET ${column}=? WHERE id=?`,
				)
				.run(value, target);
		}
		expect(await f.eligible()).toBe(0);
		const revision = column === "revision" ? 1 : 2;
		const append = FiniteExecutionAuthorizationSchema.parse({
			...f.grant,
			id: crypto.randomUUID(),
			revision: revision + 1,
			input: {
				...f.grant.input,
				operationId: "after-corruption",
				expectedRevision: revision,
			},
		});
		append.requestHash = await historicalRequestHash([
			org,
			"human",
			user,
			append.input,
		]);
		expect(await recordFiniteExecutionAuthorization(f.db, append)).toBeNull();
		const retryInput = {
			...revokeInput,
			operationId: "after-corruption-revoke",
			expectedRevision: revision,
		};
		const appendRevoke = FiniteExecutionRevocationSchema.parse({
			...revoke,
			id: crypto.randomUUID(),
			revision: revision + 1,
			input: retryInput,
			requestHash: await historicalRequestHash([
				org,
				"human",
				user,
				retryInput,
			]),
		});
		expect(
			await recordFiniteExecutionRevocation(f.db, appendRevoke),
		).toBeNull();
		expect(await f.db.select().from(billingHistoricalDecisions)).toHaveLength(
			2,
		);
	},
);

async function verifiedNativeFixture(fresh = false) {
	const f = fresh ? await finiteFixture() : await setup();
	const e = f.first;
	e.requestHash = await historicalRequestHash([
		org,
		e.observedBy,
		e.observedUserId,
		{
			tediId: tedi,
			operationId: "exposure",
			rootObjectId: e.rootObjectId,
			objectId: e.objectId,
			targetPath: e.targetPath,
			expectedGeneration: e.generation,
			snapshotId: e.snapshotId,
			sourceHash: e.sourceHash,
		},
	]);
	f.sqlite
		.prepare("UPDATE billing_historical_exposures SET payload=?,request_hash=?")
		.run(JSON.stringify(e), e.requestHash);
	const owner = {
		orgId: org,
		tediId: tedi,
		objectId: fresh ? "d".repeat(64) : "a".repeat(64),
	};
	const root = {
		owner,
		objectName: fresh ? "fresh" : "canonical",
		className: "AgentTediDO",
		path: [],
		generation: fresh ? 8 : 0,
	};
	const selected = {
		owner,
		className: "AgentTediDO",
		identityName: root.objectName,
		facetName: null,
		path: [],
		generation: root.generation,
	};
	const accepted = {
		owner,
		runId: "run",
		sessionKey: "session",
		principalId: "human",
		inputHash: "e".repeat(64),
		requestHash: "f".repeat(64),
		generation: 8,
	};
	const origin = ProviderExecutionOriginSchema.parse(
		fresh
			? {
					kind: "accepted_native",
					root: { ...root, accepted },
					selected: { ...selected, accepted },
					operation: null,
					configurationHash: null,
				}
			: {
					kind: "unselected_native",
					root,
					selected,
					configurationHash: "c".repeat(64),
				},
	);
	const allowed = async () => {
		const predicate = await nativeExecutionEligibilityPredicate(
			f.db,
			origin,
			null,
			{
				authorizedAt: iso(0),
				sendBefore: iso(30000),
				settlementMode: "managed",
			},
		);
		return (
			(await f.db.all(
				sql`SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END allowed`,
			)) as { allowed: number }[]
		)[0]!.allowed;
	};
	return { ...f, origin, allowed };
}
describe("audited sticky native origin selection", () => {
	it("accepts only the fully verified original ROOT and denies a new canonical ROOT", async () => {
		const f = await verifiedNativeFixture();
		expect(await f.allowed()).toBe(1);
		f.sqlite.exec("UPDATE tedis SET isolate_agent_id='replacement'");
		const origin = {
			...f.origin,
			root: { ...f.origin.root, objectName: "replacement" },
			selected: { ...f.origin.selected, identityName: "replacement" },
		};
		const predicate = await nativeExecutionEligibilityPredicate(
			f.db,
			origin,
			null,
			{
				authorizedAt: iso(0),
				sendBefore: iso(30000),
				settlementMode: "managed",
			},
		);
		expect(
			(
				(await f.db.all(
					sql`SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END allowed`,
				)) as { allowed: number }[]
			)[0]!.allowed,
		).toBe(0);
	});
	it.each([
		"request_hash",
		"object_name",
		"observed_by",
		"organization_id",
		"tedi_id",
	])("denies preexisting %s exposure projection drift", async (column) => {
		const f = await verifiedNativeFixture();
		f.sqlite.exec(`UPDATE billing_historical_exposures SET ${column}='drift'`);
		expect(await f.allowed()).toBe(0);
	});
	it("denies exposure projection changes after asynchronous preparation", async () => {
		const f = await verifiedNativeFixture();
		const predicate = await nativeExecutionEligibilityPredicate(
			f.db,
			f.origin,
			null,
			{
				authorizedAt: iso(0),
				sendBefore: iso(30000),
				settlementMode: "managed",
			},
		);
		f.sqlite.exec(
			"UPDATE billing_historical_exposures SET organization_id='hidden'",
		);
		expect(
			(
				(await f.db.all(
					sql`SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END allowed`,
				)) as { allowed: number }[]
			)[0]!.allowed,
		).toBe(0);
	});
	it("does not treat an audited leaf as a ROOT selection fact", async () => {
		const f = await verifiedNativeFixture();
		const e = HistoricalExposureSchema.parse({
			...f.first,
			objectId: "b".repeat(64),
			objectName: "leaf",
			className: "ConversationFacet",
			targetPath: [
				{
					className: "ConversationFacet",
					name: "leaf",
					objectId: "b".repeat(64),
					identityName: "leaf",
					identityVersion: "path-v2",
					registryHash: "a".repeat(64),
					parentGeneration: 1,
				},
			],
		});
		e.requestHash = await historicalRequestHash([
			org,
			e.observedBy,
			e.observedUserId,
			{
				tediId: tedi,
				operationId: "exposure",
				rootObjectId: e.rootObjectId,
				objectId: e.objectId,
				targetPath: e.targetPath,
				expectedGeneration: e.generation,
				snapshotId: e.snapshotId,
				sourceHash: e.sourceHash,
			},
		]);
		f.sqlite
			.prepare(
				"UPDATE billing_historical_exposures SET payload=?,object_id=?,request_hash=?",
			)
			.run(JSON.stringify(e), e.objectId, e.requestHash);
		expect(await f.allowed()).toBe(1);
	});
});
async function finiteProviderFixture(
	mode: "managed" | "external" | "disabled" = "managed",
) {
	const f = await verifiedNativeFixture(true);
	if (!("grant" in f)) throw new Error("Missing test grant");
	f.sqlite.exec(
		schemaDdl(
			providerExecutionAttempts,
			billingUsageReservations,
			billingUsagePeriods,
			billingUsageCharges,
			billingCapacityAllocations,
		),
	);
	f.sqlite.exec(
		"CREATE TABLE organizations(id TEXT PRIMARY KEY,metadata TEXT); INSERT INTO organizations VALUES ('" +
			org +
			"','{}');",
	);
	const set = await historicalExposureSet(f.db, org, tedi);
	const input = {
		...f.grant.input,
		exposureSetHash: set.hash,
		funding: { ...f.grant.input.funding, settlementMode: mode },
	};
	const grant = FiniteExecutionAuthorizationSchema.parse({
		...f.grant,
		input,
		requestHash: await historicalRequestHash([org, "human", user, input]),
		exposures: set.rows.map((r) => r.payload),
	});
	expect(await recordFiniteExecutionAuthorization(f.db, grant)).not.toBeNull();
	const identity = {
		provider: "workers-ai" as const,
		requestModel: "@cf/test",
		gatewayAccountId: "account",
		gatewayId: "gateway",
		transportKind: "workers-ai-binding" as const,
		apiKind: "workers-ai-chat" as const,
		providerResource: null,
		providerOrigin: null,
		deployment: null,
	};
	const prepared = await prepareProviderExecutionAdmission(
		f.db,
		{
			...identity,
			id: "execution",
			organizationId: org,
			tediId: tedi,
			source: "kernel",
			runId: "run",
			idempotencyKey: "finite-provider",
			settlementMode: mode,
			billingReservationId: mode === "managed" ? "reservation" : null,
			authorizedAt: iso(0),
			sendBefore: iso(30000),
			deploymentScope: providerDeploymentScope(identity),
		},
		f.origin,
		grant,
	);
	const inputReservation = {
		id: "reservation",
		organizationId: org,
		tediId: tedi,
		source: "kernel" as const,
		runId: "run",
		provider: "workers-ai",
		model: "@cf/test",
		estimatedInputTokens: 1,
		estimatedOutputTokens: 1,
		idempotencyKey: "finite-provider",
		expiresAt: prepared.execution.sendBefore,
		now: prepared.execution.authorizedAt,
		execution: prepared.execution,
		executionGuard: prepared.guard,
	};
	f.sqlite.exec(
		"UPDATE billing_plan_versions SET included_monthly_tokens=100000",
	);
	const insert = () =>
		mode === "managed"
			? reserveBillingUsage(f.db, inputReservation)
			: buildProviderExecutionInsertStatement(
					f.db,
					prepared.execution,
					prepared.guard,
				);
	return { ...f, grant, prepared, inputReservation, insert };
}
describe("actual finite provider SQL admission and immutable retries", () => {
	it.each(["managed", "external", "disabled"] as const)(
		"admits %s and prevents window or reservation renewal",
		async (mode) => {
			const f = await finiteProviderFixture(mode);
			await f.insert();
			expect(
				await findProviderExecutionAdmission(
					f.db,
					org,
					"finite-provider",
					f.prepared.guard,
				),
			).not.toBeNull();
			const stored = await findProviderExecutionAdmission(
				f.db,
				org,
				"finite-provider",
			);
			expect(stored?.authorizedAt).toBe(f.prepared.execution.authorizedAt);
			expect(stored?.policy?.authorizationId).toBe(f.grant.id);
		},
	);
	it.each(["member", "funding", "custody", "set", "revocation", "expiry"])(
		"denies %s racing after preparation with zero admission writes",
		async (change) => {
			const f = await finiteProviderFixture();
			await changeFiniteProvider(f, change);
			const result = await f.insert().catch(() => null);
			expect(result?.allowed ?? false).toBe(false);
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
		},
	);
});

async function changeFiniteProvider(
	f: Awaited<ReturnType<typeof finiteProviderFixture>>,
	change: string,
) {
	if (change === "member")
		f.sqlite.exec("UPDATE organization_members SET status='inactive'");
	if (change === "funding")
		f.sqlite.exec("UPDATE billing_accounts SET entitlement_version=2");
	if (change === "custody")
		f.sqlite.exec("UPDATE tedis SET isolate_agent_id='changed'");
	if (change === "set")
		f.sqlite.exec(
			"UPDATE billing_historical_exposures SET source_hash='changed'",
		);
	if (change === "expiry")
		f.sqlite.exec(
			"UPDATE billing_accounts SET period_end='2000-01-01T00:00:00Z'",
		);
	if (change === "revocation") {
		const input = {
			kind: "revoke_fresh_execution" as const,
			tediId: tedi,
			operationId: "revoke-provider",
			authorizationId: f.grant.id,
			expectedRevision: 1,
		};
		const p = FiniteExecutionRevocationSchema.parse({
			id: crypto.randomUUID(),
			organizationId: org,
			tediId: tedi,
			revision: 2,
			kind: "revocation",
			decisionId: f.grant.id,
			recordedBy: "human",
			recordedUserId: user,
			recordedAt: iso(0),
			requestHash: await historicalRequestHash([org, "human", user, input]),
			authority: "finite_execution_permit",
			input,
			freshRootId: f.grant.input.freshRootId,
			freshRootName: "fresh",
		});
		p.requestHash = await historicalRequestHash([org, "human", user, p.input]);
		expect(await recordFiniteExecutionRevocation(f.db, p)).not.toBeNull();
	}
}
it.each(["reserved", "settled"] as const)(
	"finite %s retries revalidate all current policy pins without reallocating",
	async (status) => {
		for (const change of [
			"member",
			"funding",
			"custody",
			"set",
			"revocation",
			"expiry",
		]) {
			const f = await finiteProviderFixture();
			expect(
				(await reserveBillingUsage(f.db, f.inputReservation)).allowed,
			).toBe(true);
			f.sqlite
				.prepare("UPDATE billing_usage_reservations SET status=?")
				.run(status);
			expect(
				(await reserveBillingUsage(f.db, f.inputReservation)).allowed,
			).toBe(true);
			const before = f.sqlite
				.prepare("SELECT * FROM billing_usage_reservations")
				.all();
			await changeFiniteProvider(f, change);
			const retry = await reserveBillingUsage(f.db, f.inputReservation).catch(
				() => null,
			);
			expect(retry?.allowed ?? false, change).toBe(false);
			expect(
				await findProviderExecutionAdmission(
					f.db,
					org,
					"finite-provider",
					f.prepared.guard,
				),
				change,
			).toBeNull();
			expect(
				f.sqlite.prepare("SELECT * FROM billing_usage_reservations").all(),
			).toEqual(before);
			expect(
				f.sqlite
					.prepare("SELECT count(*) n FROM provider_execution_attempts")
					.get(),
			).toEqual({ n: 1 });
		}
	},
);
it("guarded retry cannot replace its original provider, origin or deadline", async () => {
	const f = await finiteProviderFixture();
	await reserveBillingUsage(f.db, f.inputReservation);
	for (const column of [
		"provider",
		"request_model",
		"send_before",
		"origin_hash",
		"policy_hash",
		"authorized_at",
		"billing_reservation_id",
	]) {
		f.sqlite.exec("SAVEPOINT mutation");
		f.sqlite
			.prepare(`UPDATE provider_execution_attempts SET ${column}=?`)
			.run("changed");
		expect(
			await findProviderExecutionAdmission(
				f.db,
				org,
				"finite-provider",
				f.prepared.guard,
			),
		).toBeNull();
		f.sqlite.exec("ROLLBACK TO mutation");
		f.sqlite.exec("RELEASE mutation");
	}
});

it.each(["malformed", "forged-hash", "wrong-class"])(
	"unaudited %s exposure cannot authorize even the original root",
	async (change) => {
		const f = await verifiedNativeFixture();
		if (change === "malformed")
			f.sqlite.exec("UPDATE billing_historical_exposures SET payload='{}'");
		else {
			const e = {
				...f.first,
				...(change === "forged-hash"
					? { requestHash: "f".repeat(64) }
					: { className: "ConversationFacet" }),
			};
			f.sqlite
				.prepare(
					"UPDATE billing_historical_exposures SET payload=?,request_hash=?",
				)
				.run(JSON.stringify(e), e.requestHash);
		}
		expect(await f.allowed()).toBe(0);
	},
);
it("SQL policy single binding preserves quoted custody and does not interpolate request text", async () => {
	const f = await verifiedNativeFixture();
	f.sqlite.exec("DELETE FROM billing_historical_exposures");
	const name = "canonical' OR 1=1 --";
	f.sqlite.prepare("UPDATE tedis SET isolate_agent_id=?").run(name);
	const origin = ProviderExecutionOriginSchema.parse({
		...f.origin,
		root: { ...f.origin.root, objectName: name },
		selected: { ...f.origin.selected, identityName: name },
	});
	f.sqlite.exec(schemaDdl(providerExecutionAttempts, billingUsageReservations));
	const identity = {
		provider: "workers-ai" as const,
		requestModel: "@cf/test",
		gatewayAccountId: "account",
		gatewayId: "gateway",
		transportKind: "workers-ai-binding" as const,
		apiKind: "workers-ai-chat" as const,
		providerResource: null,
		providerOrigin: null,
		deployment: null,
	};
	const p = await prepareProviderExecutionAdmission(
		f.db,
		{
			...identity,
			id: "quoted",
			organizationId: org,
			tediId: tedi,
			source: "kernel",
			idempotencyKey: "quoted",
			settlementMode: "external",
			authorizedAt: iso(0),
			sendBefore: iso(30000),
			deploymentScope: providerDeploymentScope(identity),
		},
		origin,
	);
	await buildProviderExecutionInsertStatement(f.db, p.execution, p.guard);
	expect(
		await findProviderExecutionAdmission(f.db, org, "quoted", p.guard),
	).not.toBeNull();
	f.sqlite.prepare("UPDATE tedis SET isolate_agent_id=?").run("other");
	expect(
		await findProviderExecutionAdmission(f.db, org, "quoted", p.guard),
	).toBeNull();
});

it("multiple audited ROOT and leaf exposure facts retain real D1 grant and revocation eligibility", async () => {
	const f = await verifiedNativeFixture(true);
	if (!("grant" in f)) throw new Error("Missing grant");
	for (let i = 0; i < 3; i++) {
		const leaf = i > 0;
		const objectId = String(i + 5).repeat(64);
		const path = leaf
			? [
					{
						className: "ConversationFacet",
						name: "leaf" + i,
						identityVersion: "path-v2",
						identityName: "leaf" + i,
						objectId,
						registryHash: "e".repeat(64),
						parentGeneration: 1,
					},
				]
			: [];
		const e = HistoricalExposureSchema.parse({
			...f.first,
			id: crypto.randomUUID(),
			objectId: leaf ? objectId : f.first.rootObjectId,
			targetPath: path,
			objectName: leaf ? "leaf" + i : "canonical",
			className: leaf ? "ConversationFacet" : "AgentTediDO",
			generation: i + 2,
		});
		const operationId = "extra-" + i;
		e.requestHash = await historicalRequestHash([
			org,
			e.observedBy,
			e.observedUserId,
			{
				tediId: tedi,
				operationId,
				rootObjectId: e.rootObjectId,
				objectId: e.objectId,
				targetPath: e.targetPath,
				expectedGeneration: e.generation,
				snapshotId: e.snapshotId,
				sourceHash: e.sourceHash,
			},
		]);
		await f.db.insert(billingHistoricalExposures).values({
			id: e.id,
			organizationId: org,
			tediId: tedi,
			objectId: e.objectId,
			objectName: e.rootObjectName,
			generation: e.generation,
			snapshotId: e.snapshotId,
			sourceHash: e.sourceHash,
			operationId,
			requestHash: e.requestHash,
			exposure: "UNKNOWN",
			payload: e,
			observedBy: e.observedBy,
			observedUserId: e.observedUserId,
			observedAt: e.observedAt,
		});
	}
	const set = await historicalExposureSet(f.db, org, tedi);
	const input = { ...f.grant.input, exposureSetHash: set.hash };
	const grant = FiniteExecutionAuthorizationSchema.parse({
		...f.grant,
		input,
		requestHash: await historicalRequestHash([org, "human", user, input]),
		exposures: set.rows.map((r) => r.payload),
		exposureOperations: set.rows.map((r) => ({
			id: r.id,
			operationId: r.operationId,
		})),
	});
	expect(await recordFiniteExecutionAuthorization(f.db, grant)).not.toBeNull();
	const p = await nativeExecutionEligibilityPredicate(f.db, f.origin, grant, {
		authorizedAt: iso(0),
		sendBefore: iso(30000),
		settlementMode: "managed",
	});
	expect(
		(
			(await f.db.all(
				sql`SELECT CASE WHEN ${p} THEN 1 ELSE 0 END allowed`,
			)) as { allowed: number }[]
		)[0]!.allowed,
	).toBe(1);
	const revoke = FiniteExecutionRevocationSchema.parse({
		id: crypto.randomUUID(),
		organizationId: org,
		tediId: tedi,
		revision: 2,
		kind: "revocation",
		decisionId: grant.id,
		input: {
			kind: "revoke_fresh_execution",
			tediId: tedi,
			operationId: "multi-revoke",
			authorizationId: grant.id,
			expectedRevision: 1,
		},
		recordedBy: "human",
		recordedUserId: user,
		recordedAt: iso(0),
		requestHash: "a".repeat(64),
		authority: "finite_execution_permit",
		freshRootName: "fresh",
		freshRootId: grant.input.freshRootId,
	});
	revoke.requestHash = await historicalRequestHash([
		org,
		"human",
		user,
		revoke.input,
	]);
	expect(await recordFiniteExecutionRevocation(f.db, revoke)).not.toBeNull();
	expect(
		(
			(await f.db.all(
				sql`SELECT CASE WHEN ${p} THEN 1 ELSE 0 END allowed`,
			)) as { allowed: number }[]
		)[0]!.allowed,
	).toBe(0);
});
