import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { WorkspaceSkillDraftInputSchema } from "@tedix/api-contract/schemas/cognitive";
import { createDbClient } from "@tedix/db/client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { skillEntries } from "@tedix/db/schema/cognitive";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osWorkspaces,
	osWorkspaceResources,
	osWorkspaceSkillDraftGrants,
	osWorkspaceSkillDraftProposals,
} from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { tedis } from "@tedix/db/schema/tedis";
import { skillsRunWorkflow } from "./cognitive-skill-runs/run-start";

const runtime = vi.hoisted(() => vi.fn());
vi.mock("../../services/skill-runtime-client", () => ({
	callSkillRuntime: runtime,
}));
import type { BaseContext } from "../orpc";
import {
	skillsGetWorkspaceDraftGrant,
	skillsProposeWorkspaceRevision,
	skillsSetWorkspaceDraftGrant,
	skillsGetWorkspaceDraftProposal,
	skillsListWorkspaceDraftProposals,
	skillsWithdrawWorkspaceDraftProposal,
} from "./cognitive-workspace-skill-drafts";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const RESOURCE = "33333333-3333-4333-8333-333333333333";
const OTHER_RESOURCE = "44444444-4444-4444-8444-444444444444";
const TARGET = { workspaceId: WS, resourceId: RESOURCE };
const INPUT = {
	...TARGET,
	requestId: "55555555-5555-4555-8555-555555555555",
	expectedSourceRevision: 4,
	content: "# Research\n\nBetter draft instructions.",
	reason: "Clarify the research review steps.",
};
const EXPIRY = () => new Date(Date.now() + 86400_000).toISOString();

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			osWorkspaceResources,
			osWorkspaceSkillDraftGrants,
			osWorkspaceSkillDraftProposals,
			organizationMembers,
			skillEntries,
			auditEvents,
			tedis,
		),
	);
	sqlite.exec(`
		INSERT INTO tedis (id,organization_id,name,slug,status) VALUES ('research-tedi','org-fixture','Research helper','research-helper','active');
		INSERT INTO organization_members (id,organization_id,descope_user_id,email,role,kind,status) VALUES
		('m-owner','org-fixture','owner','owner@example.test','owner','human','active'),
		('m-agent','org-fixture','agent','agent@example.test','member','external_agent','active'),
		('m-other','org-fixture','other','other@example.test','member','human','active'),
		('m-agent-admin','org-fixture','agent-admin','agent-admin@example.test','admin','external_agent','active');
		INSERT INTO os_workspaces (id,organization_id,name,created_by_kind,created_by_id,created_at,updated_at) VALUES
		('${WS}','org-fixture','Research','user','owner','2026-01-01','2026-01-01'),('${OTHER_WS}','org-fixture','Other','user','owner','2026-01-01','2026-01-01');
		INSERT INTO skill_entries (id,organization_id,tedi_id,slug,title,content,files,mcp_app_bindings,lifecycle_state,revision,pace_layer) VALUES
		('source','org-fixture','research-tedi','research','Research','# Research','{"scripts/workflow.ts":"export default { async run(event, step) { return 1; } }"}','{}','active',4,'differentiation');
		INSERT INTO os_workspace_resources (id,organization_id,workspace_id,provider_id,connection_scope,resource_type,provider_resource_id,name,created_by_kind,created_by_id,created_at,updated_at) VALUES
		('${RESOURCE}','org-fixture','${WS}','tedix','tenant','skill','source','Research','user','owner','2026-01-01','2026-01-01'),
		('${OTHER_RESOURCE}','org-fixture','${OTHER_WS}','tedix','tenant','skill','source','Research elsewhere','user','owner','2026-01-01','2026-01-01');
	`);
	const facade = createD1Facade(sqlite);
	const db = createDbClient(facade) as BaseContext["db"];
	function client(
		sub = "agent",
		role = "member",
		overrides: Partial<BaseContext> = {},
	) {
		return createRouterClient(
			{
				get: skillsGetWorkspaceDraftGrant,
				set: skillsSetWorkspaceDraftGrant,
				propose: skillsProposeWorkspaceRevision,
				read: skillsGetWorkspaceDraftProposal,
				list: skillsListWorkspaceDraftProposals,
				withdraw: skillsWithdrawWorkspaceDraftProposal,
				run: skillsRunWorkflow,
			},
			{
				context: {
					authType: "user",
					user: { sub, roles: [role] },
					userRole: role,
					organizationId: "org-fixture",
					db,
					env: { DB: facade, ENVIRONMENT: "test" },
					headers: new Headers(),
					url: new URL("https://api.example.test/rpc/skills"),
					...overrides,
				} as BaseContext,
			},
		);
	}
	async function grant() {
		return client("owner", "owner").set({
			...TARGET,
			memberId: "m-agent",
			enabled: true,
			expiresAt: EXPIRY(),
		});
	}
	return { sqlite, client, grant };
}

