import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	createOsGadgetExecution,
	claimApprovedOsGadgetExecution,
	failClaimedOsGadgetExecution,
	getOsGadgetExecution,
	getOsGadgetExecutionByRunId,
	listOsGadgetExecutions,
	recordOsGadgetDispatch,
	settleAwaitingApprovalOsGadgetExecution,
	settleOsGadgetExecutionFromRun,
} from "./executions";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		CREATE TABLE os_gadget_executions (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			workspace_id TEXT NOT NULL,
			gadget_id TEXT NOT NULL,
			revision_id TEXT,
			revision INTEGER,
			status TEXT NOT NULL,
			granted_capabilities TEXT NOT NULL,
			policy_decision TEXT NOT NULL,
			input TEXT,
			output TEXT,
			error TEXT,
			costs TEXT,
			evidence_refs TEXT,
			run_id TEXT,
			workflow_instance_id TEXT,
			tedi_id TEXT,
			work_item_id TEXT,
			trace_bundle_id TEXT,
			billing_reservation_id TEXT,
			approval_request_id TEXT,
			runtime_environment TEXT,
			agent_session_id TEXT,
			resource_access_envelope TEXT,
			execution_epoch INTEGER NOT NULL DEFAULT 0,
			created_by_kind TEXT NOT NULL,
			created_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			completed_at TEXT
		);
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
	`);
	return { db: createDbQueryClient(createD1Facade(sqlite)) };
}

function executionParams(
	id: string,
	overrides: Partial<Parameters<typeof createOsGadgetExecution>[1]> = {},
) {
	return {
		id,
		organizationId: "org-1",
		workspaceId: "ws-1",
		gadgetId: "gd-1",
		revisionId: "rev-1",
		revision: 1,
		status: "running" as const,
		grantedCapabilities: '["email:read"]',
		policyDecision: '{"allowed":true,"reasons":[]}',
		input: '{"query":"inbox"}',
		createdByKind: "external_agent" as const,
		createdById: "agent-1",
		createdAt: "2026-08-13T16:00:00.000Z",
		...overrides,
	};
}

describe("os gadget executions", () => {
	it("resolves immutable derived-access context by tenant-scoped run id", async () => {
		const { db } = fixture();
		const envelope = JSON.stringify({ version: 1, sources: [] });
		await createOsGadgetExecution(
			db,
			executionParams("ex-access", {
				runId: "run-access",
				resourceAccessEnvelope: envelope,
			}),
		);
		expect(
			await getOsGadgetExecutionByRunId(db, {
				organizationId: "org-1",
				runId: "run-access",
			}),
		).toMatchObject({ id: "ex-access", resourceAccessEnvelope: envelope });
		expect(
			await getOsGadgetExecutionByRunId(db, {
				organizationId: "org-2",
				runId: "run-access",
			}),
		).toBeUndefined();
		await createOsGadgetExecution(
			db,
			executionParams("ex-access-duplicate", {
				runId: "run-access",
				resourceAccessEnvelope: envelope,
			}),
		);
		expect(
			await getOsGadgetExecutionByRunId(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				runId: "run-access",
			}),
		).toBeUndefined();
	});
	it("records receipts and lists them per gadget, newest first, org-scoped", async () => {
		const { db } = fixture();
		await createOsGadgetExecution(db, executionParams("ex-1"));
		await createOsGadgetExecution(
			db,
			executionParams("ex-2", {
				status: "denied",
				policyDecision: '{"allowed":false,"reasons":["gadget archived"]}',
				createdAt: "2026-08-13T16:01:00.000Z",
			}),
		);
		const rows = await listOsGadgetExecutions(db, {
			organizationId: "org-1",
			gadgetId: "gd-1",
		});
		expect(rows.map((row) => row.id)).toEqual(["ex-2", "ex-1"]);
		expect(
			await listOsGadgetExecutions(
				db,
				{ organizationId: "org-1", gadgetId: "gd-1" },
				{ status: "denied" },
			),
		).toHaveLength(1);
		expect(
			await listOsGadgetExecutions(db, {
				organizationId: "org-2",
				gadgetId: "gd-1",
			}),
		).toHaveLength(0);
		expect(
			await getOsGadgetExecution(db, {
				organizationId: "org-2",
				executionId: "ex-1",
			}),
		).toBeUndefined();
	});

	it("records governed dispatch lineage on create", async () => {
		const { db } = fixture();
		const created = await createOsGadgetExecution(
			db,
			executionParams("ex-run", {
				status: "queued",
				runId: "run-1",
				workflowInstanceId: "wf-1",
				tediId: "tedi-1",
				workItemId: "wi-1",
				billingReservationId: "resv-1",
				runtimeEnvironment: "test",
				agentSessionId: "claude:session-1",
				executionEpoch: 0,
			}),
		);
		expect(created).toMatchObject({
			runId: "run-1",
			workflowInstanceId: "wf-1",
			tediId: "tedi-1",
			workItemId: "wi-1",
			billingReservationId: "resv-1",
			executionEpoch: 0,
		});
	});

	it("claims a parked receipt before dispatch and records runtime lineage exactly once", async () => {
		const { db } = fixture();
		await createOsGadgetExecution(
			db,
			executionParams("ex-parked", {
				status: "awaiting_approval",
				tediId: "tedi-1",
				approvalRequestId: "appr-1",
			}),
		);
		const claimed = await claimApprovedOsGadgetExecution(db, {
			organizationId: "org-1",
			executionId: "ex-parked",
			runId: "ex-parked",
			billingReservationId: "resv-9",
			policyDecision: '{"allowed":true,"reasons":[]}',
			resourceAccessEnvelope: '{"version":1,"sources":[]}',
		});
		expect(claimed).toMatchObject({
			status: "queued",
			runId: "ex-parked",
			workflowInstanceId: null,
			billingReservationId: "resv-9",
			approvalRequestId: "appr-1",
		});
		// The awaiting_approval CAS admits exactly one claim.
		expect(
			await claimApprovedOsGadgetExecution(db, {
				organizationId: "org-1",
				executionId: "ex-parked",
				runId: "ex-parked",
				billingReservationId: null,
				policyDecision: '{"allowed":true,"reasons":[]}',
				resourceAccessEnvelope: '{"version":1,"sources":[]}',
			}),
		).toBeUndefined();

		const recorded = await recordOsGadgetDispatch(db, {
			organizationId: "org-1",
			executionId: "ex-parked",
			runId: "ex-parked",
			status: "running",
			workflowInstanceId: "wf-9",
			executionEpoch: 1,
		});
		expect(recorded).toMatchObject({
			status: "running",
			workflowInstanceId: "wf-9",
			executionEpoch: 1,
		});
		expect(
			await recordOsGadgetDispatch(db, {
				organizationId: "org-1",
				executionId: "ex-parked",
				runId: "ex-parked",
				status: "failed",
				workflowInstanceId: "wf-late",
				executionEpoch: 0,
			}),
		).toBeUndefined();
	});

	it("terminalizes rejected approvals and failed claims immutably", async () => {
		const { db } = fixture();
		await createOsGadgetExecution(
			db,
			executionParams("ex-rejected", {
				status: "awaiting_approval",
				approvalRequestId: "appr-rejected",
			}),
		);
		const rejected = await settleAwaitingApprovalOsGadgetExecution(db, {
			organizationId: "org-1",
			executionId: "ex-rejected",
			status: "denied",
			error: "approval_rejected",
			policyDecision: '{"allowed":false,"reasons":["approval_rejected"]}',
		});
		expect(rejected).toMatchObject({
			status: "denied",
			error: "approval_rejected",
			completedAt: expect.any(String),
		});
		expect(
			await settleAwaitingApprovalOsGadgetExecution(db, {
				organizationId: "org-1",
				executionId: "ex-rejected",
				status: "canceled",
				error: "late expiry",
				policyDecision: '{"allowed":false,"reasons":["late expiry"]}',
			}),
		).toBeUndefined();

		await createOsGadgetExecution(
			db,
			executionParams("ex-failed", {
				status: "awaiting_approval",
				approvalRequestId: "appr-failed",
			}),
		);
		await claimApprovedOsGadgetExecution(db, {
			organizationId: "org-1",
			executionId: "ex-failed",
			runId: "ex-failed",
			billingReservationId: "resv-failed",
			policyDecision: '{"allowed":true,"reasons":[]}',
			resourceAccessEnvelope: '{"version":1,"sources":[]}',
		});
		const failed = await failClaimedOsGadgetExecution(db, {
			organizationId: "org-1",
			executionId: "ex-failed",
			runId: "ex-failed",
			error: "runtime unavailable",
		});
		expect(failed).toMatchObject({
			status: "failed",
			error: "runtime unavailable",
			completedAt: expect.any(String),
		});
		expect(
			await failClaimedOsGadgetExecution(db, {
				organizationId: "org-1",
				executionId: "ex-failed",
				runId: "ex-failed",
				error: "duplicate",
			}),
		).toBeUndefined();
	});

	it("settles run-linked receipts from run evidence, once, with lifecycle sync", async () => {
		const { db } = fixture();
		await createOsGadgetExecution(
			db,
			executionParams("ex-run", {
				status: "queued",
				runId: "run-1",
				tediId: "tedi-1",
			}),
		);
		// Lifecycle sync does not settle.
		const synced = await settleOsGadgetExecutionFromRun(db, {
			runId: "run-1",
			status: "running",
		});
		expect(synced).toHaveLength(1);
		expect(synced[0]).toMatchObject({ status: "running", completedAt: null });

		const settled = await settleOsGadgetExecutionFromRun(db, {
			runId: "run-1",
			status: "completed",
			output: '{"result":7}',
			costs: '{"usd":0.02}',
			evidenceRefs: '["skill://runs/run-1"]',
			traceBundleId: "trace-1",
			executionEpoch: 1,
		});
		expect(settled).toHaveLength(1);
		expect(settled[0]).toMatchObject({
			status: "completed",
			output: '{"result":7}',
			costs: '{"usd":0.02}',
			evidenceRefs: '["skill://runs/run-1"]',
			traceBundleId: "trace-1",
			executionEpoch: 1,
			completedAt: expect.any(String),
		});
		// Terminal receipts are immutable audit evidence.
		expect(
			await settleOsGadgetExecutionFromRun(db, {
				runId: "run-1",
				status: "failed",
				error: "late duplicate",
			}),
		).toHaveLength(0);
		// A run id that pins no receipt settles nothing.
		expect(
			await settleOsGadgetExecutionFromRun(db, {
				runId: "run-unknown",
				status: "completed",
			}),
		).toHaveLength(0);
	});
});
