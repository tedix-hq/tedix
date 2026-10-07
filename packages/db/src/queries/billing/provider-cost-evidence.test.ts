import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getColumns } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { billingProviderCostEvidenceVersions as evidence } from "../../schema/billing";
import { tediCallCosts, tedis } from "../../schema/tedis";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { workItems, workAttempts } from "../../schema/work-items";
import {
	workAdmissions,
	workApprovalProposals,
	workApprovalDecisions,
	workResourceRequirements,
	workResourceReservations,
} from "../../schema/work-factory";
import {
	externalAgentPrincipals,
	externalAgentSessions,
	externalAgentMcpCredentials,
} from "../../schema/external-agent-identity";
import { providerExecutionAttempts } from "../../schema/provider-executions";
import {
	billingUsageReservations,
	billingUsageQuarantines,
	billingUsageCharges,
	billingCreditEntries,
	billingProviderReconciliations,
} from "../../schema/billing";
import { getCallCosts, getDailySpendRate } from "../tedi-usage";
import {
	buildAppendProviderCostEvidenceStatement,
	getProviderCostEvidenceSource,
	executeProviderCostEvidenceBatch,
	getProviderCostEvidenceCurrent,
	providerCostEvidenceIdentityDigest,
	type NewProviderCostEvidenceRow,
} from "./provider-cost-evidence";

