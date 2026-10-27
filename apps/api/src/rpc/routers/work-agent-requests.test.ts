import "./external-agent-identity";
import "./tedis/create";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { workApprovalsContractRouter } from "./work-approvals";

vi.mock("./connections/provider-registration", () => ({
	collectReferencedProviders: vi.fn(async () => ({
		ids: new Set(["example-provider"]),
	})),
}));
vi.mock("./connections/discovery-user", () => ({
	readConnectionProviders: vi.fn(async () => ({
		data: [
			{
				appId: "example-provider",
				connectionType: "oauth",
				registrationMode: "cimd",
				accountMode: "multiple",
				supportedScopes: ["tenant"],
				availableAccountModes: ["single", "multiple"],
			},
		],
	})),
}));

beforeAll(() => {
	createMigratedSqlite();
});

const ORG = "00000000-0000-4000-8000-000000000201";
const WORK = "00000000-0000-4000-8000-000000000202";
const KEY = "00000000-0000-4000-8000-000000000203";
const labels = {
	ownerUserId: "requester",
	ownerTeam: "Research",
	justification: "Research approved sources",
	dataSensitivity: "confidential" as const,
};

function fixture() {
	const sqlite = createMigratedSqlite();
	sqlite
		.prepare("INSERT INTO organizations(id,name,slug,metadata) VALUES(?,?,?,?)")
		.run(
			ORG,
			"Example",
			"example",
			JSON.stringify({ agentRequestApprovals: { approver: "org_admin" } }),
		);
	sqlite.exec(
		`INSERT INTO users(id,email) VALUES('requester','requester@example.test'),('approver','approver@example.test');`,
	);
	const member = sqlite.prepare(
		"INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status,role) VALUES(?,?,?,?,?,'active',?)",
	);
	member.run(
		"member-requester",
		ORG,
		"requester-sub",
		"requester",
		"requester@example.test",
		"member",
	);
	member.run(
		"member-approver",
		ORG,
		"approver-sub",
		"approver",
		"approver@example.test",
		"admin",
	);
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES(?,?,'Request a resource','accepted','maintenance','2099-01-01T00:00:00.000Z','revision','2026-10-27T07:00:00.000Z')",
		)
		.run(WORK, ORG);
	sqlite
		.prepare(
			"INSERT INTO api_keys(id,organization_id,name,key_hash,key_preview,status) VALUES(?,?,'Example','fictional-hash','fictional','active')",
		)
		.run(KEY, ORG);
	sqlite.exec(`
  INSERT INTO billing_plan_versions(id,plan_key,version,status,name,currency,included_monthly_tokens,max_tedis,max_cron_jobs_per_tedi,max_iterations_per_task,default_daily_token_limit,default_daily_message_limit,effective_at,created_at)
  VALUES('test-plan','example',1,'active','Example','eur',1000,5,5,20,100,10,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
 `);
	sqlite
		.prepare(
			"INSERT INTO billing_accounts(organization_id,plan_version_id,status,billing_mode,period_start,period_end,created_at,updated_at) VALUES(?,'test-plan','active','external','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
		)
		.run(ORG);
	const facade = createD1Facade(sqlite);
	const db = createDbClient(facade);
	const client = (id: string, role: "member" | "admin") =>
		createRouterClient(workApprovalsContractRouter, {
			context: {
				db,
				organizationId: ORG,
				authType: "user",
				userId: id,
				userRole: role,
				env: { ENVIRONMENT: "test", DB: facade } as CloudflareEnv,
				headers: new Headers(),
				url: new URL("https://api.example.test/rpc/work-approvals"),
				user: {
					sub: `${id}-sub`,
					aud: "test",
					dct: "tenant",
					exp: 2,
					iat: 1,
					iss: "https://auth.example.test",
					permissions: [],
					roles: [],
				},
			} as BaseContext,
		});
	const requester = client("requester", "member");
	const approver = client("approver", "admin");
	const propose = (
		action: "agent.create" | "agent.connect" | "resource.grant",
		proposal: Record<string, JsonValue>,
	) =>
		requester.propose({
			workItemId: WORK,
			workItemVersion: 1,
			action,
			authorityKey: action,
			proposal: { ...labels, ...proposal },
			approverType: "user",
			approverId: "approver",
			requestRationale: labels.justification,
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
	const decide = (id: string, decision: "approved" | "rejected" = "approved") =>
		approver.decide({
			proposalId: id,
			expectedProposalVersion: 1,
			decision,
			rationale: "Reviewed owner, justification and sensitivity",
		});
	return { sqlite, requester, approver, propose, decide };
}

describe("agent request carry-out", () => {
	it("rejects unknown providers, credential bindings and foreign account slots", async () => {
		const { propose } = fixture();
		await expect(
			propose("agent.connect", {
				kind: "connection",
				providerId: "foreign-provider",
				label: "Research",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			propose("agent.create", {
				kind: "external_agent",
				key: "research",
				displayName: "Research",
				credentialBindingId: "00000000-0000-4000-8000-000000000299",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			propose("resource.grant", {
				kind: "connection_grant",
				providerId: "example-provider",
				connectionInstanceId: "00000000-0000-4000-8000-000000000299",
				policy: { mode: "all" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("creates a standard tedi with the approved owner and labels", async () => {
		const { sqlite, propose, decide } = fixture();
		const proposal = await propose("agent.create", {
			kind: "tedi",
			name: "Research",
			slug: "research",
		});
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM tedis").get()?.count,
		).toBe(0);
		const result = await decide(proposal.id);
		expect(result.proposal.execution).toMatchObject({ status: "succeeded" });
		expect(
			sqlite
				.prepare(
					"SELECT owner_user_id,owner_team,justification,data_sensitivity,mcp_capability_profile FROM tedis",
				)
				.get(),
		).toMatchObject({
			owner_user_id: "requester",
			owner_team: "Research",
			justification: labels.justification,
			data_sensitivity: "confidential",
			mcp_capability_profile: "standard",
		});
	});
	it("keeps connection consumers denied until a separate grant is approved", async () => {
		const { sqlite, propose, decide } = fixture();
		const setup = await propose("agent.connect", {
			kind: "connection",
			providerId: "example-provider",
			label: "Research",
		});
		await decide(setup.id);
		const metadata = () =>
			JSON.parse(
				String(
					sqlite
						.prepare("SELECT metadata FROM organizations WHERE id=?")
						.get(ORG)?.metadata,
				),
			);
		const deny = JSON.stringify(metadata());
		expect(deny).toContain('"mode":"selected"');
		const grant = await propose("resource.grant", {
			kind: "connection_grant",
			providerId: "example-provider",
			connectionInstanceId: setup.id,
			policy: { mode: "all" },
		});
		expect(JSON.stringify(metadata())).toBe(deny);
		expect((await decide(grant.id)).proposal.execution).toMatchObject({
			status: "succeeded",
			resourceId: setup.id,
		});
		expect(JSON.stringify(metadata())).toContain('"mode":"all"');
	});

	it("registers an external agent only after approval and retains ownership labels", async () => {
		const { sqlite, approver, propose, decide } = fixture();
		const proposal = await propose("agent.create", {
			kind: "external_agent",
			key: "research",
			displayName: "Research",
			credentialBindingId: KEY,
		});
		expect(
			sqlite
				.prepare("SELECT count(*) AS count FROM external_agent_principals")
				.get()?.count,
		).toBe(0);
		expect(
			(await approver.listInbox({ proposalId: proposal.id })).data[0]?.proposal
				.proposal,
		).toMatchObject(labels);
		const result = await decide(proposal.id);
		expect(result.proposal.execution).toMatchObject({ status: "succeeded" });
		const principal = sqlite
			.prepare("SELECT id, metadata FROM external_agent_principals")
			.get();
		expect(principal?.id).toBe(result.proposal.execution?.resourceId);
		expect(JSON.parse(String(principal?.metadata))).toMatchObject({
			...labels,
			approvalProposalId: proposal.id,
		});
		await expect(decide(proposal.id)).rejects.toThrow(/resolvable/);
		expect(
			sqlite
				.prepare("SELECT count(*) AS count FROM external_agent_principals")
				.get()?.count,
		).toBe(1);
	});

	it("leaves a rejected external-agent request without a principal", async () => {
		const { sqlite, propose, decide } = fixture();
		const proposal = await propose("agent.create", {
			kind: "external_agent",
			key: "research",
			displayName: "Research",
			credentialBindingId: KEY,
		});
		expect((await decide(proposal.id, "rejected")).proposal.status).toBe(
			"rejected",
		);
		expect(
			sqlite
				.prepare("SELECT count(*) AS count FROM external_agent_principals")
				.get()?.count,
		).toBe(0);
	});

	it("authorizes a labelled connection slot without claiming provider consent", async () => {
		const { sqlite, propose, decide } = fixture();
		const proposal = await propose("agent.connect", {
			kind: "connection",
			providerId: "example-provider",
			label: "Research",
		});
		const result = await decide(proposal.id);
		expect(result.proposal.execution).toMatchObject({
			status: "succeeded",
			resourceId: proposal.id,
			message: expect.stringContaining("must finish provider consent"),
		});
		expect(
			sqlite
				.prepare(
					"SELECT owner_team,justification,data_sensitivity,token_ids,token_sub FROM connection_instances",
				)
				.get(),
		).toMatchObject({
			owner_team: "Research",
			justification: labels.justification,
			data_sensitivity: "confidential",
			token_ids: "[]",
			token_sub: null,
		});
	});

	it("records failed execution separately when the credential is revoked after request", async () => {
		const { sqlite, propose, decide } = fixture();
		const proposal = await propose("agent.create", {
			kind: "external_agent",
			key: "research",
			displayName: "Research",
			credentialBindingId: KEY,
		});
		sqlite.prepare("UPDATE api_keys SET status='revoked' WHERE id=?").run(KEY);
		const result = await decide(proposal.id);
		expect(result.proposal).toMatchObject({
			status: "approved",
			execution: { status: "failed" },
		});
		expect(
			sqlite
				.prepare("SELECT count(*) AS count FROM external_agent_principals")
				.get()?.count,
		).toBe(0);
	});
});
