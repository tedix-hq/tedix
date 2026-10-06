import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	AppendOnlyApprovalRecordConflictError,
	ApprovalSimulationScopeError,
	declareApprovalDependency,
	invalidateApprovalDependency,
	hasApprovalProvenanceRequest,
	listApprovalSimulationPage,
	listApprovalExecutionReceiptPage,
	listActiveApprovalDependencies,
	listApprovalDependencyEvents,
	listApprovalExecutionReceipts,
	listApprovalSimulations,
	recordApprovalExecutionReceipt,
	recordApprovalSimulation,
} from "./approval-simulations";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE tedi_approval_requests (
			id TEXT PRIMARY KEY,
			tedi_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			action_type TEXT NOT NULL,
			description TEXT NOT NULL,
			payload TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			resolved_at TEXT,
			resolved_by TEXT,
			resolution TEXT,
			workflow_id TEXT
		);
		CREATE TABLE tedi_approval_simulations (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			approval_request_id TEXT NOT NULL,
			simulator_id TEXT NOT NULL,
			simulator_version TEXT NOT NULL,
			canonical_input_hash TEXT NOT NULL,
			record_hash TEXT NOT NULL,
			baseline_evidence_refs TEXT NOT NULL,
			predicted_result TEXT NOT NULL,
			assumptions TEXT NOT NULL,
			confidence REAL NOT NULL,
			evidence_kind TEXT NOT NULL DEFAULT 'simulation',
			not_proof INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL
		);
		CREATE TABLE tedi_approval_dependency_events (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			dependent_approval_request_id TEXT NOT NULL,
			prerequisite_approval_request_id TEXT NOT NULL,
			simulation_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			dependency_kind TEXT NOT NULL,
			invalidates_event_id TEXT,
			reason TEXT,
			record_hash TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX uniq_approval_dependency_invalidation
			ON tedi_approval_dependency_events (invalidates_event_id);
		CREATE TABLE tedi_approval_execution_receipts (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			approval_request_id TEXT NOT NULL,
			simulation_id TEXT,
			idempotency_key TEXT NOT NULL,
			canonical_input_hash TEXT NOT NULL,
			record_hash TEXT NOT NULL,
			baseline_fence_outcome TEXT NOT NULL,
			outcome TEXT NOT NULL,
			observed_result TEXT,
			observed_error TEXT,
			provider_receipt_refs TEXT NOT NULL,
			executed_at TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX uniq_approval_execution_receipt_idempotency
			ON tedi_approval_execution_receipts
			(organization_id, approval_request_id, idempotency_key);
	`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

function seedApproval(
	sqlite: DatabaseSync,
	input: { id: string; organizationId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO tedi_approval_requests
			(id, tedi_id, org_id, action_type, description, payload, status, created_at, expires_at)
			VALUES (?, ?, ?, 'custom', 'test', '{}', 'pending', '2026-09-03T00:00:00.000Z', '2026-09-04T00:00:00.000Z')`,
		)
		.run(input.id, `tedi-${input.organizationId}`, input.organizationId);
}

function simulationInput(
	overrides: Partial<{
		id: string;
		organizationId: string;
		approvalRequestId: string;
		recordHash: string;
		createdAt: string;
	}> = {},
) {
	return {
		id: overrides.id ?? "simulation-1",
		organizationId: overrides.organizationId ?? "org-1",
		approvalRequestId: overrides.approvalRequestId ?? "approval-parent",
		simulatorId: "preview-config",
		simulatorVersion: "1.0.0",
		canonicalInputHash: "sha256:input",
		recordHash: overrides.recordHash ?? "sha256:simulation-record",
		baselineEvidenceRefs: [{ ref: "config://current", revision: "rev-1" }],
		predictedResult: { timeoutSeconds: 30 },
		assumptions: [{ name: "region", value: "eeur" }],
		confidence: 0.9,
		createdAt: overrides.createdAt ?? "2026-09-03T01:00:00.000Z",
	};
}

