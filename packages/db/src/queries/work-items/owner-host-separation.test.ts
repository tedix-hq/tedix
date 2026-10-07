/**
 * Separation of duties treats an owner-host agent and its human owner as one
 * party. Regression for the self-approval exploit: member U opens an
 * owner-host session (principal P bound owner_user -> U), proposes an approval
 * as external_agent:P naming user:U, then decides as user:U.
 */

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	areSameWorkParty,
	resolveCanonicalWorkParties,
} from "../external-agent-identity/canonical-party";
import { evaluateAndRecordWorkAdmission } from "./admissions";
import { decideWorkApproval, proposeWorkApproval } from "./approvals";

const migrationRoot = new URL("../../../drizzle/", import.meta.url);
const migrations = readdirSync(migrationRoot)
	.sort()
	.map((name) =>
		readFileSync(new URL(`${name}/migration.sql`, migrationRoot), "utf8"),
	);

const NOW = "2026-08-20T00:30:00.000Z";
const LIVE_PURPOSE_EXCEPTION = "2026-09-01T00:00:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=ON");
	for (const sql of migrations) sqlite.exec(sql);
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Org','org');
		INSERT INTO users(id,email) VALUES('owner','owner@example.test');
		INSERT INTO users(id,email) VALUES('other','other@example.test');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES('m-owner','org','descope-owner','owner','owner@example.test','active');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES('m-other','org','descope-other','other','other@example.test','active');
		INSERT INTO work_items(id,org_id,title,disposition,risk_level,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('work','org','Work','accepted','high','hygiene','${LIVE_PURPOSE_EXCEPTION}','revision-1','2026-08-20T00:00:00.000Z');
		INSERT INTO external_agent_principals(id,organization_id,key,display_name,credential_binding_type,credential_binding_id,created_by_type,created_by_id) VALUES('owner-host','org','owner-host-0123456789ab','Plugin hosts of owner','owner_user','owner','user','owner');
		INSERT INTO external_agent_sessions(id,organization_id,principal_id,external_session_key,harness,harness_version,model_provider,model_id,model_version,identity_source,credit_eligible,started_at,last_seen_at) VALUES('host-session','org','owner-host','claude-desktop:thread-1','claude-desktop','1','anthropic','claude','1','explicit',0,'2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z');
		INSERT INTO external_agent_principals(id,organization_id,key,display_name,credential_binding_type,credential_binding_id,created_by_type,created_by_id) VALUES('machine','org','codex','Codex','api_key','owner','user','owner');
	`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

const proposal = {
	orgId: "org",
	workItemId: "work",
	workItemVersion: 1,
	authorityKey: "risk:high",
	proposal: { reason: "risk" },
	rationale: "Elevated-risk admission",
	expiresAt: "2026-08-21T00:00:00.000Z",
	now: NOW,
};

describe("canonical party separation of duties", () => {
	it("maps an owner-host principal, and only it, to its owner", async () => {
		const { db } = fixture();
		const map = await resolveCanonicalWorkParties(db, {
			organizationId: "org",
			parties: [
				{ type: "external_agent", id: "owner-host" },
				{ type: "external_agent", id: "machine" },
				{ type: "user", id: "owner" },
			],
		});
		expect(Object.fromEntries(map)).toEqual({
			"external_agent:owner-host": "user:owner",
		});
		await expect(
			areSameWorkParty(db, {
				organizationId: "org",
				left: { type: "external_agent", id: "machine" },
				right: { type: "user", id: "owner" },
			}),
		).resolves.toBe(false);
		await expect(
			areSameWorkParty(db, {
				organizationId: "other-org",
				left: { type: "external_agent", id: "owner-host" },
				right: { type: "user", id: "owner" },
			}),
		).resolves.toBe(false);
	});

	it("refuses an owner-host agent proposing an approval its owner decides", async () => {
		const { db } = fixture();
		await expect(
			proposeWorkApproval(db, {
				...proposal,
				id: "exploit",
				requesterType: "external_agent",
				requesterId: "owner-host",
				requesterSessionId: "host-session",
				externalSessionKey: "claude-desktop:thread-1",
				approverType: "user",
				approverId: "owner",
			}),
		).rejects.toMatchObject({ code: "INVALID_PRINCIPAL" });
	});

	it("refuses the owner deciding a stored proposal requested by their own agent", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(
			`INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,requester_session_id,requester_external_session_key,approver_type,approver_id,rationale,expires_at,created_at) VALUES('stored','org','work',1,'risk:high','admission','{}','external_agent','owner-host','host-session','claude-desktop:thread-1','user','owner','Need approval','2026-08-21T00:00:00.000Z','2026-08-20T00:00:00.000Z')`,
		);
		await expect(
			decideWorkApproval(db, {
				id: "decision",
				orgId: "org",
				proposalId: "stored",
				expectedVersion: 1,
				decision: "approved",
				deciderType: "user",
				deciderId: "owner",
				rationale: "Self",
				now: NOW,
			}),
		).rejects.toMatchObject({ code: "INVALID_PRINCIPAL" });
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_approval_decisions").get(),
		).toEqual({ n: 0 });
	});

	it("does not count the owner's approval toward their own agent's admission", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(
			`INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,rationale,expires_at,created_at) VALUES('approval','org','work',1,'risk:high','admission','{}','system','tedix','user','owner','Need approval','2026-08-21T00:00:00.000Z','2026-08-20T00:00:00.000Z');
			 INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at) VALUES('decision','approval',2,'approved','user','owner','Approved','2026-08-20T00:10:00.000Z')`,
		);
		const admission = await evaluateAndRecordWorkAdmission(db, {
			id: "admission",
			orgId: "org",
			workItemId: "work",
			expectedWorkItemVersion: 1,
			expectedAdmissionSpecRevision: "revision-1",
			executorType: "external_agent",
			executorId: "owner-host",
			executorSessionId: "host-session",
			externalSessionKey: "claude-desktop:thread-1",
			leaseTtlMs: 60_000,
			now: NOW,
		});
		expect(admission).toMatchObject({
			decision: "rejected",
			rejectionCode: "approval_blocked",
		});
	});
});
