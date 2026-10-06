import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { listApprovalExecutionReceipts } from "@tedix/db/queries/approval-simulations";
import {
	createApprovalRequest,
	createProvisionalOutcome,
	getProvisionalOutcomeById,
	resolveApprovalRequest,
} from "@tedix/db/queries/approvals";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { tediApprovalDependencyEvents } from "@tedix/db/schema/approval-simulations";
import {
	executeApprovedProvisionalPromotion,
	provisionalOutcomeRecordHash,
} from "./provisional-outcome-promotion";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE tedi_approval_requests (
			id TEXT PRIMARY KEY, tedi_id TEXT NOT NULL, org_id TEXT NOT NULL,
			action_type TEXT NOT NULL, description TEXT NOT NULL, payload TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT,
			resolution TEXT, workflow_id TEXT
		);
		CREATE TABLE tedi_provisional_outcomes (
			id TEXT PRIMARY KEY, tedi_id TEXT NOT NULL, org_id TEXT NOT NULL,
			conversation_id TEXT, run_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL,
			payload TEXT NOT NULL, created_at TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'provisional', promotion_approval_request_id TEXT,
			promoted_at TEXT, promoted_by TEXT, rolled_back_at TEXT,
			rolled_back_by TEXT, rollback_reason TEXT
		);
		CREATE TABLE tedi_approval_simulations (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
			approval_request_id TEXT NOT NULL, simulator_id TEXT NOT NULL,
			simulator_version TEXT NOT NULL, canonical_input_hash TEXT NOT NULL,
			record_hash TEXT NOT NULL, baseline_evidence_refs TEXT NOT NULL,
			predicted_result TEXT NOT NULL, assumptions TEXT NOT NULL,
			confidence REAL NOT NULL, evidence_kind TEXT NOT NULL,
			not_proof INTEGER NOT NULL, created_at TEXT NOT NULL
		);
		CREATE TABLE tedi_approval_execution_receipts (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
			approval_request_id TEXT NOT NULL, simulation_id TEXT,
			idempotency_key TEXT NOT NULL, canonical_input_hash TEXT NOT NULL,
			record_hash TEXT NOT NULL, baseline_fence_outcome TEXT NOT NULL,
			outcome TEXT NOT NULL, observed_result TEXT, observed_error TEXT,
			provider_receipt_refs TEXT NOT NULL, executed_at TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX uniq_approval_execution_receipt_idempotency
			ON tedi_approval_execution_receipts
			(organization_id, approval_request_id, idempotency_key);
	`);
	sqlite.exec(schemaDdl(tediApprovalDependencyEvents));
	return createDbClient(createD1Facade(sqlite));
}

async function seed(
	status: "approved" | "rejected",
	version: "v1" | "v2" = "v2",
) {
	const db = setup();
	const outcome = await createProvisionalOutcome(db, {
		id: "outcome-1",
		tediId: "tedi-1",
		orgId: "org-1",
		conversationId: "conversation-1",
		runId: "run-1",
		kind: "configuration_proposal",
		title: "Proposed timeout",
		payload: { timeoutSeconds: 30 },
		createdAt: "2026-09-03T00:00:00.000Z",
	});
	const hash = await provisionalOutcomeRecordHash(outcome);
	await createApprovalRequest(db, {
		id: "approval-1",
		tediId: outcome.tediId,
		orgId: outcome.orgId,
		actionType: "provisional_outcome_promotion",
		description: "Promote proposed timeout",
		payload:
			version === "v2"
				? {
						kind: "provisional_outcome_promotion_v2",
						provisionalOutcomeId: outcome.id,
						provisionalOutcomeHash: hash,
					}
				: {
						kind: "provisional_outcome_promotion_v1",
						provisionalOutcomeId: outcome.id,
					},
		createdAt: "2026-09-03T00:01:00.000Z",
		expiresAt: "2099-09-04T00:01:00.000Z",
	});
	const approval = await resolveApprovalRequest(db, "approval-1", {
		status,
		resolvedBy: "user-1",
	});
	if (!approval) throw new Error("expected approval resolution");
	return { approval, db };
}

describe("approved provisional outcome execution", () => {
	it("promotes only after approval and writes one idempotent observed receipt", async () => {
		const { approval, db } = await seed("approved");
		const first = await executeApprovedProvisionalPromotion(db, {
			approval,
			actorId: "user-1",
		});
		const retry = await executeApprovedProvisionalPromotion(db, {
			approval,
			actorId: "user-1",
		});

		expect(first).toMatchObject({ replayed: false });
		expect(retry).toMatchObject({ replayed: true });
		expect((await getProvisionalOutcomeById(db, "outcome-1"))?.state).toBe(
			"promoted",
		);
		const receipts = await listApprovalExecutionReceipts(db, {
			organizationId: "org-1",
			approvalRequestId: "approval-1",
		});
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({
			baselineFenceOutcome: "matched",
			outcome: "succeeded",
			providerReceiptRefs: [],
			observedResult: {
				provisionalOutcomeId: "outcome-1",
				state: "promoted",
			},
		});
	});

	it("does not promote or write a receipt after rejection", async () => {
		const { approval, db } = await seed("rejected");
		expect(
			await executeApprovedProvisionalPromotion(db, {
				approval,
				actorId: "user-1",
			}),
		).toBeNull();
		expect((await getProvisionalOutcomeById(db, "outcome-1"))?.state).toBe(
			"provisional",
		);
		expect(
			await listApprovalExecutionReceipts(db, {
				organizationId: "org-1",
				approvalRequestId: "approval-1",
			}),
		).toEqual([]);
	});

	it("fails closed for approved legacy requests without an immutable hash", async () => {
		const { approval, db } = await seed("approved", "v1");
		expect(
			await executeApprovedProvisionalPromotion(db, {
				approval,
				actorId: "user-1",
			}),
		).toBeNull();
		expect((await getProvisionalOutcomeById(db, "outcome-1"))?.state).toBe(
			"provisional",
		);
		expect(
			await listApprovalExecutionReceipts(db, {
				organizationId: "org-1",
				approvalRequestId: "approval-1",
			}),
		).toEqual([]);
	});
});