describe("bounded approval provenance reads", () => {
	it("paginates timestamp ties without losing records, scopes both ledgers, and makes no writes", async () => {
		const { sqlite, db } = fixture();
		seedApproval(sqlite, { id: "approval-parent", organizationId: "org-1" });
		seedApproval(sqlite, { id: "approval-other", organizationId: "org-1" });
		seedApproval(sqlite, { id: "approval-foreign", organizationId: "org-2" });
		for (const id of ["c", "a", "b"]) {
			await recordApprovalSimulation(db, simulationInput({ id }));
			await recordApprovalExecutionReceipt(db, {
				id,
				organizationId: "org-1",
				approvalRequestId: "approval-parent",
				idempotencyKey: id,
				canonicalInputHash: "sha256:input",
				recordHash: id,
				baselineFenceOutcome: "not_checked",
				outcome: "succeeded",
				observedResult: { id },
				providerReceiptRefs: [],
				executedAt: "2026-10-02T00:00:00Z",
				createdAt: "2026-10-02T00:00:00Z",
			});
		}
		await recordApprovalSimulation(
			db,
			simulationInput({ id: "other", approvalRequestId: "approval-other" }),
		);
		await recordApprovalSimulation(
			db,
			simulationInput({
				id: "foreign",
				approvalRequestId: "approval-foreign",
				organizationId: "org-2",
			}),
		);
		await recordApprovalExecutionReceipt(db, {
			id: "foreign-receipt",
			organizationId: "org-2",
			approvalRequestId: "approval-foreign",
			idempotencyKey: "foreign",
			canonicalInputHash: "sha256:foreign",
			recordHash: "sha256:foreign-receipt",
			baselineFenceOutcome: "not_checked",
			outcome: "failed",
			observedError: { code: "DENIED", message: "foreign error" },
			providerReceiptRefs: [],
			executedAt: "2026-10-02T00:00:00Z",
			createdAt: "2026-10-02T00:00:00Z",
		});
		const before = sqlite.prepare("SELECT total_changes() AS count").get();
		const scope = {
			organizationId: "org-1",
			approvalRequestId: "approval-parent",
		};
		expect(await hasApprovalProvenanceRequest(db, scope)).toBe(true);
		expect(
			await hasApprovalProvenanceRequest(db, {
				...scope,
				approvalRequestId: "approval-foreign",
			}),
		).toBe(false);
		const predictions = await listApprovalSimulationPage(db, scope, {
			limit: 2,
		});
		expect(predictions.records.map((record) => record.id)).toEqual(["a", "b"]);
		const receipts = await listApprovalExecutionReceiptPage(db, scope, {
			limit: 1,
		});
		expect(receipts.records.map((record) => record.id)).toEqual(["a"]);
		const finalPredictions = await listApprovalSimulationPage(db, scope, {
			limit: 2,
			cursor: predictions.nextCursor!,
		});
		expect(finalPredictions.records.map((record) => record.id)).toEqual(["c"]);
		expect(finalPredictions.nextCursor).toBeNull();
		const remainingReceipts = await listApprovalExecutionReceiptPage(
			db,
			scope,
			{ limit: 2, cursor: receipts.nextCursor! },
		);
		expect(remainingReceipts.records.map((record) => record.id)).toEqual([
			"b",
			"c",
		]);
		expect(remainingReceipts.nextCursor).toBeNull();
		for (const read of [
			listApprovalSimulationPage,
			listApprovalExecutionReceiptPage,
		]) {
			expect(
				await read(
					db,
					{ ...scope, approvalRequestId: "approval-foreign" },
					{ limit: 25 },
				),
			).toEqual({ records: [], nextCursor: null });
			await expect(read(db, scope, { limit: 26 })).rejects.toThrow(
				"page limit",
			);
		}
		expect(sqlite.prepare("SELECT total_changes() AS count").get()).toEqual(
			before,
		);
		sqlite.close();
	});
});

