/**
 * The tedi runtime reaches `workApprovals.listInbox` and `workApprovals.decide`
 * over its trusted service binding, delegating exactly
 * `TEDI_RUNTIME_SERVICE_BINDING_SCOPES`. These tests build that context with
 * the real list (imported, never copied) so a scope dropped from either side
 * fails here instead of 403-ing every live runtime call.
 */

import { apiKeys } from "@tedix/db/schema/api-keys";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import {
	externalAgentPrincipals,
	externalAgentSessions,
	externalAgentMcpCredentials,
} from "@tedix/db/schema/external-agent-identity";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import {
	workResourceRequirements,
	workBudgetEnvelopes,
	workApprovalDecisions,
	workApprovalProposals,
} from "@tedix/db/schema/work-factory";
import { workEvents, workItems } from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import { TEDI_RUNTIME_SERVICE_BINDING_SCOPES } from "../../../../tedi-runtime/src/platform-client-factory";
import type { BaseContext } from "../orpc";
import { workApprovalsContractRouter } from "./work-approvals";

const ORG_ID = "00000000-0000-4000-8000-000000000101";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000102";
const WORK_ITEM_ID = "00000000-0000-4000-8000-000000000103";
const DESIGNATED_TEDI_ID = "designated-tedi-id";
const BYSTANDER_TEDI_ID = "bystander-tedi-id";
const OTHER_ORG_TEDI_ID = "other-org-tedi-id";
const REQUESTER_USER_ID = "requester-user-id";
const REQUESTER_SUBJECT = "requester-subject";
const APPROVER_USER_ID = "approver-user-id";
const APPROVER_SUBJECT = "approver-subject";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			apiKeys,
			learningInteractionEvents,
			workResourceRequirements,
			workBudgetEnvelopes,
			externalAgentPrincipals,
			externalAgentSessions,
			externalAgentMcpCredentials,
			workItems,
			workEvents,
			workApprovalProposals,
			workApprovalDecisions,
			organizationMembers,
			tedis,
		),
	);
	sqlite
		.prepare(
			"INSERT INTO work_items (id,org_id,title,required_authorities,created_at) VALUES (?,?,?,json(?),?)",
		)
		.run(
			WORK_ITEM_ID,
			ORG_ID,
			"Runtime scope approval",
			JSON.stringify(["deploy:production"]),
			"2026-10-20T00:00:00.000Z",
		);
	const insertMember = sqlite.prepare(
		`INSERT INTO organization_members
		(id,organization_id,user_id,descope_user_id,email,role,status)
		VALUES (?,?,?,?,?,?,'active')`,
	);
	insertMember.run(
		"membership-requester",
		ORG_ID,
		REQUESTER_USER_ID,
		REQUESTER_SUBJECT,
		"requester@tedix.test",
		"owner",
	);
	insertMember.run(
		"membership-approver",
		ORG_ID,
		APPROVER_USER_ID,
		APPROVER_SUBJECT,
		"approver@tedix.test",
		"admin",
	);
	const insertTedi = sqlite.prepare(
		"INSERT INTO tedis (id,organization_id,name,slug,status,mcp_capability_profile) VALUES (?,?,?,?,'active','standard')",
	);
	insertTedi.run(DESIGNATED_TEDI_ID, ORG_ID, "Designated", "designated");
	insertTedi.run(BYSTANDER_TEDI_ID, ORG_ID, "Bystander", "bystander");
	insertTedi.run(OTHER_ORG_TEDI_ID, OTHER_ORG_ID, "Elsewhere", "elsewhere");

	const facade = createD1Facade(sqlite);
	const base = {
		db: createDbClient(facade),
		env: { ENVIRONMENT: "test", DB: facade } as CloudflareEnv,
		url: new URL("https://api.tedix.test/rpc/work-approvals"),
	};
	const userClient = (identity: {
		userId: string;
		sub: string;
		role: "owner" | "admin";
		oidcScopes?: string[];
	}) =>
		createRouterClient(workApprovalsContractRouter, {
			context: {
				...base,
				authType: "user",
				headers: new Headers(),
				organizationId: ORG_ID,
				userId: identity.userId,
				userRole: identity.role,
				oidcScopes: identity.oidcScopes,
				user: {
					aud: "test",
					dct: "tenant-1",
					exp: 2,
					iat: 1,
					iss: "https://auth.tedix.test",
					permissions: [],
					roles: [],
					sub: identity.sub,
				},
			} as BaseContext,
		});
	/** Exactly what `HttpPlatformClient` sends over the runtime service binding. */
	const runtimeClient = (tediId: string, organizationId = ORG_ID) =>
		createRouterClient(workApprovalsContractRouter, {
			context: {
				...base,
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": organizationId,
					"X-Tedix-Tedi-Id": tediId,
					"X-Tedix-Caller": "brain-bridge",
					"X-Tedix-Caller-Source": "http-platform-client",
					"X-Tedix-Tedi-Scopes": TEDI_RUNTIME_SERVICE_BINDING_SCOPES.join(" "),
				}),
			} as BaseContext,
		});
	const requester = userClient({
		userId: REQUESTER_USER_ID,
		sub: REQUESTER_SUBJECT,
		role: "owner",
	});
	const proposeFor = (approver: { type: "user" | "tedi"; id: string }) =>
		requester.propose({
			workItemId: WORK_ITEM_ID,
			workItemVersion: 1,
			proposal: { operation: "admit_work_attempt" },
			authorityKey: "deploy:production",
			approverType: approver.type,
			approverId: approver.id,
			requestRationale: "Runtime scope proof",
			expiresAt: "2099-10-20T00:00:00.000Z",
		});
	return { sqlite, userClient, runtimeClient, requester, proposeFor };
}

