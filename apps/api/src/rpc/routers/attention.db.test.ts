import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "../../../../../packages/db/src/test/migrated-sqlite";
import { expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { attentionContractRouter } from "./attention";

it("bounds the full forwarded Deck read independently of inbox row count", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const orgId = "00000000-0000-4000-8000-000000000001";
	const workspaceId = "00000000-0000-4000-8000-000000000002";
	const gadgetId = "00000000-0000-4000-8000-000000000003";
	const revisionId = "00000000-0000-4000-8000-000000000004";
	sqlite
		.prepare(
			"INSERT INTO organizations(id,name,slug) VALUES (?,'Example','deck-example')",
		)
		.run(orgId);
	sqlite.exec(
		"INSERT INTO principal_identities(id,principal_type,principal_id,provider,issuer,subject) VALUES ('reader-identity','user','reader','descope','https://auth.tedix.dev/P2fictional','reader')",
	);
	sqlite
		.prepare(
			"INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status,kind) VALUES ('member',?,'reader','reader','reader@example.test','owner','active','human')",
		)
		.run(orgId);
	sqlite
		.prepare(
			"INSERT INTO os_workspaces(id,organization_id,name,created_by_kind,created_by_id) VALUES (?,?,'Work','user','reader')",
		)
		.run(workspaceId, orgId);
	sqlite
		.prepare(
			"INSERT INTO os_gadgets(id,organization_id,workspace_id,name,has_work_navigation,current_revision_id,created_by_kind,created_by_id) VALUES (?,?,?,'Decisions',1,?,'user','reader')",
		)
		.run(gadgetId, orgId, workspaceId, revisionId);
	sqlite
		.prepare(
			"INSERT INTO os_gadget_revisions(id,organization_id,gadget_id,revision,manifest,created_by_kind,created_by_id) VALUES (?,?,?,1,?,'user','reader')",
		)
		.run(
			revisionId,
			orgId,
			gadgetId,
			JSON.stringify({
				version: 1,
				entry: "tedix:app/decision-deck",
				navigation: { work: "deck" },
				config: { version: 1 },
			}),
		);
	sqlite
		.prepare(
			"INSERT INTO projects(id,org_id,name,key,created_at) VALUES ('00000000-0000-4000-8000-000000000005',?,'Reviews','REV','2026-01-01')",
		)
		.run(orgId);
	const insert = sqlite.prepare(
		"INSERT INTO work_interactions(id,org_id,project_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,status,created_at) VALUES (?,?,'00000000-0000-4000-8000-000000000005','question',?,'Choose a topic','user','reader','user','reader','open',?)",
	);
	const statements: string[] = [];
	const read = async () => {
		const binding = createD1Facade(sqlite, {
			onPrepare: (query) => statements.push(query),
		});
		const db = createDbClient(binding);
		const token = `e30.${btoa(JSON.stringify({ iss: "https://auth.tedix.dev/P2fictional", sub: "reader", email: "reader@example.test", exp: 4_000_000_000 }))}.signature`;
		return createRouterClient(attentionContractRouter, {
			context: {
				db,
				env: {
					DB: binding,
					ENVIRONMENT: "production",
					DESCOPE_PROJECT_ID: "P2fictional",
					AGENT_REVIEW_PROJECT_ID: "00000000-0000-4000-8000-000000000005",
				},
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Caller-Type": "mcp-edge-user",
					"X-Forwarded-Authorization": `Bearer ${token}`,
					"X-Tedix-Org-Id": orgId,
				}),
				serviceBindingPrincipal: "mcp-edge",
				url: new URL("https://api/rpc/attention/listDeckCards"),
			} as BaseContext,
		}).listDeckCards({ limit: 100, presentation: "stored" });
	};
	try {
		insert.run(
			crypto.randomUUID(),
			orgId,
			"Choose topic 0",
			"2026-01-01T00:00:00.000Z",
		);
		const first = await read();
		expect(first.complete).toBe(true);
		expect(first.cards).toHaveLength(1);
		expect(statements).toHaveLength(24);
		statements.length = 0;
		for (let i = 1; i < 20; i++)
			insert.run(
				crypto.randomUUID(),
				orgId,
				`Choose topic ${i}`,
				new Date(Date.parse("2026-01-01T00:00:00.000Z") + i).toISOString(),
			);
		const many = await read();
		expect(many.complete).toBe(true);
		expect(many.cards).toHaveLength(20);
		expect(statements).toHaveLength(23);
		for (const table of [
			"organization_members",
			"principal_identities",
			"projects",
		])
			expect(
				statements.filter((query) => query.includes(`from "${table}"`)),
			).toHaveLength(1);
		sqlite.exec("UPDATE organization_members SET status='deactivated'");
		await expect(read()).rejects.toMatchObject({ code: "FORBIDDEN" });
	} finally {
		sqlite.close();
	}
});
