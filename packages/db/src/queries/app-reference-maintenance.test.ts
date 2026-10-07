import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import { organizations } from "../schema/organizations";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	AGGREGATE_APPS_PATH,
	applyAppReferenceWrites,
	CONNECTION_PROVIDER_ID_PATH,
	listAppSlugCandidates,
	listAppToolsByConnectionProvider,
	listAppsLinkingToApp,
	listAppsReferencingConnectionProvider,
	listAppsWithAggregateEntriesMissingAppId,
	listCatalogAppsByScanConnection,
} from "./app-reference-maintenance";

const ACME = "org-acme";
const SAMPLE = "org-sample";
const BASE = "00000000-0000-4000-8000-0000000000b1";
const PROXY = "00000000-0000-4000-8000-0000000000b2";
const GATEWAY = "00000000-0000-4000-8000-0000000000b3";
const OTHER = "00000000-0000-4000-8000-0000000000b4";

function fixture(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	for (const table of [organizations, appCatalog, apps, appTools]) {
		sqlite.exec(schemaDdl(table));
	}
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES
			('${ACME}', 'Acme', 'acme'), ('${SAMPLE}', 'Sample', 'sample');
	`);
	return {
		db: createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 })),
		sqlite,
	};
}

function insertApp(
	sqlite: DatabaseSync,
	id: string,
	organizationId: string,
	slug: string,
	metadata: unknown,
) {
	sqlite
		.prepare(
			"INSERT INTO apps (id, organization_id, name, slug, metadata) VALUES (?, ?, ?, ?, ?)",
		)
		.run(
			id,
			organizationId,
			slug,
			slug,
			metadata === undefined ? null : JSON.stringify(metadata),
		);
}

function metadataOf(sqlite: DatabaseSync, id: string): unknown {
	const row = sqlite
		.prepare("SELECT metadata FROM apps WHERE id = ?")
		.get(id) as { metadata: string | null };
	return row.metadata === null ? null : JSON.parse(row.metadata);
}

describe("app reference maintenance queries", () => {
	it("lists only apps with aggregate entries lacking appId, scoped by org", async () => {
		const { db, sqlite } = fixture();
		insertApp(sqlite, BASE, SAMPLE, "mailer", { mcpConfig: {} });
		insertApp(sqlite, PROXY, ACME, "acme-mailer", {
			mcpConfig: { aggregateApps: [{ slug: "mailer" }] },
		});
		insertApp(sqlite, GATEWAY, ACME, "acme-unified", {
			mcpConfig: {
				aggregateApps: [{ slug: "acme-mailer", appId: PROXY }],
				inactiveAggregateApps: [{ slug: "mailer" }],
			},
		});
		insertApp(sqlite, OTHER, SAMPLE, "sample-unified", {
			mcpConfig: { aggregateApps: [{ slug: "mailer", appId: BASE }] },
		});
		sqlite.exec(
			`INSERT INTO apps (id, organization_id, name, slug, metadata) VALUES ('broken', '${SAMPLE}', 'b', 'broken', 'not json')`,
		);

		const all = await listAppsWithAggregateEntriesMissingAppId(db);
		expect(all.map((row) => row.id)).toEqual([PROXY, GATEWAY]);
		expect(all[1]?.inactiveAggregateAppsJson).toBe('[{"slug":"mailer"}]');
		const sample = await listAppsWithAggregateEntriesMissingAppId(db, {
			organizationId: SAMPLE,
		});
		expect(sample).toEqual([]);
	});

	it("resolves slugs globally and exactly, like the gateway", async () => {
		const { db, sqlite } = fixture();
		insertApp(sqlite, BASE, SAMPLE, "mailer", undefined);
		insertApp(sqlite, OTHER, ACME, "mailer", undefined);
		insertApp(sqlite, PROXY, ACME, "acme-mailer", undefined);
		const slugs = Array.from({ length: 120 }, (_, i) => `missing-${i}`);
		const candidates = await listAppSlugCandidates(db, [
			...slugs,
			"mailer",
			"acme-mailer",
			"MAILER",
		]);
		expect(candidates.get("mailer")?.map((c) => c.id)).toEqual([BASE, OTHER]);
		expect(candidates.get("acme-mailer")?.map((c) => c.organizationId)).toEqual(
			[ACME],
		);
		expect(candidates.has("MAILER")).toBe(false);
	});

	it("finds cross-org linkers by appId or slug", async () => {
		const { db, sqlite } = fixture();
		insertApp(sqlite, BASE, SAMPLE, "mailer", undefined);
		insertApp(sqlite, PROXY, ACME, "acme-mailer", {
			mcpConfig: { aggregateApps: [{ slug: "mailer" }] },
		});
		insertApp(sqlite, GATEWAY, ACME, "acme-unified", {
			mcpConfig: { aggregateApps: [{ slug: "old-name", appId: BASE }] },
		});
		insertApp(sqlite, OTHER, SAMPLE, "unrelated", {
			mcpConfig: { aggregateApps: [{ slug: "something" }] },
		});
		const linkers = await listAppsLinkingToApp(db, {
			appId: BASE,
			slug: "mailer",
		});
		expect(linkers.map((row) => row.id)).toEqual([PROXY, GATEWAY]);
	});

	it("finds every connection-provider reference", async () => {
		const { db, sqlite } = fixture();
		insertApp(sqlite, BASE, SAMPLE, "mailer", {
			mcpConfig: { openApiSync: { connectionProviderId: "mailer-2" } },
		});
		insertApp(sqlite, PROXY, ACME, "acme-mailer", {
			mcpConfig: { connectionProviderId: "mailer-2" },
		});
		insertApp(sqlite, GATEWAY, ACME, "acme-unified", {
			mcpConfig: {
				aggregateApps: [
					{ slug: "acme-mailer", connectionProviderId: "mailer-2" },
				],
			},
		});
		insertApp(sqlite, OTHER, SAMPLE, "other", {
			mcpConfig: { connectionProviderId: "mailer-3" },
		});
		sqlite.exec(`
			INSERT INTO app_catalog (id, name, connector_type, last_synced_at, scan_connection_id, scan_organization_id)
				VALUES ('cat-1', 'Mailer', 'mcp', 'now', 'mailer-2', '${ACME}'),
				       ('cat-2', 'Other', 'mcp', 'now', 'mailer-3', NULL);
			INSERT INTO app_tools (id, app_id, tool_type_id, tool_id, title, input_schema, config)
				VALUES ('tool-1', '${PROXY}', 'rpc', 'send_email', 'Send', '{}', '{"auth":{"type":"connection","connectionId":"mailer-2"}}'),
				       ('tool-2', '${BASE}', 'rpc', 'list_email', 'List', '{}', '{"auth":{"type":"connection","connectionId":"mailer-3"}}');
		`);
		expect(
			(await listAppsReferencingConnectionProvider(db, "mailer-2")).map(
				(row) => row.id,
			),
		).toEqual([BASE, PROXY, GATEWAY]);
		expect(
			(
				await listAppsReferencingConnectionProvider(db, "mailer-2", {
					organizationId: ACME,
				})
			).map((row) => row.id),
		).toEqual([PROXY, GATEWAY]);
		expect(
			(await listCatalogAppsByScanConnection(db, "mailer-2")).map((r) => r.id),
		).toEqual(["cat-1"]);
		expect(
			await listCatalogAppsByScanConnection(db, "mailer-2", {
				organizationId: SAMPLE,
			}),
		).toEqual([]);
		expect(await listAppToolsByConnectionProvider(db, "mailer-2")).toEqual([
			{
				id: "tool-1",
				appId: PROXY,
				organizationId: ACME,
				toolId: "send_email",
				connectionId: "mailer-2",
			},
		]);
	});

	it("applies compare-and-set writes and leaves other metadata intact", async () => {
		const { db, sqlite } = fixture();
		insertApp(sqlite, PROXY, ACME, "acme-mailer", {
			branding: { color: "blue" },
			mcpConfig: {
				connectionProviderId: "mailer-2",
				aggregateApps: [{ slug: "mailer" }],
			},
		});
		const [row] = await listAppsWithAggregateEntriesMissingAppId(db);
		await applyAppReferenceWrites(db, [
			{
				kind: "app_metadata",
				appId: PROXY,
				path: AGGREGATE_APPS_PATH,
				before: row?.aggregateAppsJson ?? null,
				after: JSON.stringify([{ slug: "mailer", appId: BASE }]),
				afterIsJson: true,
			},
			{
				kind: "app_metadata",
				appId: PROXY,
				path: CONNECTION_PROVIDER_ID_PATH,
				before: "mailer-2",
				after: "mailer-3",
				afterIsJson: false,
			},
			{
				kind: "app_slug",
				appId: PROXY,
				before: "acme-mailer",
				after: "acme-mail",
			},
		]);
		expect(metadataOf(sqlite, PROXY)).toEqual({
			branding: { color: "blue" },
			mcpConfig: {
				connectionProviderId: "mailer-3",
				aggregateApps: [{ slug: "mailer", appId: BASE }],
			},
		});
		expect(
			sqlite.prepare("SELECT slug FROM apps WHERE id = ?").get(PROXY),
		).toEqual({ slug: "acme-mail" });
	});

	it("rolls back the whole batch when any row no longer matches its plan", async () => {
		const { db, sqlite } = fixture();
		insertApp(sqlite, PROXY, ACME, "acme-mailer", {
			mcpConfig: { connectionProviderId: "mailer-2" },
		});
		insertApp(sqlite, GATEWAY, ACME, "acme-unified", {
			mcpConfig: { connectionProviderId: "mailer-9" },
		});
		const before = metadataOf(sqlite, PROXY);
		await expect(
			applyAppReferenceWrites(db, [
				{
					kind: "app_metadata",
					appId: PROXY,
					path: CONNECTION_PROVIDER_ID_PATH,
					before: "mailer-2",
					after: "mailer-3",
					afterIsJson: false,
				},
				{
					kind: "app_metadata",
					appId: GATEWAY,
					path: CONNECTION_PROVIDER_ID_PATH,
					before: "mailer-2",
					after: "mailer-3",
					afterIsJson: false,
				},
			]),
		).rejects.toThrow(/malformed JSON/i);
		expect(metadataOf(sqlite, PROXY)).toEqual(before);
	});

	it("refuses a slug rename onto a slug claimed after planning", async () => {
		const { db, sqlite } = fixture();
		insertApp(sqlite, PROXY, ACME, "acme-mailer", undefined);
		insertApp(sqlite, OTHER, SAMPLE, "acme-mail", undefined);
		await expect(
			applyAppReferenceWrites(db, [
				{
					kind: "app_slug",
					appId: PROXY,
					before: "acme-mailer",
					after: "acme-mail",
				},
			]),
		).rejects.toThrow(/malformed JSON/i);
		expect(
			sqlite.prepare("SELECT slug FROM apps WHERE id = ?").get(PROXY),
		).toEqual({ slug: "acme-mailer" });
	});

	it("rewrites catalog scan connections and tool connection ids", async () => {
		const { db, sqlite } = fixture();
		insertApp(sqlite, PROXY, ACME, "acme-mailer", undefined);
		sqlite.exec(`
			INSERT INTO app_catalog (id, name, connector_type, last_synced_at, scan_connection_id)
				VALUES ('cat-1', 'Mailer', 'mcp', 'now', 'mailer-2');
			INSERT INTO app_tools (id, app_id, tool_type_id, tool_id, title, input_schema, config)
				VALUES ('tool-1', '${PROXY}', 'rpc', 'send_email', 'Send', '{}', '{"auth":{"type":"connection","connectionId":"mailer-2"},"x":1}');
		`);
		await applyAppReferenceWrites(db, [
			{
				kind: "catalog_scan_connection",
				catalogAppId: "cat-1",
				before: "mailer-2",
				after: "mailer-3",
			},
			{
				kind: "app_tool_connection",
				toolRowId: "tool-1",
				before: "mailer-2",
				after: "mailer-3",
			},
		]);
		expect(
			sqlite
				.prepare(
					"SELECT scan_connection_id FROM app_catalog WHERE id = 'cat-1'",
				)
				.get(),
		).toEqual({ scan_connection_id: "mailer-3" });
		const tool = sqlite
			.prepare("SELECT config FROM app_tools WHERE id = 'tool-1'")
			.get() as { config: string };
		expect(JSON.parse(tool.config)).toEqual({
			auth: { type: "connection", connectionId: "mailer-3" },
			x: 1,
		});
	});
});