describe("Work approvals through the tedi runtime service binding", () => {
	it("lets the designated tedi list and decide its own proposal", async () => {
		const { runtimeClient, proposeFor, sqlite } = fixture();
		const proposal = await proposeFor({ type: "tedi", id: DESIGNATED_TEDI_ID });
		const runtime = runtimeClient(DESIGNATED_TEDI_ID);

		const inbox = await runtime.listInbox({ limit: 10 });
		expect(inbox.data).toHaveLength(1);
		expect(inbox.data[0]).toMatchObject({
			canDecide: true,
			proposal: {
				id: proposal.id,
				approverType: "tedi",
				approverId: DESIGNATED_TEDI_ID,
			},
		});

		const receipt = await runtime.decide({
			proposalId: proposal.id,
			expectedProposalVersion: proposal.version,
			decision: "approved",
			rationale: "Designated runtime tedi reviewed the proposal",
		});
		expect(receipt.decision).toMatchObject({
			deciderType: "tedi",
			deciderId: DESIGNATED_TEDI_ID,
			decision: "approved",
		});
		const decisions = sqlite
			.prepare(
				"SELECT decider_type, decider_id FROM work_approval_decisions WHERE proposal_id = ?",
			)
			.all(proposal.id);
		expect(decisions).toEqual([
			{ decider_type: "tedi", decider_id: DESIGNATED_TEDI_ID },
		]);
	});

	it("refuses a same-organization tedi that is not the designated approver", async () => {
		const { runtimeClient, proposeFor, sqlite } = fixture();
		const proposal = await proposeFor({ type: "tedi", id: DESIGNATED_TEDI_ID });
		const bystander = runtimeClient(BYSTANDER_TEDI_ID);

		const inbox = await bystander.listInbox({ limit: 10 });
		expect(inbox.data).toEqual([]);
		await expect(
			bystander.decide({
				proposalId: proposal.id,
				expectedProposalVersion: proposal.version,
				decision: "approved",
				rationale: "Not my proposal",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_approval_decisions").get(),
		).toEqual({ n: 0 });
	});

	it("refuses a tedi designated for a user's proposal in the same organization", async () => {
		const { runtimeClient, proposeFor } = fixture();
		const proposal = await proposeFor({ type: "user", id: APPROVER_USER_ID });
		const runtime = runtimeClient(DESIGNATED_TEDI_ID);
		expect((await runtime.listInbox({ limit: 10 })).data).toEqual([]);
		await expect(
			runtime.decide({
				proposalId: proposal.id,
				expectedProposalVersion: proposal.version,
				decision: "approved",
				rationale: "A tedi cannot stand in for the named person",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("refuses another organization's tedi at request, inbox and decision time", async () => {
		const { runtimeClient, proposeFor, sqlite } = fixture();
		// Naming a tedi from another organization as approver is refused up front.
		await expect(
			proposeFor({ type: "tedi", id: OTHER_ORG_TEDI_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const proposal = await proposeFor({ type: "tedi", id: DESIGNATED_TEDI_ID });

		// The runtime binding names the organization; a tedi that is not active
		// there is refused before any proposal is read.
		const spoofedOrg = runtimeClient(OTHER_ORG_TEDI_ID, ORG_ID);
		await expect(spoofedOrg.listInbox({ limit: 10 })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			spoofedOrg.decide({
				proposalId: proposal.id,
				expectedProposalVersion: proposal.version,
				decision: "approved",
				rationale: "Cross-organization decision",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		// From its own organization the proposal is not visible or resolvable.
		const ownOrg = runtimeClient(OTHER_ORG_TEDI_ID, OTHER_ORG_ID);
		expect((await ownOrg.listInbox({ limit: 10 })).data).toEqual([]);
		await expect(
			ownOrg.decide({
				proposalId: proposal.id,
				expectedProposalVersion: proposal.version,
				decision: "approved",
				rationale: "Cross-organization decision",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_approval_decisions").get(),
		).toEqual({ n: 0 });
	});

	it("refuses a person without the messaging write scope even as designated approver", async () => {
		const { userClient, proposeFor, sqlite } = fixture();
		const proposal = await proposeFor({ type: "user", id: APPROVER_USER_ID });
		const readOnly = userClient({
			userId: APPROVER_USER_ID,
			sub: APPROVER_SUBJECT,
			role: "admin",
			oidcScopes: ["mcp:messaging.read"],
		});
		expect((await readOnly.listInbox({ limit: 10 })).data).toHaveLength(1);
		await expect(
			readOnly.decide({
				proposalId: proposal.id,
				expectedProposalVersion: proposal.version,
				decision: "approved",
				rationale: "Scope is missing",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_approval_decisions").get(),
		).toEqual({ n: 0 });
	});

	it("does not delegate proposal requests to the runtime", async () => {
		// `propose` needs `mcp:work.write`, which the runtime binding does not
		// delegate; the runtime platform client has no request path either.
		const { runtimeClient } = fixture();
		expect(TEDI_RUNTIME_SERVICE_BINDING_SCOPES).not.toContain("mcp:work.write");
		await expect(
			runtimeClient(DESIGNATED_TEDI_ID).propose({
				workItemId: WORK_ITEM_ID,
				workItemVersion: 1,
				proposal: { operation: "admit_work_attempt" },
				authorityKey: "deploy:production",
				approverType: "user",
				approverId: APPROVER_USER_ID,
				requestRationale: "Runtime request",
				expiresAt: "2099-10-20T00:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