describe("workspace skill draft grants", () => {
	it("lets a granted member create a separate draft while leaving the live skill intact", async () => {
		const { client, grant, sqlite } = fixture();
		await grant();
		const result = await client().propose({
			...INPUT,
			files: {
				"scripts/workflow.ts":
					"export default { async run(event, step) { return 2; } }",
			},
		});
		expect(result.proposal).toMatchObject({
			memberId: "m-agent",
			skillId: "source",
			sourceRevision: 4,
			status: "pending",
			baseContent: "# Research",
		});
		expect(result.humanActivationRequired).toBe(true);
		expect(result.proposal.id).toBe(INPUT.requestId);
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM skill_entries").get(),
		).toMatchObject({ n: 1 });
		expect(
			sqlite
				.prepare(
					"SELECT revision,content,lifecycle_state FROM skill_entries WHERE id='source'",
				)
				.get(),
		).toMatchObject({
			revision: 4,
			content: "# Research",
			lifecycle_state: "active",
		});
		expect(
			sqlite
				.prepare(
					"SELECT action FROM audit_events WHERE action='skill.workspace_draft.proposed'",
				)
				.get(),
		).toBeTruthy();
	});

	it("replays the same receipt after an uncertain response and conflicts on changed payload", async () => {
		const { client, grant, sqlite } = fixture();
		await grant();
		const first = await client().propose(INPUT);
		sqlite.exec("UPDATE skill_entries SET revision=5 WHERE id='source'");
		const replay = await client().propose(INPUT);
		expect(replay).toEqual(first);
		await expect(
			client().propose({
				...INPUT,
				content: "Changed under the same request key",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM os_workspace_skill_draft_proposals")
				.get(),
		).toMatchObject({ n: 1 });
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM audit_events WHERE action='skill.workspace_draft.proposed'",
				)
				.get(),
		).toMatchObject({ n: 1 });
	});

	it("keeps saved drafts out of the skill catalog and rejects canonical SKILL.md overrides before saving", async () => {
		const { client, grant, sqlite } = fixture();
		await grant();
		await expect(
			client().propose({
				...INPUT,
				files: {
					"SKILL.md":
						"---\ncapabilities:\n  schedule:\n    cron: 0 3 * * *\n---\nOverride",
				},
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM os_workspace_skill_draft_proposals")
				.get(),
		).toMatchObject({ n: 0 });
		await client().propose(INPUT);
		expect(
			sqlite
				.prepare("SELECT id FROM skill_entries WHERE id=?")
				.get(INPUT.requestId),
		).toBeUndefined();
		await expect(
			client("owner", "owner").run({
				tediId: "research-tedi",
				skillId: INPUT.requestId,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(runtime).not.toHaveBeenCalled();
	});

	it("reads back saved proposals, restricts peers, and withdraws only its own draft without deleting history", async () => {
		const { client, grant, sqlite } = fixture();
		await grant();
		await client().propose(INPUT);
		const ref = { ...TARGET, proposalId: INPUT.requestId };
		expect((await client().read(ref)).canWithdraw).toBe(true);
		expect((await client("owner", "owner").read(ref)).canWithdraw).toBe(false);
		await expect(client("other").read(ref)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(client("owner", "owner").withdraw(ref)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect((await client("other").list(TARGET)).proposals).toHaveLength(0);
		expect(
			(await client("owner", "owner").list(TARGET)).proposals,
		).toHaveLength(1);
		const result = await client().withdraw(ref);
		expect(result.proposal.status).toBe("withdrawn");
		expect((await client().withdraw(ref)).proposal.withdrawnAt).toBe(
			result.proposal.withdrawnAt,
		);
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM os_workspace_skill_draft_proposals")
				.get(),
		).toMatchObject({ n: 1 });
	});

	it("denies absent, expired, revoked and malformed grants", async () => {
		const { client, grant, sqlite } = fixture();
		await expect(client().propose(INPUT)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await grant();
		for (const update of [
			"expires_at='2000-01-01T00:00:00.000Z'",
			"expires_at='not-a-date'",
			"enabled=0",
		]) {
			sqlite.exec(`UPDATE os_workspace_skill_draft_grants SET ${update}`);
			await expect(client().propose(INPUT)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		}
	});

	it("binds access to the exact member, workspace, resource, organization and linked skill", async () => {
		const { client, grant, sqlite } = fixture();
		await grant();
		await expect(client("other").propose(INPUT)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			client().propose({
				...INPUT,
				workspaceId: OTHER_WS,
				resourceId: OTHER_RESOURCE,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client().propose({ ...INPUT, workspaceId: OTHER_WS }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			client("agent", "member", { organizationId: "another-org" }).propose(
				INPUT,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite.exec(
			"UPDATE os_workspace_skill_draft_grants SET skill_id='different-source'",
		);
		await expect(client().propose(INPUT)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("rejects inactive membership and removed resources even with a grant", async () => {
		const { client, grant, sqlite } = fixture();
		await grant();
		sqlite.exec(
			"UPDATE organization_members SET status='deactivated' WHERE id='m-agent'",
		);
		await expect(client().propose(INPUT)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		sqlite.exec(
			"UPDATE organization_members SET status='active' WHERE id='m-agent'",
		);
		sqlite.exec("UPDATE os_workspace_resources SET status='removed'");
		await expect(client().propose(INPUT)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("rejects stale source revisions and schedule changes without writing a draft", async () => {
		const { client, grant, sqlite } = fixture();
		await grant();
		await expect(
			client().propose({ ...INPUT, expectedSourceRevision: 3 }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			client().propose({
				...INPUT,
				content:
					'---\ncapabilities:\n  schedule:\n    cron: "0 3 * * *"\n---\n# Research',
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM skill_entries").get(),
		).toMatchObject({ n: 1 });
	});

	it("never accepts activation, permission, tedi or app changes in a draft payload", () => {
		for (const extra of [
			{ lifecycleState: "active" },
			{ tediId: "other" },
			{ appId: "other" },
			{ permissions: ["os:approve"] },
			{ validate: "skip" },
		]) {
			expect(
				WorkspaceSkillDraftInputSchema.safeParse({ ...INPUT, ...extra })
					.success,
			).toBe(false);
		}
	});

	it("requires actual human administrator membership to grant, not token claims or agent identity", async () => {
		const { client } = fixture();
		const input = {
			...TARGET,
			memberId: "m-agent",
			enabled: true,
			expiresAt: EXPIRY(),
		};
		await expect(client().set(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(client("agent", "owner").set(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			client("agent-admin", "admin").set(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client("owner", "owner", {
				externalAgentPrincipalId: "agent-principal",
			}).set(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("bounds grants to active same-org members and at most thirty days", async () => {
		const { client } = fixture();
		const owner = client("owner", "owner");
		await expect(
			owner.set({
				...TARGET,
				memberId: "missing",
				enabled: true,
				expiresAt: EXPIRY(),
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			owner.set({
				...TARGET,
				memberId: "m-agent",
				enabled: true,
				expiresAt: new Date(Date.now() + 31 * 86400_000).toISOString(),
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			owner.set({
				...TARGET,
				memberId: "m-agent",
				enabled: true,
				expiresAt: "2000-01-01T00:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("returns only the caller's grant and makes revocation effective on the next request", async () => {
		const { client, grant } = fixture();
		await grant();
		expect((await client().get(TARGET)).grant?.memberId).toBe("m-agent");
		expect((await client("other").get(TARGET)).grant).toBeNull();
		await client("owner", "owner").set({
			...TARGET,
			memberId: "m-agent",
			enabled: false,
			expiresAt: EXPIRY(),
		});
		await expect(client().propose(INPUT)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
