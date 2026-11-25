import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "../../../../../packages/db/src/test/migrated-sqlite";
import { expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { attentionContractRouter } from "./attention";
import { workspaceOutputFixture } from "../../../test/workspace-output-fixture";

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
				config: {
					version: 1,
					factorySources: [
						{
							label: "Inbox",
							workspaceId,
							cardSheetPrefix: "Cards",
							maxRuns: 3,
							doIt: "approve",
							columns: {
								type: "Type",
								source: "Source",
								why: "Why",
								useful: "Useful",
								reason: "Reason",
								done: "Done",
							},
						},
					],
				},
			}),
		);
	sqlite
		.prepare(
			"INSERT INTO projects(id,org_id,name,key,created_at) VALUES ('00000000-0000-4000-8000-000000000005',?,'Reviews','REV','2026-01-01')",
		)
		.run(orgId);
	const sourceWorkId = "00000000-0000-4000-8000-000000000006";
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,version,admission_spec_revision,created_at) VALUES (?,?,'Source','accepted',1,'revision','2025-01-01')",
		)
		.run(sourceWorkId, orgId);
	sqlite
		.prepare(
			"INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,author_id,body,created_at) VALUES ('new-facts',?,?,'user','reader','New facts to review','2026-02-01')",
		)
		.run(orgId, sourceWorkId);
	const store = workspaceOutputFixture(sqlite, { coreSchemaExists: true });
	const factoryIds = Array.from({ length: 3 }, () => crypto.randomUUID());
	for (const id of factoryIds) {
		const revision = crypto.randomUUID();
		store.objectSql
			.prepare(
				"INSERT INTO os_outputs(id,organization_id,workspace_id,kind,title,current_revision_id,created_by_kind,created_by_id,created_at,updated_at) VALUES (?,?,?,'sheet',?,?, 'user','reader','2026-01-01','2026-01-01')",
			)
			.run(id, orgId, workspaceId, `Cards ${id}`, revision);
		store.objectSql
			.prepare(
				"INSERT INTO os_output_revisions(id,organization_id,output_id,revision,content,access_envelope,created_by_kind,created_by_id,created_at) VALUES (?,?,?,1,?,?,'user','reader','2026-01-01')",
			)
			.run(
				revision,
				orgId,
				id,
				JSON.stringify({
					kind: "sheet",
					columns: ["Type", "Source", "Why", "Useful", "Reason", "Done"],
					rows: [
						["opportunity", "A conversation", "Worth reviewing", "", "", ""],
					],
				}),
				'{"version":1,"sources":[]}',
			);
	}
	const background: Promise<unknown>[] = [];
	const refresh = store.runtime.refreshOutputProjection.bind(store.runtime);
	store.runtime.refreshOutputProjection = (...args) => {
		const work = refresh(...args);
		background.push(work);
		return work;
	};
	const insert = sqlite.prepare(
		`INSERT INTO work_interactions(id,org_id,project_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,status,created_at,metadata) VALUES (?,?,'00000000-0000-4000-8000-000000000005','question',?,'Choose a topic','user','reader','user','reader','open',?,'{"decisionSources":[{"kind":"work","id":"00000000-0000-4000-8000-000000000006","version":1,"commentCount":0}]}')`,
	);
	const statements: string[] = [];
	const read = async () => {
		const binding = createD1Facade(sqlite, {
			onPrepare: (query) => statements.push(query),
		});
		const db = createDbClient(binding);
		const token = `e30.${btoa(JSON.stringify({ iss: "https://auth.tedix.dev/P2fictional", sub: "reader", email: "reader@example.test", exp: 4_000_000_000 }))}.signature`;
		const result = await createRouterClient(attentionContractRouter, {
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
		await Promise.all(background.splice(0));
		return result;
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
		expect(first.cards).toHaveLength(4);
		expect(statements).toHaveLength(28);
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
		expect(many.cards).toHaveLength(23);
		expect(statements).toHaveLength(27);
		expect(
			many.cards
				.filter((card) => card.factory)
				.map((card) => card.factory?.outputId)
				.sort(),
		).toEqual(factoryIds.sort());
		expect(
			statements.filter(
				(query) =>
					query.startsWith('select "id", "organization_id", "name"') &&
					query.includes('from "os_workspaces"'),
			),
		).toHaveLength(2);
		expect(
			statements.filter((query) =>
				query.includes('from "workspace_output_index"'),
			),
		).toHaveLength(0);
		for (const table of [
			"organization_members",
			"principal_identities",
			"projects",
		])
			expect(
				statements.filter((query) => query.includes(`from "${table}"`)),
			).toHaveLength(1);
		store.objectSql.exec("UPDATE os_output_revisions SET access_envelope=NULL");
		await expect(read()).rejects.toMatchObject({ code: "FORBIDDEN" });
		store.objectSql.exec(
			`UPDATE os_output_revisions SET access_envelope='{"version":1,"sources":[]}'`,
		);
		sqlite.exec("UPDATE organization_members SET status='deactivated'");
		await expect(read()).rejects.toMatchObject({ code: "FORBIDDEN" });
	} finally {
		sqlite.close();
	}
});
