/**
 * Approval queue scoping tests.
 *
 * The Tedix OS board lists pending
 * approvals ORG-WIDE — no `tediId` filter — so the `orgId` predicate is the
 * only thing standing between one tenant's approval queue and another's.
 * These tests pin that predicate with real SQL: an approval owned by any tedi
 * in the org is returned; an approval from another org never is.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { sql } from "drizzle-orm";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	claimOwnerToolApprovalExecution,
	consumeHomeToolApprovalCall,
	consumeOwnerToolApproval,
	createApprovalRequest,
	createApprovalRequestWithAudit,
	createProvisionalOutcome,
	ensurePaymentBudgetOverrideRequest,
	ensureProvisionalPromotionApprovalRequest,
	findPendingOwnerToolApproval,
	getApprovalRequestById,
	listApprovalRequests,
	listProvisionalOutcomes,
	promoteProvisionalOutcome,
	recordOwnerToolApprovalExecution,
	rollbackProvisionalOutcome,
	resolveApprovalRequest,
} from "./approvals";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE tedi_approval_requests (
			id TEXT PRIMARY KEY,
			tedi_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			action_type TEXT NOT NULL,
			description TEXT NOT NULL,
			payload TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			resolved_at TEXT,
			resolved_by TEXT,
			resolution TEXT,
			workflow_id TEXT
		);
		CREATE INDEX idx_approval_requests_status
			ON tedi_approval_requests (org_id, status);
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
		CREATE TABLE tedi_provisional_outcomes (
			id TEXT PRIMARY KEY,
			tedi_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			conversation_id TEXT,
			run_id TEXT,
			kind TEXT NOT NULL,
			title TEXT NOT NULL,
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'provisional',
			promotion_approval_request_id TEXT,
			promoted_at TEXT,
			promoted_by TEXT,
			rolled_back_at TEXT,
			rolled_back_by TEXT,
			rollback_reason TEXT
		);
	`);
	return { db: createDbClient(createD1Facade(sqlite)) };
}

async function seedApproval(
	db: ReturnType<typeof setup>["db"],
	overrides: {
		id: string;
		tediId: string;
		orgId: string;
		createdAt?: string;
	},
) {
	return createApprovalRequest(db, {
		id: overrides.id,
		tediId: overrides.tediId,
		orgId: overrides.orgId,
		actionType: "deploy",
		description: `Approve ${overrides.id}`,
		payload: { kind: "test" },
		createdAt: overrides.createdAt ?? "2026-08-06T10:00:00.000Z",
		expiresAt: "2099-08-07T10:00:00.000Z",
	});
}

describe("payment budget override request identity", () => {
	it("creates one review for a rejected event and refuses a cross-tenant reuse", async () => {
		const { db } = setup();
		const request = {
			id: "fce24d03-8791-55b3-81c4-83530b52f135",
			orgId: "org-1",
			tediId: "tedi-1",
			actionType: "payment_budget_override",
			description: "Raise this tool budget",
			payload: {
				kind: "payment_budget_override",
				rejectedEventId: "payment-event-1",
			},
			createdAt: "2026-09-28T10:00:00.000Z",
			expiresAt: "2026-10-05T10:00:00.000Z",
		};
		const first = await ensurePaymentBudgetOverrideRequest(db, request);
		const retry = await ensurePaymentBudgetOverrideRequest(db, {
			...request,
			description: "A changed explanation cannot create another review",
		});
		expect(first.created).toBe(true);
		expect(retry.created).toBe(false);
		expect(retry.request.id).toBe(first.request.id);
		await expect(
			ensurePaymentBudgetOverrideRequest(db, {
				...request,
				orgId: "org-2",
			}),
		).rejects.toThrow("identity conflict");
	});
});

describe("listApprovalRequests org scoping", () => {
	it("returns pending approvals from EVERY tedi in the org and none from another org", async () => {
		const { db } = setup();
		await seedApproval(db, { id: "a-cto", orgId: "org-1", tediId: "tedi-cto" });
		await seedApproval(db, {
			id: "a-cmo",
			orgId: "org-1",
			tediId: "tedi-cmo",
			createdAt: "2026-08-06T11:00:00.000Z",
		});
		// Same status, different org — must never cross the tenant boundary.
		await seedApproval(db, {
			id: "a-other-org",
			orgId: "org-2",
			tediId: "tedi-other",
		});

		const { data, total } = await listApprovalRequests(db, {
			orgId: "org-1",
			status: "pending",
			limit: 6,
			offset: 0,
		});

		expect(total).toBe(2);
		expect(data.map((row) => row.id).sort()).toEqual(["a-cmo", "a-cto"]);
		expect(data.every((row) => row.orgId === "org-1")).toBe(true);
		expect(data.some((row) => row.id === "a-other-org")).toBe(false);
	});

	it("still narrows to one tedi when tediId is passed, inside the org fence", async () => {
		const { db } = setup();
		await seedApproval(db, { id: "b-cto", orgId: "org-1", tediId: "tedi-cto" });
		await seedApproval(db, { id: "b-cmo", orgId: "org-1", tediId: "tedi-cmo" });

		const { data, total } = await listApprovalRequests(db, {
			orgId: "org-1",
			tediId: "tedi-cmo",
			status: "pending",
			limit: 6,
			offset: 0,
		});

		expect(total).toBe(1);
		expect(data.map((row) => row.id)).toEqual(["b-cmo"]);
	});

	it("bounds the page: newest first, limit respected, total still counts the org", async () => {
		const { db } = setup();
		for (let index = 0; index < 8; index += 1) {
			await seedApproval(db, {
				id: `c-${index}`,
				orgId: "org-1",
				tediId: `tedi-${index % 3}`,
				createdAt: `2026-08-06T0${index}:00:00.000Z`,
			});
		}

		const { data, total } = await listApprovalRequests(db, {
			orgId: "org-1",
			status: "pending",
			limit: 6,
			offset: 0,
		});

		expect(total).toBe(8);
		expect(data).toHaveLength(6);
		expect(data[0]?.id).toBe("c-7");
	});
});

describe("approval resolution dependency guard", () => {
	it("allows independent approval but blocks every active hard dependency", async () => {
		const { db } = setup();
		await seedApproval(db, {
			id: "parent",
			orgId: "org-1",
			tediId: "tedi-1",
		});
		await seedApproval(db, {
			id: "child",
			orgId: "org-1",
			tediId: "tedi-1",
		});
		expect(
			await resolveApprovalRequest(db, "parent", {
				status: "approved",
				resolvedBy: "user-1",
			}),
		).toMatchObject({ status: "approved" });
		await db.run(sql`insert into tedi_approval_dependency_events
			(id, organization_id, dependent_approval_request_id,
			 prerequisite_approval_request_id, simulation_id, event_type,
			 dependency_kind, record_hash, created_at)
			values ('edge', 'org-1', 'child', 'parent', 'simulation',
			'declared', 'hard', 'hash', '2026-09-22T00:00:00.000Z')`);
		expect(
			await resolveApprovalRequest(db, "child", {
				status: "approved",
				resolvedBy: "user-1",
			}),
		).toBeUndefined();
		expect(
			await resolveApprovalRequest(db, "child", {
				status: "rejected",
				resolvedBy: "user-1",
			}),
		).toMatchObject({ status: "rejected" });
	});

	it("allows approval after the hard dependency declaration is invalidated", async () => {
		const { db } = setup();
		for (const id of ["parent", "child"]) {
			await seedApproval(db, { id, orgId: "org-1", tediId: "tedi-1" });
		}
		await db.run(sql`insert into tedi_approval_dependency_events values
			('edge', 'org-1', 'child', 'parent', 'simulation', 'declared',
			 'hard', null, null, 'hash', '2026-09-22T00:00:00.000Z'),
			('invalidated', 'org-1', 'child', 'parent', 'simulation', 'invalidated',
			 'hard', 'edge', 'obsolete', 'hash-2', '2026-09-22T00:01:00.000Z')`);
		expect(
			await resolveApprovalRequest(db, "child", {
				status: "approved",
				resolvedBy: "user-1",
			}),
		).toMatchObject({ status: "approved" });
	});
});

describe("approval with approver edits", () => {
	it("writes the edited payload only with an approval of a pending request", async () => {
		const { db } = setup();
		await seedApproval(db, { id: "edit", orgId: "org-1", tediId: "tedi-1" });
		await seedApproval(db, { id: "deny", orgId: "org-1", tediId: "tedi-1" });
		const edited = { kind: "test", args: { title: "Changed" } };

		const rejected = await resolveApprovalRequest(db, "deny", {
			status: "rejected",
			resolvedBy: "user-1",
			payload: edited,
		});
		expect(rejected?.status).toBe("rejected");
		expect(rejected?.payload).toEqual({ kind: "test" });
		expect(
			await resolveApprovalRequest(db, "edit", {
				status: "approved",
				resolvedBy: "user-1",
				payload: edited,
			}),
		).toMatchObject({ status: "approved", payload: edited });
		expect(
			await resolveApprovalRequest(db, "edit", {
				status: "approved",
				resolvedBy: "user-2",
				payload: { kind: "test", args: { title: "Late" } },
			}),
		).toBeUndefined();
	});
});

describe("provisional outcome isolation", () => {
	it("idempotently reuses only the exact hash-bound promotion request", async () => {
		const { db } = setup();
		const input = {
			id: "approval-promotion-1",
			provisionalOutcomeId: "proposal-1",
			provisionalOutcomeHash: "sha256:proposal-1",
			tediId: "tedi-1",
			orgId: "org-1",
			description: "Promote proposal",
			createdAt: "2026-09-03T00:00:00.000Z",
			expiresAt: "2026-09-04T00:00:00.000Z",
			workflowId: "workflow-1",
		};
		expect(
			(await ensureProvisionalPromotionApprovalRequest(db, input)).created,
		).toBe(true);
		expect(
			(await ensureProvisionalPromotionApprovalRequest(db, input)).created,
		).toBe(false);
		await expect(
			ensureProvisionalPromotionApprovalRequest(db, {
				...input,
				provisionalOutcomeHash: "sha256:changed",
			}),
		).rejects.toThrow("different content");
	});

	it("stores a non-canonical record with no approval or executor fields", async () => {
		const { db } = setup();
		const row = await createProvisionalOutcome(db, {
			id: "proposal-1",
			tediId: "tedi-1",
			orgId: "org-1",
			conversationId: "conversation-1",
			runId: "run-1",
			kind: "configuration_proposal",
			title: "Proposed timeout",
			payload: { timeoutSeconds: 30 },
			createdAt: "2026-09-03T00:00:00.000Z",
		});

		expect(row).toMatchObject({
			id: "proposal-1",
			orgId: "org-1",
			payload: { timeoutSeconds: 30 },
		});
		expect(row.state).toBe("provisional");
		expect(row).not.toHaveProperty("status");
		expect(row).not.toHaveProperty("workflowId");
		expect(row).not.toHaveProperty("approvalRequestId");
	});

	it("never returns another tenant's provisional outcome", async () => {
		const { db } = setup();
		for (const [id, orgId] of [
			["own", "org-1"],
			["foreign", "org-2"],
		] as const) {
			await createProvisionalOutcome(db, {
				id,
				tediId: `tedi-${orgId}`,
				orgId,
				kind: "draft",
				title: id,
				payload: {},
				createdAt: "2026-09-03T00:00:00.000Z",
			});
		}

		const rows = await listProvisionalOutcomes(db, { orgId: "org-1" });
		expect(rows.map((row) => row.id)).toEqual(["own"]);
	});

	it("CAS-promotes once and rolls back only a promoted record within its org", async () => {
		const { db } = setup();
		await createProvisionalOutcome(db, {
			id: "proposal-1",
			tediId: "tedi-1",
			orgId: "org-1",
			kind: "draft",
			title: "Draft",
			payload: {},
			createdAt: "2026-09-03T00:00:00.000Z",
		});
		const promoted = await promoteProvisionalOutcome(db, {
			id: "proposal-1",
			orgId: "org-1",
			actorId: "human-1",
			at: "2026-09-03T01:00:00.000Z",
			approvalRequestId: "approval-1",
		});
		expect(promoted).toMatchObject({
			state: "promoted",
			promotionApprovalRequestId: "approval-1",
			promotedBy: "human-1",
		});
		expect(
			await promoteProvisionalOutcome(db, {
				id: "proposal-1",
				orgId: "org-1",
				actorId: "human-2",
				at: "2026-09-03T02:00:00.000Z",
				approvalRequestId: "approval-2",
			}),
		).toBeUndefined();
		expect(
			await rollbackProvisionalOutcome(db, {
				id: "proposal-1",
				orgId: "org-2",
				actorId: "foreign",
				at: "2026-09-03T02:00:00.000Z",
				reason: "no",
			}),
		).toBeUndefined();
		const rolledBack = await rollbackProvisionalOutcome(db, {
			id: "proposal-1",
			orgId: "org-1",
			actorId: "human-1",
			at: "2026-09-03T02:00:00.000Z",
			reason: "regression",
		});
		expect(rolledBack).toMatchObject({
			state: "rolled_back",
			rollbackReason: "regression",
			rolledBackBy: "human-1",
		});
	});
});

describe("createApprovalRequestWithAudit", () => {
	function auditSetup() {
		const { db } = setup();
		return db;
	}
	const approval = {
		id: "approval-1",
		tediId: "tedi-1",
		orgId: "org-1",
		actionType: "home.tool_write",
		description: "Create a document",
		payload: { kind: "home_tool_write" },
		createdAt: "2026-10-16T10:00:00.000Z",
		expiresAt: "2099-10-17T10:00:00.000Z",
	};
	const audit = {
		organizationId: "org-1",
		actorId: "kernel",
		actorType: "kernel" as const,
		action: "approval.requested",
		resourceType: "approval_request",
		resourceId: "approval-1",
	};

	it("lands the pending approval and its audit row together", async () => {
		const db = auditSetup();
		await db.run(
			sql.raw(`CREATE TABLE audit_events (
				id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL,
				actor_id TEXT NOT NULL, actor_type TEXT NOT NULL, action TEXT NOT NULL,
				resource_type TEXT NOT NULL, resource_id TEXT, metadata TEXT,
				ip_address TEXT, user_agent TEXT, timestamp INTEGER NOT NULL)`),
		);
		const created = await createApprovalRequestWithAudit(db, approval, audit);
		expect(created).toMatchObject({ id: "approval-1", status: "pending" });
		const rows = await db.all<{ action: string; resource_id: string }>(
			sql`SELECT action, resource_id FROM audit_events`,
		);
		expect(rows).toEqual([
			{ action: "approval.requested", resource_id: "approval-1" },
		]);
	});

	it("writes neither row when the audit insert fails", async () => {
		const db = auditSetup();
		await expect(
			createApprovalRequestWithAudit(db, approval, audit),
		).rejects.toThrow();
		expect(await listApprovalRequests(db, { orgId: "org-1" })).toMatchObject({
			data: [],
			total: 0,
		});
	});
});

describe("automatic scratch approval", () => {
	it("is inserted resolved and never enters the human pending list", async () => {
		const { db } = setup();
		const row = await createApprovalRequest(db, {
			id: "scratch",
			orgId: "fictional-org",
			tediId: "fictional-owner",
			actionType: "work_item.cleanup",
			description: "Cancel scratch Work",
			payload: { workItemId: "scratch-work" },
			createdAt: "2026-10-17T00:00:00Z",
			expiresAt: "2099-10-18T00:00:00Z",
			automaticApproval: {
				tediId: "fictional-owner",
				reason: "Disposable agent Work; no active Attempt",
			},
		});
		expect(row.status).toBe("approved");
		expect(row.resolvedBy).toBe("fictional-owner");
		expect(
			(
				await listApprovalRequests(db, {
					orgId: "fictional-org",
					status: "pending",
				})
			).total,
		).toBe(0);
	});
});

describe("exact owner tool approval consumption", () => {
	it("claims once and preserves tenant, fingerprint, expiry and pending fences", async () => {
		const { db } = setup();
		await createApprovalRequest(db, {
			id: "gateway-1",
			orgId: "org-1",
			tediId: "tedi-1",
			actionType: "mcp.tool_call",
			description: "Send approved content",
			payload: { fingerprint: "exact-input" },
			createdAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2099-01-02T00:00:00.000Z",
		});
		const input = {
			id: "gateway-1",
			organizationId: "org-1",
			fingerprint: "exact-input",
			now: "2026-01-01T01:00:00.000Z",
		};
		expect(await consumeOwnerToolApproval(db, input)).toBe(false);
		await resolveApprovalRequest(db, input.id, {
			status: "approved",
			resolvedBy: "owner-1",
		});
		expect(
			await consumeOwnerToolApproval(db, {
				...input,
				organizationId: "other-org",
			}),
		).toBe(false);
		expect(
			await consumeOwnerToolApproval(db, {
				...input,
				fingerprint: "changed-input",
			}),
		).toBe(false);
		expect(
			await consumeOwnerToolApproval(db, {
				...input,
				now: "2099-01-03T00:00:00.000Z",
			}),
		).toBe(false);
		expect(await consumeOwnerToolApproval(db, input)).toBe(true);
		expect(await consumeOwnerToolApproval(db, input)).toBe(false);
	});
	it("claims the platform-side execution of an approved call once and records its end", async () => {
		const { db } = setup();
		const now = "2026-01-01T01:00:00.000Z";
		const seed = async (id: string, expiresAt = "2099-01-02T00:00:00.000Z") =>
			createApprovalRequest(db, {
				id,
				orgId: "org-1",
				tediId: "tedi-1",
				actionType: "mcp.tool_call",
				description: "Delete a client",
				payload: { kind: "mcp_tool_call", fingerprint: "exact-input" },
				createdAt: "2026-01-01T00:00:00.000Z",
				expiresAt,
			});
		await seed("pending-1");
		expect(
			await claimOwnerToolApprovalExecution(db, {
				id: "pending-1",
				organizationId: "org-1",
				now,
			}),
		).toBe(false);
		await seed("expired-1", "2026-01-01T00:30:00.000Z");
		await resolveApprovalRequest(db, "expired-1", {
			status: "approved",
			resolvedBy: "owner-1",
		});
		expect(
			await claimOwnerToolApprovalExecution(db, {
				id: "expired-1",
				organizationId: "org-1",
				now,
			}),
		).toBe(false);
		await seed("approved-1");
		await resolveApprovalRequest(db, "approved-1", {
			status: "approved",
			resolvedBy: "owner-1",
		});
		const claim = { id: "approved-1", organizationId: "org-1", now };
		expect(
			await claimOwnerToolApprovalExecution(db, {
				...claim,
				organizationId: "other-org",
			}),
		).toBe(false);
		expect(await claimOwnerToolApprovalExecution(db, claim)).toBe(true);
		expect(await claimOwnerToolApprovalExecution(db, claim)).toBe(false);
		// The claimed call is still consumable by the gateway hop that runs it.
		expect(
			await consumeOwnerToolApproval(db, {
				...claim,
				fingerprint: "exact-input",
			}),
		).toBe(true);
		await recordOwnerToolApprovalExecution(db, {
			id: "approved-1",
			organizationId: "org-1",
			execution: {
				status: "executed",
				startedAt: now,
				finishedAt: "2026-01-01T01:00:01.000Z",
				summary: "Client deleted",
			},
		});
		const row = await getApprovalRequestById(db, "approved-1");
		expect(row?.payload).toMatchObject({
			kind: "mcp_tool_call",
			consumedAt: now,
			execution: { status: "executed", summary: "Client deleted" },
		});
		// A rejected request is never claimable.
		await seed("rejected-1");
		await resolveApprovalRequest(db, "rejected-1", {
			status: "rejected",
			resolvedBy: "owner-1",
		});
		expect(
			await claimOwnerToolApprovalExecution(db, {
				...claim,
				id: "rejected-1",
			}),
		).toBe(false);
	});
});

describe("Home write approval call consumption", () => {
	it("runs each approved call once per credential path", async () => {
		const { db } = setup();
		await createApprovalRequest(db, {
			id: "home-1",
			orgId: "org-1",
			tediId: "tedi-1",
			actionType: "home.tool_write",
			description: "Create a sheet",
			payload: { kind: "home_tool_write" },
			createdAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2099-01-02T00:00:00.000Z",
		});
		const digest = "a".repeat(64);
		const input = {
			id: "home-1",
			organizationId: "org-1",
			slot: `user_${digest}`,
			now: "2026-01-01T01:00:00.000Z",
		};
		expect(await consumeHomeToolApprovalCall(db, input)).toBe(false);
		await resolveApprovalRequest(db, input.id, {
			status: "approved",
			resolvedBy: "owner-1",
		});
		expect(
			await consumeHomeToolApprovalCall(db, {
				...input,
				organizationId: "other-org",
			}),
		).toBe(false);
		expect(await consumeHomeToolApprovalCall(db, input)).toBe(true);
		expect(await consumeHomeToolApprovalCall(db, input)).toBe(false);
		expect(
			await consumeHomeToolApprovalCall(db, {
				...input,
				slot: `tenant_${digest}`,
			}),
		).toBe(true);
		expect(
			await consumeHomeToolApprovalCall(db, {
				...input,
				slot: `tenant_${digest}`,
			}),
		).toBe(false);
		expect(
			await consumeHomeToolApprovalCall(db, {
				...input,
				slot: `user_${"b".repeat(64)}`,
			}),
		).toBe(true);
		await expect(
			consumeHomeToolApprovalCall(db, { ...input, slot: "user_x') --" }),
		).rejects.toThrow("Invalid Home approval call slot");
	});
});

describe("pending owner tool approval lookup", () => {
	it("finds only the open request for the same organization and call", async () => {
		const { db } = setup();
		await createApprovalRequest(db, {
			id: "gateway-open",
			orgId: "org-1",
			tediId: "tedi-1",
			actionType: "mcp.tool_call",
			description: "Run skill: Example research",
			payload: { fingerprint: "exact-input" },
			createdAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2026-01-02T00:00:00.000Z",
		});
		const input = {
			organizationId: "org-1",
			fingerprint: "exact-input",
			now: "2026-01-01T01:00:00.000Z",
		};
		expect(await findPendingOwnerToolApproval(db, input)).toEqual({
			id: "gateway-open",
		});
		for (const miss of [
			{ organizationId: "other-org" },
			{ fingerprint: "changed-input" },
			{ now: "2026-01-03T00:00:00.000Z" },
		])
			expect(
				await findPendingOwnerToolApproval(db, { ...input, ...miss }),
			).toBeUndefined();
		await resolveApprovalRequest(db, "gateway-open", {
			status: "rejected",
			resolvedBy: "owner-1",
		});
		expect(await findPendingOwnerToolApproval(db, input)).toBeUndefined();
	});
});
