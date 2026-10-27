import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import {
	proposeWorkApproval,
	decideWorkApproval,
	claimAgentRequestExecution,
	finishAgentRequestExecution,
	getWorkApprovalProposal,
	listWorkApprovalInbox,
} from "./approvals";

const NOW = "2026-10-27T07:00:00.000Z";
const EXPIRES = "2026-10-28T07:00:00.000Z";
const payload = {
	kind: "tedi",
	name: "Research",
	slug: "research",
	ownerUserId: "requester",
	ownerTeam: "Research",
	justification: "Prepare research for review",
	dataSensitivity: "internal",
};

function fixture() {
	const sqlite = createMigratedSqlite();
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug,metadata) VALUES('org','Example','example','{"agentRequestApprovals":{"approver":"org_admin"}}');
		INSERT INTO users(id,email) VALUES('requester','requester@example.test'),('approver','approver@example.test');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status,role) VALUES
		('requester-member','org','requester-sub','requester','requester@example.test','active','member'),
		('approver-member','org','approver-sub','approver','approver@example.test','active','admin');
		INSERT INTO work_items(id,org_id,title,disposition,risk_level,work_class,purpose_exception_expires_at,admission_spec_revision,created_at)
		VALUES('work','org','Request an agent','accepted','medium','maintenance','2026-11-01T00:00:00.000Z','revision', '${NOW}');
	`);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const request = (extra = {}) =>
		proposeWorkApproval(db, {
			id: crypto.randomUUID(),
			orgId: "org",
			workItemId: "work",
			workItemVersion: 1,
			action: "agent.create",
			authorityKey: "agent.create",
			proposal: payload,
			requesterType: "user",
			requesterId: "requester",
			approverType: "user",
			approverId: "approver",
			rationale: "Review the owner and scope",
			expiresAt: EXPIRES,
			now: NOW,
			...extra,
		});
	const decide = (id: string, extra = {}) =>
		decideWorkApproval(db, {
			id: crypto.randomUUID(),
			orgId: "org",
			proposalId: id,
			expectedVersion: 1,
			decision: "approved",
			deciderType: "user",
			deciderId: "approver",
			rationale: "Owner and scope reviewed",
			now: NOW,
			...extra,
		});
	return { sqlite, db, request, decide };
}

describe("agent requests on the migrated approval ledger", () => {
	it("withholds carry-out when the policy is disabled after approval", async () => {
		const { sqlite, db, request, decide } = fixture();
		const proposal = await request();
		const decision = await decide(proposal.id);
		sqlite.exec("UPDATE organizations SET metadata='{}'");
		expect(
			await claimAgentRequestExecution(db, {
				orgId: "org",
				proposalId: proposal.id,
				decisionId: decision.id,
			}),
		).toBeNull();
	});

	it("stays disabled until the organization owner selects an approval policy", async () => {
		const { sqlite, request } = fixture();
		sqlite.exec("UPDATE organizations SET metadata='{}'");
		await expect(request()).rejects.toThrow(/policy has not been enabled/);
	});

	it("keeps pending requests inert, reuses the inbox, and claims an approved execution once", async () => {
		const { db, request, decide } = fixture();
		const proposal = await request();
		expect(proposal.execution).toEqual({ status: "pending" });
		expect(
			await claimAgentRequestExecution(db, {
				orgId: "org",
				proposalId: proposal.id,
				decisionId: "missing",
			}),
		).toBeNull();
		const inbox = await listWorkApprovalInbox(db, {
			orgId: "org",
			approverType: "user",
			approverId: "approver",
			observedAt: NOW,
		});
		expect(inbox.data[0]?.proposal.proposal).toEqual(payload);
		const decision = await decide(proposal.id);
		const execution = {
			orgId: "org",
			proposalId: proposal.id,
			decisionId: decision.id,
		};
		expect(
			await claimAgentRequestExecution(db, { ...execution, orgId: "other" }),
		).toBeNull();
		expect(await claimAgentRequestExecution(db, execution)).toMatchObject({
			id: proposal.id,
			status: "approved",
			execution: { status: "running" },
		});
		expect(await claimAgentRequestExecution(db, execution)).toBeNull();
		await finishAgentRequestExecution(db, {
			...execution,
			execution: {
				status: "succeeded",
				resourceId: "created-agent",
				completedAt: NOW,
			},
		});
		await finishAgentRequestExecution(db, {
			...execution,
			execution: { status: "failed" },
		});
		expect(await getWorkApprovalProposal(db, execution)).toMatchObject({
			status: "approved",
			version: 2,
			proposal: payload,
			execution: { status: "succeeded", resourceId: "created-agent" },
		});
		await expect(decide(proposal.id)).rejects.toThrow(/resolvable/);
	});

	it("cannot execute rejected or expired requests", async () => {
		const rejected = fixture();
		const proposal = await rejected.request();
		const decision = await rejected.decide(proposal.id, {
			decision: "rejected",
		});
		expect(
			await claimAgentRequestExecution(rejected.db, {
				orgId: "org",
				proposalId: proposal.id,
				decisionId: decision.id,
			}),
		).toBeNull();
		const expired = fixture();
		const old = await expired.request();
		await expect(expired.decide(old.id, { now: EXPIRES })).rejects.toThrow(
			/resolvable/,
		);
	});

	it("requires an independent current admin in the same organization and an active owner", async () => {
		const { request, sqlite } = fixture();
		await expect(request({ approverId: "requester" })).rejects.toThrow(
			/owner or admin/,
		);
		await expect(request({ approverId: "other-org-admin" })).rejects.toThrow(
			/owner or admin/,
		);
		await expect(request({ requesterId: "approver" })).rejects.toThrow(
			/own proposal/,
		);
		await expect(
			request({ proposal: { ...payload, ownerUserId: "other-org-owner" } }),
		).rejects.toThrow(/active organization member/);
		sqlite.exec(
			"UPDATE organization_members SET role='member' WHERE user_id='approver'",
		);
		await expect(request()).rejects.toThrow(/owner or admin/);
	});

	it("rejects stale Work and revoked approvers before recording a decision", async () => {
		const stale = fixture();
		const proposal = await stale.request();
		stale.sqlite.exec(
			"UPDATE work_items SET title='Changed request', version=2 WHERE id='work'",
		);
		await expect(stale.decide(proposal.id)).rejects.toThrow(/resolution race/);
		const revoked = fixture();
		const pending = await revoked.request();
		revoked.sqlite.exec(
			"UPDATE organization_members SET role='member' WHERE user_id='approver'",
		);
		await expect(revoked.decide(pending.id)).rejects.toThrow(/owner or admin/);
	});

	it("rejects mismatched actions, malformed labels and terminal Work", async () => {
		const { request, sqlite } = fixture();
		await expect(request({ action: "agent.connect" })).rejects.toThrow(
			/matching typed proposal/,
		);
		await expect(
			request({ proposal: { ...payload, justification: "" } }),
		).rejects.toThrow(/matching typed proposal/);
		sqlite.exec(
			"UPDATE work_items SET disposition='completed' WHERE id='work'",
		);
		await expect(request()).rejects.toThrow(/open Work/);
	});
});