describe("append-only approval simulations", () => {
	it("keeps immutable prediction history and fences reads and writes by org/request", async () => {
		const { sqlite, db } = fixture();
		seedApproval(sqlite, { id: "approval-parent", organizationId: "org-1" });
		seedApproval(sqlite, { id: "approval-foreign", organizationId: "org-2" });
		const first = await recordApprovalSimulation(db, simulationInput());
		const second = await recordApprovalSimulation(
			db,
			simulationInput({
				id: "simulation-2",
				recordHash: "sha256:simulation-record-2",
				createdAt: "2026-09-03T02:00:00.000Z",
			}),
		);
		expect(first).toMatchObject({ evidenceKind: "simulation", notProof: true });
		expect(second.id).toBe("simulation-2");
		expect(
			(
				await listApprovalSimulations(db, {
					organizationId: "org-1",
					approvalRequestId: "approval-parent",
				})
			).map((row) => row.id),
		).toEqual(["simulation-1", "simulation-2"]);
		expect(
			await listApprovalSimulations(db, {
				organizationId: "org-2",
				approvalRequestId: "approval-parent",
			}),
		).toEqual([]);
		await expect(
			recordApprovalSimulation(
				db,
				simulationInput({ organizationId: "org-2", id: "cross-org" }),
			),
		).rejects.toBeInstanceOf(ApprovalSimulationScopeError);
	});

	it("contains no update or delete persistence path", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "approval-simulations.ts"),
			"utf8",
		);
		assert.doesNotMatch(source, /\.update\(|\.delete\(/);
	});
});

describe("append-only dependency history", () => {
	it("represents invalidation as a new event while preserving its declaration", async () => {
		const { sqlite, db } = fixture();
		for (const id of ["approval-parent", "approval-child"]) {
			seedApproval(sqlite, { id, organizationId: "org-1" });
		}
		await recordApprovalSimulation(db, simulationInput());
		await recordApprovalSimulation(
			db,
			simulationInput({
				id: "simulation-child",
				approvalRequestId: "approval-child",
				recordHash: "sha256:simulation-child",
			}),
		);
		const declared = await declareApprovalDependency(db, {
			id: "dependency-1",
			organizationId: "org-1",
			dependentApprovalRequestId: "approval-child",
			prerequisiteApprovalRequestId: "approval-parent",
			simulationId: "simulation-1",
			dependencyKind: "hard",
			recordHash: "sha256:dependency",
			createdAt: "2026-09-03T02:00:00.000Z",
		});
		await expect(
			declareApprovalDependency(db, {
				id: "dependency-cycle",
				organizationId: "org-1",
				dependentApprovalRequestId: "approval-parent",
				prerequisiteApprovalRequestId: "approval-child",
				simulationId: "simulation-child",
				dependencyKind: "hard",
				recordHash: "sha256:cycle",
				createdAt: "2026-09-03T02:30:00.000Z",
			}),
		).rejects.toThrow("Approval dependency would create a cycle");
		const invalidated = await invalidateApprovalDependency(db, {
			id: "dependency-invalidation-1",
			organizationId: "org-1",
			dependentApprovalRequestId: "approval-child",
			declarationEventId: declared.id,
			reason: "prerequisite rejected",
			recordHash: "sha256:invalidation",
			createdAt: "2026-09-03T03:00:00.000Z",
		});
		expect(invalidated).toMatchObject({
			eventType: "invalidated",
			invalidatesEventId: "dependency-1",
		});
		const events = await listApprovalDependencyEvents(db, {
			organizationId: "org-1",
			dependentApprovalRequestId: "approval-child",
		});
		expect(events.map((event) => event.eventType)).toEqual([
			"declared",
			"invalidated",
		]);
		expect(events[0]).toMatchObject({
			id: "dependency-1",
			invalidatesEventId: null,
			reason: null,
		});
		expect(
			await listApprovalDependencyEvents(db, {
				organizationId: "org-2",
				dependentApprovalRequestId: "approval-child",
			}),
		).toEqual([]);
	});

	it("projects only active edges in the requested direction", async () => {
		const { sqlite, db } = fixture();
		for (const id of ["approval-parent", "approval-child", "approval-other"]) {
			seedApproval(sqlite, { id, organizationId: "org-1" });
		}
		await recordApprovalSimulation(db, simulationInput());
		const declared = await declareApprovalDependency(db, {
			id: "dependency-active",
			organizationId: "org-1",
			dependentApprovalRequestId: "approval-child",
			prerequisiteApprovalRequestId: "approval-parent",
			simulationId: "simulation-1",
			dependencyKind: "hard",
			recordHash: "hash-active",
			createdAt: "2026-09-03T02:00:00.000Z",
		});
		expect(
			(
				await listActiveApprovalDependencies(db, {
					organizationId: "org-1",
					approvalRequestIds: ["approval-parent"],
					relation: "prerequisite",
				})
			).map((edge) => edge.id),
		).toEqual([declared.id]);
		expect(
			await listActiveApprovalDependencies(db, {
				organizationId: "org-2",
				approvalRequestIds: ["approval-parent"],
				relation: "prerequisite",
			}),
		).toEqual([]);
		await invalidateApprovalDependency(db, {
			id: "dependency-invalidated",
			organizationId: "org-1",
			dependentApprovalRequestId: "approval-child",
			declarationEventId: declared.id,
			reason: "obsolete",
			recordHash: "hash-invalidated",
			createdAt: "2026-09-03T03:00:00.000Z",
		});
		expect(
			await listActiveApprovalDependencies(db, {
				organizationId: "org-1",
				approvalRequestIds: ["approval-child"],
				relation: "dependent",
			}),
		).toEqual([]);
	});
});