function row(
	overrides: Partial<NewProviderCostEvidenceRow> = {},
): NewProviderCostEvidenceRow {
	return {
		id: "00000000-0000-4000-8000-000000000001",
		originalOrgId: "org",
		sourceGatewayId: "gateway",
		gatewayLogId: "log",
		sourceCallId: "call",
		scopeDigest: "a".repeat(64),
		originalSourceDigest: "b".repeat(64),
		occurredAt: "2026-10-07T00:00:00Z",
		recordedAt: "2026-10-07T01:00:00Z",
		provider: "azure-openai",
		nativeModel: "native",
		nativeFactsReceiptDigest: "c".repeat(64),
		basisFactsDigest: "d".repeat(64),
		financialManifestDigest: "e".repeat(64),
		financialWorkId: "financial",
		financialSpecRevision: "spec",
		approvalProposalId: "approval",
		approvalDecisionId: "decision",
		attemptId: "attempt",
		admissionId: "admission",
		createdByActorType: "external_agent",
		createdByActorId: "actor",
		createdBySessionId: "session",
		idempotencyDigest: "f".repeat(64),
		payloadDigest: "1".repeat(64),
		originalTediId: "tedi",
		originalSourceSnapshot: {
			id: "call",
			orgId: "org",
			gatewayId: "gateway",
			gatewayLogId: "log",
			tediId: "tedi",
			snapshotAt: "2026-10-07T00:00:00Z",
			model: "native",
			provider: "azure-openai",
			inputTokens: 100,
			outputTokens: 5,
			totalTokens: 105,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costBasis: "unknown",
			estimatedCostUsd: null,
			dataQuality: "quarantined_no_pricing",
			sessionType: "tedi",
			source: "ai-gateway-log",
			sessionCount: 1,
			success: true,
			cached: false,
		},
		deploymentScope: {},
		financialManifestSnapshot: {},
		approvalDecisionSnapshot: {},
		originalSourceVersion: 1,
		inputTokens: 100,
		outputTokens: 5,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		providerEstimatedCostMicros: 2197,
		financialWorkVersion: 3,
		nativeUsageKnown: true,
		kind: "provider_estimate",
		currency: "USD",
		pricingBasis: "reported_estimate",
		reportedEstimateSnapshot: { original: true },
		reportedCostDecimal: "0.00219662",
		reportedReporter: "cloudflare_ai_gateway",
		...overrides,
	};
}
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		readFileSync(
			new URL(
				"../../../drizzle/20261007112224_provider_cost_evidence/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}
describe("generated immutable evidence constraints", () => {
	it("requires exclusive report/rate facts, known usage and safe inclusive counters", async () => {
		const { db } = fixture();
		await db.insert(evidence).values(row());
		for (const override of [
			{ id: "missing", reportedReporter: null },
			{ id: "mixed", inputPriceMicrosPerMillion: 1 },
			{ id: "unknown", nativeUsageKnown: false },
			{ id: "unsafe", cacheWriteTokens: 101 },
			{
				id: "rate",
				pricingBasis: "rate_estimated" as const,
				reportedReporter: null,
				reportedCostDecimal: null,
				reportedEstimateSnapshot: null,
			},
		])
			await expect(
				db.insert(evidence).values(
					row({
						...override,
						idempotencyDigest: override.id,
						sourceCallId: override.id,
					}),
				),
			).rejects.toThrow();
	});
	it("rejects second roots, branches, cross-identity parents, updates and deletion", async () => {
		const { db, sqlite } = fixture();
		const original = row();
		await db.insert(evidence).values(original);
		await expect(
			db.insert(evidence).values(
				row({
					id: "other",
					idempotencyDigest: "other",
					financialWorkId: "different",
				}),
			),
		).rejects.toThrow();
		const child = row({
			id: "00000000-0000-4000-8000-000000000002",
			idempotencyDigest: "child",
			supersedesEvidenceVersionId: original.id,
		});
		await db.insert(evidence).values(child);
		for (const override of [
			{
				id: "branch",
				idempotencyDigest: "branch",
				supersedesEvidenceVersionId: original.id,
			},
			{
				id: "cross",
				idempotencyDigest: "cross",
				sourceCallId: "different",
				supersedesEvidenceVersionId: child.id,
			},
			{
				id: "missing",
				idempotencyDigest: "missing",
				supersedesEvidenceVersionId: "absent",
			},
		])
			await expect(db.insert(evidence).values(row(override))).rejects.toThrow();
		expect(() =>
			sqlite.exec(
				"UPDATE billing_provider_cost_evidence_versions SET provider_estimated_cost_micros=1",
			),
		).toThrow();
		expect(() =>
			sqlite.exec("DELETE FROM billing_provider_cost_evidence_versions"),
		).toThrow();
		expect((await getProviderCostEvidenceCurrent(db, "org", "call"))?.id).toBe(
			child.id,
		);
		expect(
			await getProviderCostEvidenceCurrent(db, "other", "call"),
		).toBeNull();
	});
	it("retains one exact original source snapshot after source retirement", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(schemaDdl(tediCallCosts));
		await db.insert(evidence).values(row());
		const result = await getCallCosts(db, "tedi");
		expect(result).toHaveLength(1);
		expect(result[0]?.sourceRetired).toBe(true);
		expect(result[0]?.costBasis).toBe("unknown");
		expect(result[0]?.estimatedCostUsd).toBeNull();
		expect(result[0]?.providerCostEvidence?.providerEstimatedCostMicros).toBe(
			2197,
		);

		const spend = await getDailySpendRate(db, null, 365);
		expect(spend.reviewedEstimateRowCount).toBe(1);
		expect(spend.reviewedEstimateTokens).toBe(105);
		expect(spend.reviewedEstimateMicros).toBe(2197);
		expect(spend.sourceRetiredRowCount).toBe(1);
		expect(spend.knownSubtotalUsd).toBeCloseTo(0.002197);
	});
	it("stable identity excludes mutable snapshots and financial approvals", async () => {
		const first = await providerCostEvidenceIdentityDigest(
			"org",
			"gateway",
			"log",
			"call",
		);
		expect(first).toHaveLength(64);
		expect(first).not.toBe(
			await providerCostEvidenceIdentityDigest(
				"other",
				"gateway",
				"log",
				"call",
			),
		);
		await expect(
			providerCostEvidenceIdentityDigest("", "gateway", "log", "call"),
		).rejects.toThrow();
	});
});

/** Seed the actual schema objects; authority mutations exercise the production INSERT. */
async function authorityFixture() {
	const { db, sqlite } = fixture();
	sqlite.exec("PRAGMA foreign_keys=OFF");
	const tables = [
		tediCallCosts,
		workItems,
		workAttempts,
		workAdmissions,
		workApprovalProposals,
		workApprovalDecisions,
		workResourceRequirements,
		workResourceReservations,
		externalAgentPrincipals,
		externalAgentSessions,
		externalAgentMcpCredentials,
		providerExecutionAttempts,
		billingUsageReservations,
		billingUsageQuarantines,
		billingUsageCharges,
		billingCreditEntries,
		billingProviderReconciliations,
	];
	sqlite.exec(schemaDdl(...tables));
	const future = new Date(Date.now() + 3600000).toISOString();
	function seed(table: SQLiteTable, overrides: Record<string, unknown>) {
		const columns = getColumns(table);
		const names: string[] = [],
			values: unknown[] = [];
		for (const [key, c] of Object.entries(columns)) {
			let value = Object.hasOwn(overrides, key)
				? overrides[key]
				: !c.notNull
					? null
					: c.getSQLType() === "integer"
						? 1
						: "fixture";
			if (value !== null && typeof value === "object")
				value = JSON.stringify(value);
			if (typeof value === "boolean") value = value ? 1 : 0;
			names.push(`"${c.name}"`);
			values.push(value);
		}
		sqlite
			.prepare(
				`INSERT INTO "${getTableConfig(table).name}" (${names.join(",")}) VALUES (${values.map(() => "?").join(",")})`,
			)
			.run(...(values as (string | number | null)[]));
	}
	// Unrelated acceptance-shape checks are not this fixture's subject. Re-enable
	// all constraints BEFORE any production statement or immutable evidence write.
	sqlite.exec("PRAGMA ignore_check_constraints=ON");
	seed(tediCallCosts, {
		id: "call",
		orgId: "org",
		tediId: "tedi",
		gatewayId: "gateway",
		gatewayLogId: "log",
		snapshotAt: "2026-10-07T00:00:00Z",
		model: "native",
		provider: "azure-openai",
		inputTokens: 100,
		outputTokens: 5,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 105,
		costBasis: "unknown",
		dataQuality: "quarantined_no_pricing",
		success: true,
		cached: false,
		sessionType: "tedi",
		sessionCount: 1,
		source: "ai-gateway-log",
	});
	seed(workItems, {
		id: "financial",
		orgId: "org",
		version: 3,
		admissionSpecRevision: "spec",
		disposition: "accepted",
		requiredAuthorities: ["financial:billing"],
	});
	seed(workApprovalProposals, {
		id: "approval",
		orgId: "org",
		workItemId: "financial",
		workItemVersion: 3,
		authorityKey: "financial:billing",
		action: "billing.recordProviderCostEvidence",
		proposal: { manifest: "canonical" },
		version: 2,
		status: "approved",
		approverType: "tedi",
		approverId: "approver",
		expiresAt: future,
	});
	seed(workApprovalDecisions, {
		id: "decision",
		proposalId: "approval",
		resolvedProposalVersion: 2,
		decision: "approved",
		deciderType: "tedi",
		deciderId: "approver",
	});
	seed(workAttempts, {
		id: "attempt",
		orgId: "org",
		workItemId: "financial",
		admissionId: "admission",
		runtimeState: "running",
		outcome: null,
		finishedAt: null,
		executorType: "external_agent",
		executorId: "actor",
		executorSessionId: "session",
		externalSessionKey: "session-key",
		expiresAt: future,
	});
	seed(workAdmissions, {
		id: "admission",
		orgId: "org",
		workItemId: "financial",
		workItemVersion: 3,
		admissionSpecRevision: "spec",
		decision: "admitted",
		executorType: "external_agent",
		executorId: "actor",
		executorSessionId: "session",
		externalSessionKey: "session-key",
		expiresAt: future,
	});
	seed(externalAgentPrincipals, {
		id: "actor",
		organizationId: "org",
		status: "active",
	});
	seed(externalAgentSessions, {
		id: "session",
		organizationId: "org",
		principalId: "actor",
		status: "active",
		endedAt: null,
		externalSessionKey: "session-key",
	});
	seed(externalAgentMcpCredentials, {
		id: "credential",
		organizationId: "org",
		principalId: "actor",
		sessionId: "session",
		clientRecordId: "client",
		status: "active",
		revokedAt: null,
		expiresAt: future,
	});
	seed(workResourceRequirements, {
		orgId: "org",
		workItemId: "financial",
		resourceKey: "artifact:fiction",
		quantity: 1,
	});
	seed(workResourceReservations, {
		id: "reserved",
		orgId: "org",
		workItemId: "financial",
		admissionId: "admission",
		resourceKey: "artifact:fiction",
		quantity: 1,
		state: "active",
		expiresAt: future,
	});
	sqlite.exec("PRAGMA ignore_check_constraints=OFF");
	const source = (await getProviderCostEvidenceSource(db, "org", "call"))!;
	const params = {
		row: row({
			originalSourceSnapshot: source,
			financialManifestSnapshot: { expiresAt: future },
		}),
		source,
		rawProposal: JSON.stringify({ manifest: "canonical" }),
		proposalVersion: 2,
		authorityKey: "financial:billing",
		designatedApproverType: "tedi" as const,
		designatedApproverId: "approver",
		clientRecordId: "client",
		externalSessionKey: "session-key",
		requestDeadlineAt: future,
		executionSnapshot: null,
		reservationSnapshot: null,
		quarantineSnapshot: null,
	};
	return { db, sqlite, params, seed };
}
describe("atomic source and authority fences", () => {
	it("inserts only with current same-D1 authority and returns a scoped immutable leaf", async () => {
		const { db, params } = await authorityFixture();
		await buildAppendProviderCostEvidenceStatement(db, params);
		expect(
			(await getProviderCostEvidenceCurrent(db, "org", "call"))
				?.providerEstimatedCostMicros,
		).toBe(2197);
	});
	it.each([
		"UPDATE work_items SET version=4",
		"UPDATE work_items SET admission_spec_revision='changed'",
		"UPDATE work_items SET disposition='cancelled'",
		"UPDATE work_items SET required_authorities='[]'",
		"UPDATE work_approval_proposals SET proposal='{}'",
		"UPDATE work_approval_proposals SET status='rejected'",
		"UPDATE work_approval_proposals SET expires_at='2000-01-01'",
		"UPDATE work_approval_decisions SET resolved_proposal_version=1",
		"UPDATE work_approval_decisions SET decider_id='foreign'",
		"UPDATE work_attempts SET expires_at='2000-01-01'",
		"UPDATE work_attempts SET executor_session_id='foreign'",
		"UPDATE work_attempts SET runtime_state='expired'",
		"UPDATE work_admissions SET admission_spec_revision='changed'",
		"UPDATE work_admissions SET expires_at='2000-01-01'",
		"UPDATE external_agent_principals SET status='suspended'",
		"UPDATE external_agent_sessions SET status='ended'",
		"UPDATE external_agent_mcp_credentials SET status='revoked'",
		"UPDATE external_agent_mcp_credentials SET client_record_id='foreign'",
		"UPDATE work_resource_reservations SET state='released'",
		"UPDATE work_resource_reservations SET quantity=2",
		"UPDATE tedi_call_costs SET input_tokens=101",
		"UPDATE tedi_call_costs SET org_id='foreign'",
		"UPDATE tedi_call_costs SET cost_reason='changed'",
		"UPDATE tedi_call_costs SET provider_execution_id='missing'",
		"UPDATE tedi_call_costs SET billing_reservation_id='missing'",
	])("refuses a mutation between pre-read and INSERT: %s", async (mutation) => {
		const { db, sqlite, params } = await authorityFixture();
		sqlite.exec("PRAGMA ignore_check_constraints=ON");
		sqlite.exec(mutation);
		sqlite.exec("PRAGMA ignore_check_constraints=OFF");
		await buildAppendProviderCostEvidenceStatement(db, params);
		expect(await getProviderCostEvidenceCurrent(db, "org", "call")).toBeNull();
	});
	it("refuses late request deadlines at the SQL boundary", async () => {
		const { db, params } = await authorityFixture();
		params.requestDeadlineAt = "2000-01-01T00:00:00Z";
		await buildAppendProviderCostEvidenceStatement(db, params);
		expect(await getProviderCostEvidenceCurrent(db, "org", "call")).toBeNull();
	});
	it.each(["2000-01-01T00:00:00Z", "invalid", null])(
		"refuses expired or nonfinite frozen manifest expiry at INSERT: %s",
		async (expiresAt) => {
			const { db, params } = await authorityFixture();
			params.row.financialManifestSnapshot = { expiresAt };
			await buildAppendProviderCostEvidenceStatement(db, params);
			expect(
				await getProviderCostEvidenceCurrent(db, "org", "call"),
			).toBeNull();
		},
	);
	it("compares every raw source column, including nullable provenance, inside INSERT", async () => {
		for (const [key, column] of Object.entries(getColumns(tediCallCosts))) {
			const { db, sqlite, params } = await authorityFixture();
			const current = params.source[key as keyof typeof params.source];
			const changed =
				column.getSQLType() === "integer"
					? typeof current === "number"
						? current + 1
						: current === true
							? 0
							: 1
					: typeof current === "number"
						? current + 1
						: `changed-${key}`;
			sqlite
				.prepare(`UPDATE tedi_call_costs SET "${column.name}"=?`)
				.run(changed);
			await buildAppendProviderCostEvidenceStatement(db, params);
			expect(
				await getProviderCostEvidenceCurrent(db, "org", "call"),
				key,
			).toBeNull();
		}
	});
	it.each(["charge", "credit", "reconciliation", "quarantine"])(
		"refuses newly linked financial state without mutating it: %s",
		async (kind) => {
			const { db, sqlite, params, seed } = await authorityFixture();
			sqlite.exec("PRAGMA ignore_check_constraints=ON");
			if (kind === "charge")
				seed(billingUsageCharges, {
					id: "charge",
					organizationId: "org",
					gatewayLogId: "log",
				});
			if (kind === "credit")
				seed(billingCreditEntries, {
					id: "credit",
					organizationId: "org",
					sourceRef: "call",
				});
			if (kind === "reconciliation")
				seed(billingProviderReconciliations, {
					id: "reconciliation",
					provider: "azure-openai",
					providerResource: "",
					periodStart: "2020-01-01",
					periodEnd: "2030-01-01",
					status: "approved",
				});
			if (kind === "quarantine")
				seed(billingUsageQuarantines, {
					id: "quarantine",
					gatewayLogId: "log",
					organizationId: "org",
				});
			sqlite.exec("PRAGMA ignore_check_constraints=OFF");
			const before = sqlite.prepare("SELECT total_changes() AS n").get();
			await buildAppendProviderCostEvidenceStatement(db, params);
			expect(
				await getProviderCostEvidenceCurrent(db, "org", "call"),
			).toBeNull();
			expect(sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(
				before,
			);
		},
	);
});

describe("owning evidence batch", () => {
	it("constructs without persistence and executes a bounded batch", async () => {
		const { db, params } = await authorityFixture();
		const statement = buildAppendProviderCostEvidenceStatement(db, params);
		expect(await getProviderCostEvidenceCurrent(db, "org", "call")).toBeNull();
		await executeProviderCostEvidenceBatch(db, [statement]);
		expect(
			await getProviderCostEvidenceCurrent(db, "org", "call"),
		).not.toBeNull();
		expect(() => executeProviderCostEvidenceBatch(db, [])).toThrow();
		expect(() =>
			executeProviderCostEvidenceBatch(db, Array(21).fill(statement)),
		).toThrow();
	});
});
