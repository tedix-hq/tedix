import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import {
	appCatalog,
	appCatalogMcpPrompts,
	appCatalogMcpResources,
	appCatalogMcpResourceTemplates,
	appCatalogMcpSkills,
	appCatalogMcpTools,
	appCatalogStoreListings,
} from "../../schema/catalog";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { getCatalogAppBySlugWithRelations } from "./list-with-relations";

/**
 * `/apps/<slug>` is the SEO-critical catalog read. It was rewritten off
 * Drizzle's relational query builder because RQB made it CPU-bound — orders of
 * magnitude more CPU than the plain selects catalog/list uses.
 *
 * These tests pin the behaviour the rewrite has to preserve: soft-deleted
 * children stay hidden, ordering is stable, an app with no children still
 * returns empty arrays rather than undefined, and the whole thing runs through
 * the D1 facade (which rejects explicit transactions and duplicate output
 * column names — both of which are valid SQL that breaks on real D1).
 */
function realDb(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	// DDL straight from the production schema objects, so a column added by a
	// migration cannot silently diverge from what this test exercises.
	sqlite.exec(
		schemaDdl(
			appCatalog,
			appCatalogStoreListings,
			appCatalogMcpTools,
			appCatalogMcpResources,
			appCatalogMcpResourceTemplates,
			appCatalogMcpPrompts,
			appCatalogMcpSkills,
		),
	);
	const T = "2026-01-01T00:00:00Z";
	sqlite.exec(`
		INSERT INTO app_catalog (id, slug, name, connector_type, last_synced_at) VALUES
			('app-1', 'has-children', 'Has Children', 'MCP', '${T}'),
			('app-2', 'no-children', 'No Children', 'MCP', '${T}');
		INSERT INTO app_catalog_store_listings (id, catalog_app_id, source, source_app_id, last_synced_at) VALUES
			('sl-old', 'app-1', 'claude', 'x1', '2026-01-01T00:00:00Z'),
			('sl-new', 'app-1', 'chatgpt', 'x2', '2026-06-01T00:00:00Z');
		INSERT INTO app_catalog_mcp_tools (id, catalog_app_id, tool_name, input_schema, detected_at, last_seen_at, removed_at) VALUES
			('t-b', 'app-1', 'b_tool', '{}', '${T}', '${T}', NULL),
			('t-a', 'app-1', 'a_tool', '{}', '${T}', '${T}', NULL),
			('t-gone', 'app-1', 'zz_removed', '{}', '${T}', '${T}', '2026-05-01T00:00:00Z');
		INSERT INTO app_catalog_mcp_resources (id, catalog_app_id, uri, detected_at, last_seen_at, removed_at) VALUES
			('r-1', 'app-1', 'res://a', '${T}', '${T}', NULL),
			('r-gone', 'app-1', 'res://z', '${T}', '${T}', '2026-05-01T00:00:00Z');
		INSERT INTO app_catalog_mcp_resource_templates (id, catalog_app_id, name, uri_template, detected_at, last_seen_at, removed_at) VALUES
			('rt-1', 'app-1', 'tpl', 'res://{x}', '${T}', '${T}', NULL);
		INSERT INTO app_catalog_mcp_prompts (id, catalog_app_id, prompt_name, detected_at, last_seen_at, removed_at) VALUES
			('p-1', 'app-1', 'prompt', '${T}', '${T}', NULL),
			('p-gone', 'app-1', 'zz', '${T}', '${T}', '2026-05-01T00:00:00Z');
		INSERT INTO app_catalog_mcp_skills
			(id, catalog_app_id, skill_uri, frontmatter, resources, detected_at, last_seen_at) VALUES
			('s-1', 'app-1', 'skill://refunds/SKILL.md',
			 '{"name":"refunds","description":"Process refunds"}',
			 '[{"uri":"skill://refunds/SKILL.md","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":50}]',
			 '${T}', '${T}');
	`);
	return createDbClient(createD1Facade(sqlite));
}

describe("getCatalogAppBySlugWithRelations", () => {
	it("returns null for an unknown slug without querying children", async () => {
		expect(await getCatalogAppBySlugWithRelations(realDb(), "nope")).toBeNull();
	});

	it("loads every child collection, hiding soft-deleted rows", async () => {
		const app = await getCatalogAppBySlugWithRelations(
			realDb(),
			"has-children",
		);

		expect(app?.name).toBe("Has Children");
		expect(app?.tools.map((t) => t.toolName)).toEqual(["a_tool", "b_tool"]);
		expect(app?.resources.map((r) => r.uri)).toEqual(["res://a"]);
		expect(app?.resourceTemplates.map((r) => r.name)).toEqual(["tpl"]);
		expect(app?.prompts.map((p) => p.promptName)).toEqual(["prompt"]);
		expect(app?.skills.map((skill) => skill.skillUri)).toEqual([
			"skill://refunds/SKILL.md",
		]);
	});

	it("orders store listings newest-synced first", async () => {
		const app = await getCatalogAppBySlugWithRelations(
			realDb(),
			"has-children",
		);
		expect(app?.storeListings.map((l) => l.source)).toEqual([
			"chatgpt",
			"claude",
		]);
	});

	it("returns empty arrays — never undefined — for an app with no children", async () => {
		const app = await getCatalogAppBySlugWithRelations(realDb(), "no-children");

		expect(app?.name).toBe("No Children");
		expect(app?.storeListings).toEqual([]);
		expect(app?.tools).toEqual([]);
		expect(app?.resources).toEqual([]);
		expect(app?.resourceTemplates).toEqual([]);
		expect(app?.prompts).toEqual([]);
		expect(app?.skills).toEqual([]);
	});
});