describe("immutable execution receipts", () => {
	it("converges exact retries and rejects idempotency-key content drift", async () => {
		const { sqlite, db } = fixture();
		seedApproval(sqlite, { id: "approval-parent", organizationId: "org-1" });
		await recordApprovalSimulation(db, simulationInput());
		const input = {
			id: "receipt-1",
			organizationId: "org-1",
			approvalRequestId: "approval-parent",
			simulationId: "simulation-1",
			idempotencyKey: "execute:approval-parent:attempt-1",
			canonicalInputHash: "sha256:input",
			recordHash: "sha256:receipt",
			baselineFenceOutcome: "matched" as const,
			outcome: "succeeded" as const,
			observedResult: { providerId: "provider-1" },
			providerReceiptRefs: [{ provider: "example", ref: "provider-1" }],
			executedAt: "2026-09-03T04:00:00.000Z",
			createdAt: "2026-09-03T04:00:00.000Z",
		};
		const first = await recordApprovalExecutionReceipt(db, input);
		await expect(
			recordApprovalExecutionReceipt(db, {
				...input,
				id: "receipt-stale",
				idempotencyKey: "execute:approval-parent:stale",
				baselineFenceOutcome: "stale",
			}),
		).rejects.toThrow(
			"A stale baseline fence cannot produce a successful receipt",
		);
		const retry = await recordApprovalExecutionReceipt(db, {
			...input,
			id: "receipt-retry",
		});
		expect(retry.id).toBe(first.id);
		await expect(
			recordApprovalExecutionReceipt(db, {
				...input,
				id: "receipt-drift",
				recordHash: "sha256:different-receipt",
			}),
		).rejects.toBeInstanceOf(AppendOnlyApprovalRecordConflictError);
		expect(
			(
				await listApprovalExecutionReceipts(db, {
					organizationId: "org-1",
					approvalRequestId: "approval-parent",
				})
			).map((row) => row.id),
		).toEqual(["receipt-1"]);
		expect(
			await listApprovalExecutionReceipts(db, {
				organizationId: "org-2",
				approvalRequestId: "approval-parent",
			}),
		).toEqual([]);
	});
});
