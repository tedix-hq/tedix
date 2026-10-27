import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getInheritedAppLogos } from "./apps";

const PLATFORM_ORG = "10000000-0000-4000-8000-000000000003";

function seed() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(appCatalog, apps));
	sqlite.exec(`
		INSERT INTO app_catalog (id, name, connector_type, last_synced_at, logo_url)
			VALUES ('cat-docs', 'Docs', 'mcp', 'now', 'https://cdn.example/catalog-docs.png'),
			       ('cat-blank', 'Blank', 'mcp', 'now', NULL);
		INSERT INTO apps (id, organization_id, name, slug, logo_url, source_app_id, catalog_app_id) VALUES
			('base-logo', '${PLATFORM_ORG}', 'Base', 'base', 'https://cdn.example/base.png', NULL, NULL),
			('base-catalog', '${PLATFORM_ORG}', 'Docs', 'docs', NULL, NULL, 'cat-docs'),
			('base-blank', '${PLATFORM_ORG}', 'Blank', 'blank', '', NULL, 'cat-blank');
	`);
	return createDbClient(createD1Facade(sqlite));
}

const row = (
	id: string,
	fields: Partial<{
		logoUrl: string | null;
		sourceAppId: string | null;
		catalogAppId: string | null;
	}> = {},
) => ({
	id,
	logoUrl: null,
	sourceAppId: null,
	catalogAppId: null,
	...fields,
});

describe("getInheritedAppLogos", () => {
	it("inherits from the base app, then its catalog entry, then the app's own catalog entry", async () => {
		const db = seed();
		const logos = await getInheritedAppLogos(db, [
			row("acme-base", { sourceAppId: "base-logo" }),
			row("acme-docs", { sourceAppId: "base-catalog" }),
			row("acme-catalog", { catalogAppId: "cat-docs" }),
			row("acme-own", {
				logoUrl: "https://cdn.example/own.png",
				sourceAppId: "base-logo",
			}),
			row("acme-blank", { sourceAppId: "base-blank" }),
			row("acme-none"),
		]);
		expect(Object.fromEntries(logos)).toEqual({
			"acme-base": "https://cdn.example/base.png",
			"acme-docs": "https://cdn.example/catalog-docs.png",
			"acme-catalog": "https://cdn.example/catalog-docs.png",
		});
	});

	it("skips the lookup when every app has its own logo", async () => {
		const logos = await getInheritedAppLogos(seed(), [
			row("acme-own", { logoUrl: "https://cdn.example/own.png" }),
		]);
		expect(logos.size).toBe(0);
	});
});
