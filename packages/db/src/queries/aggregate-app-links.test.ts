import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { aggregateAppEntryMatches } from "./aggregate-app-links";
import { deleteApp } from "./app-records";
import { installFromCatalog } from "./catalog/install";

/**
 * Apps link to each other by id; slug is a display name. These tests run the
 * production query path against a real in-memory SQLite engine through the D1
 * facade, which rejects `BEGIN` and duplicate output column names.
 */

const ACME_ORG = "10000000-0000-4000-8000-000000000001";
const SAMPLE_ORG = "10000000-0000-4000-8000-000000000002";
const PLATFORM_ORG = "10000000-0000-4000-8000-000000000003";

function realDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(appCatalog, apps));
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

function insertApp(
	sqlite: DatabaseSync,
	row: {
		id: string;
		organizationId: string;
		slug: string;
		catalogAppId?: string | null;
		sourceAppId?: string | null;
		metadata?: unknown;
	},
) {
	sqlite
		.prepare(
			`INSERT INTO apps (id, organization_id, name, slug, catalog_app_id, source_app_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			row.id,
			row.organizationId,
			row.slug,
			row.slug,
			row.catalogAppId ?? null,
			row.sourceAppId ?? null,
			row.metadata === undefined ? null : JSON.stringify(row.metadata),
		);
}

function metadataOf(sqlite: DatabaseSync, id: string) {
	const row = sqlite
		.prepare("SELECT metadata FROM apps WHERE id = ?")
		.get(id) as { metadata: string | null } | undefined;
	return row?.metadata ? JSON.parse(row.metadata) : null;
}

describe("aggregateAppEntryMatches", () => {
	const target = { appId: "app-1", slug: "acme-mail" };
	it("prefers the id when both sides carry one", () => {
		expect(
			aggregateAppEntryMatches({ appId: "app-1", slug: "old-name" }, target),
		).toBe(true);
		expect(
			aggregateAppEntryMatches({ appId: "app-2", slug: "acme-mail" }, target),
		).toBe(false);
	});
	it("falls back to the slug for entries written before ids were stored", () => {
		expect(aggregateAppEntryMatches({ slug: "acme-mail" }, target)).toBe(true);
		expect(aggregateAppEntryMatches({ slug: "other" }, target)).toBe(false);
		expect(
			aggregateAppEntryMatches(
				{ appId: "app-1", slug: "acme-mail" },
				{
					appId: null,
					slug: "acme-mail",
				},
			),
		).toBe(true);
	});
});

describe("installFromCatalog", () => {
	it("links the proxy to its base app by id and slug", async () => {
		const { db, sqlite } = realDb();
		// The ORM insert applies the schema's runtime defaults.
		await db.insert(appCatalog).values({
			id: "catalog-mail",
			name: "Sample Mail",
			slug: "sample-mail",
			connectorType: "mcp",
			lastSyncedAt: "2026-01-01T00:00:00.000Z",
		});
		insertApp(sqlite, {
			id: "20000000-0000-4000-8000-000000000001",
			organizationId: PLATFORM_ORG,
			slug: "sample-mail",
			catalogAppId: "catalog-mail",
		});

		const result = await installFromCatalog(db, {
			catalogAppId: "catalog-mail",
			organizationId: ACME_ORG,
			slug: "acme-sample-mail",
		});

		expect(result.app?.id).toBeTruthy();
		expect(metadataOf(sqlite, result.app!.id).mcpConfig.aggregateApps).toEqual([
			{ appId: "20000000-0000-4000-8000-000000000001", slug: "sample-mail" },
		]);
	});
});

describe("deleteApp", () => {
	it("scrubs links to the deleted app from its organization only", async () => {
		const { db, sqlite } = realDb();
		const deleted = "30000000-0000-4000-8000-000000000001";
		const keep = "30000000-0000-4000-8000-000000000002";
		insertApp(sqlite, {
			id: deleted,
			organizationId: ACME_ORG,
			slug: "acme-crm",
		});
		insertApp(sqlite, {
			id: keep,
			organizationId: ACME_ORG,
			slug: "acme-docs",
		});
		insertApp(sqlite, {
			id: "acme-gateway",
			organizationId: ACME_ORG,
			slug: "acme-gateway",
			metadata: {
				widgetConfig: { untouched: true },
				mcpConfig: {
					codeMode: true,
					aggregateApps: [
						// id link under a former slug
						{ appId: deleted, slug: "acme-crm-old", prefix: "crm" },
						{ appId: keep, slug: "acme-docs", prefix: "docs" },
						// old slug-only link
						{ slug: "acme-crm" },
						// another app that happens to carry the slug text
						{ appId: keep, slug: "acme-crm" },
					],
					inactiveAggregateApps: [{ appId: deleted, slug: "acme-crm" }],
				},
			},
		});
		insertApp(sqlite, {
			id: "acme-proxy",
			organizationId: ACME_ORG,
			slug: "acme-proxy",
			metadata: {
				mcpConfig: { aggregateApps: [{ appId: keep, slug: "acme-docs" }] },
			},
		});
		const foreignMetadata = {
			mcpConfig: { aggregateApps: [{ appId: deleted, slug: "acme-crm" }] },
		};
		insertApp(sqlite, {
			id: "sample-gateway",
			organizationId: SAMPLE_ORG,
			slug: "sample-gateway",
			metadata: foreignMetadata,
		});

		expect(await deleteApp(db, deleted)).toBe(true);

		expect(metadataOf(sqlite, deleted)).toBeNull();
		expect(
			sqlite.prepare("SELECT id FROM apps WHERE id = ?").get(deleted),
		).toBeUndefined();
		expect(metadataOf(sqlite, "acme-gateway")).toEqual({
			widgetConfig: { untouched: true },
			mcpConfig: {
				codeMode: true,
				aggregateApps: [
					{ appId: keep, slug: "acme-docs", prefix: "docs" },
					{ appId: keep, slug: "acme-crm" },
				],
				inactiveAggregateApps: [],
			},
		});
		expect(metadataOf(sqlite, "acme-proxy")).toEqual({
			mcpConfig: { aggregateApps: [{ appId: keep, slug: "acme-docs" }] },
		});
		expect(metadataOf(sqlite, "sample-gateway")).toEqual(foreignMetadata);
	});

	it("deletes an app nothing links to", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, {
			id: "30000000-0000-4000-8000-000000000003",
			organizationId: ACME_ORG,
			slug: "acme-lonely",
		});
		expect(await deleteApp(db, "30000000-0000-4000-8000-000000000003")).toBe(
			true,
		);
		expect(sqlite.prepare("SELECT COUNT(*) AS c FROM apps").get()).toEqual({
			c: 0,
		});
	});
});
