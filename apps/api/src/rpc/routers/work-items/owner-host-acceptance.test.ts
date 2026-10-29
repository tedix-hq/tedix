import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import {
	externalAgentPrincipals,
	externalAgentSessions,
} from "@tedix/db/schema/external-agent-identity";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { workItemAcceptanceActor } from "./policy-helpers";

function fixture(scopes: string[] = ["mcp:work.admin"]) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			externalAgentPrincipals,
			externalAgentSessions,
			organizationMembers,
		),
	);
	sqlite.exec(`
		INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,role,status)
		VALUES('member','org','owner','subject','owner@example.test','owner','active');
		INSERT INTO external_agent_principals(id,organization_id,key,display_name,credential_binding_type,credential_binding_id,created_by_type,created_by_id,created_at,updated_at)
		VALUES('principal','org','owner-host-example','Plugin hosts of owner','owner_user','owner','user','owner','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z');
		INSERT INTO external_agent_sessions(id,organization_id,principal_id,external_session_key,harness,harness_version,model_provider,model_id,model_version,identity_source,credit_eligible,started_at,last_seen_at)
		VALUES('session','org','principal','codex:example:owner-host','codex','1','openai','example','1','explicit',0,'2026-10-29T00:00:00Z','2026-10-29T00:00:00Z');
	`);
	const context = {
		db: createDbClient(createD1Facade(sqlite)),
		authType: "user",
		organizationId: "org",
		user: { sub: "subject", scopes },
		userId: "owner",
		ownerHostSessionId: "session",
	} as BaseContext;
	return { sqlite, context };
}

describe("owner-host Work acceptance", () => {
	it.each(["owner", "admin"])(
		"uses the verified %s grant and preserves agent attribution",
		async (role) => {
			const { sqlite, context } = fixture();
			sqlite.prepare("UPDATE organization_members SET role=?").run(role);
			await expect(workItemAcceptanceActor(context, "org")).resolves.toEqual({
				type: "external_agent",
				id: "principal",
			});
		},
	);

	it.each([
		{ scopes: [] },
		{ scopes: ["mcp:work.write"] },
		{ scopes: ["platform:admin"] },
		{ scopes: ["work:accept"] },
	])(
		"refuses an owner-host without the MCP Work admin grant: $scopes",
		async ({ scopes }) => {
			const { context } = fixture(scopes);
			await expect(
				workItemAcceptanceActor(context, "org"),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		},
	);

	it.each([
		"UPDATE organization_members SET role='member'",
		"UPDATE organization_members SET status='suspended'",
		"UPDATE external_agent_principals SET status='retired'",
		"UPDATE external_agent_sessions SET status='ended'",
		"UPDATE external_agent_principals SET credential_binding_id='another-owner'",
	])("rechecks current membership and session: %s", async (sql) => {
		const { sqlite, context } = fixture();
		sqlite.exec(sql);
		await expect(workItemAcceptanceActor(context, "org")).rejects.toThrow();
	});

	it("rejects a session from another organization", async () => {
		const { context } = fixture();
		await expect(
			workItemAcceptanceActor(context, "another-org"),
		).rejects.toThrow();
	});

	it("keeps ordinary human owner acceptance independent of token scopes", async () => {
		const { context } = fixture([]);
		context.ownerHostSessionId = undefined;
		await expect(workItemAcceptanceActor(context, "org")).resolves.toEqual({
			type: "user",
			id: "owner",
		});
	});
});
