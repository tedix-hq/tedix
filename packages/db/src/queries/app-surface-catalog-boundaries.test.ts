import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { apps } from "../schema/apps";
import {
	appCatalog,
	appCatalogMcpPrompts,
	appCatalogMcpResources,
	appCatalogMcpResourceTemplates,
} from "../schema/catalog";
import { appToolCspDomains } from "../schema/configuration";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getAppsBySlugsWithTools } from "./app-records";

const DATE = "2026-10-21";
const CATALOG_TABLES = [
	"app_catalog",
	"app_catalog_mcp_resources",
	"app_catalog_mcp_resource_templates",
	"app_catalog_mcp_prompts",
];

type StatementRead = { sql: string; params: unknown[] };

function fixture(catalogCount: number) {
	const sqlite = new DatabaseSync(":memory:");
	// Missing catalog metadata deliberately models dangling references.
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			apps,
			appTools,
			appToolCspDomains,
			appCatalog,
			appCatalogMcpResources,
			appCatalogMcpResourceTemplates,
			appCatalogMcpPrompts,
		),
	);
	const insertApp = sqlite.prepare(
		"INSERT INTO apps (id, organization_id, slug, name, catalog_app_id, created_at, updated_at) VALUES (?, 'org-fictional', ?, ?, ?, ?, ?)",
	);
	const insertCatalog = sqlite.prepare(
		"INSERT INTO app_catalog (id, slug, name, connector_type, last_synced_at, base_url) VALUES (?, ?, ?, 'mcp', ?, ?)",
	);
	const insertTool = sqlite.prepare(
		"INSERT INTO app_tools (id, app_id, tool_type_id, tool_id, title, input_schema, enabled, sort_order, config, created_at) VALUES (?, ?, 'rpc', ?, ?, '{}', ?, ?, ?, ?)",
	);
	const insertResource = sqlite.prepare(
		"INSERT INTO app_catalog_mcp_resources (id, catalog_app_id, uri, removed_at, detected_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const insertTemplate = sqlite.prepare(
		"INSERT INTO app_catalog_mcp_resource_templates (id, catalog_app_id, name, uri_template, removed_at, detected_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const insertPrompt = sqlite.prepare(
		"INSERT INTO app_catalog_mcp_prompts (id, catalog_app_id, prompt_name, removed_at, detected_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const entries: Array<{
		slug: string;
		catalogId: string | null;
		metadata: boolean;
		live: boolean;
	}> = [];
	// Two additional ids have no metadata: one retains children, one is empty.
	for (let index = 0; index < catalogCount + 2; index++) {
		const catalogId = `catalog-${String(index).padStart(3, "0")}`;
		const slug = `fictional-${index}`;
		const metadata = index < catalogCount;
		const live = index !== 0 && index !== 1 && index !== catalogCount + 1;
		entries.push({ slug, catalogId, metadata, live });
		if (metadata) {
			insertCatalog.run(catalogId, slug, slug, DATE, `https://${slug}.example`);
		}
		insertApp.run(slug, slug, slug, catalogId, DATE, DATE);
		for (const [toolId, sortOrder, enabled] of [
			["second", 2, 1],
			["disabled", 0, 0],
			["first", 1, 1],
		] as const) {
			insertTool.run(
				`${slug}-${toolId}`,
				slug,
				toolId,
				toolId,
				enabled,
				sortOrder,
				JSON.stringify({ endpoint: `${toolId}/list` }),
				DATE,
			);
		}
		// Reverse insertion order and reuse every natural key across catalogs.
		for (const key of ["zeta", "removed", "alpha"]) {
			if (index === 0 || index === catalogCount + 1) continue;
			const removedAt = key === "removed" || index === 1 ? DATE : null;
			insertResource.run(
				`${catalogId}-resource-${key}`,
				catalogId,
				`fictional://${key}`,
				removedAt,
				DATE,
				DATE,
			);
			insertTemplate.run(
				`${catalogId}-template-${key}`,
				catalogId,
				key,
				`fictional://${key}/{id}`,
				removedAt,
				DATE,
				DATE,
			);
			insertPrompt.run(
				`${catalogId}-prompt-${key}`,
				catalogId,
				key,
				removedAt,
				DATE,
				DATE,
			);
		}
	}
	const shared = entries[catalogCount - 1]!;
	insertApp.run(
		"fictional-alias",
		"fictional-alias",
		"Alias",
		shared.catalogId,
		DATE,
		DATE,
	);
	entries.push({ ...shared, slug: "fictional-alias" });
	insertApp.run(
		"fictional-unlinked",
		"fictional-unlinked",
		"Unlinked",
		null,
		DATE,
		DATE,
	);
	entries.push({
		slug: "fictional-unlinked",
		catalogId: null,
		metadata: false,
		live: false,
	});

	const statements: StatementRead[] = [];
	const batches: StatementRead[][] = [];
	const preparedReads = new WeakMap<D1PreparedStatement, StatementRead>();
	const facade = createD1Facade(sqlite, { maxBoundParams: 100 });
	const client = createDbClient({
		...facade,
		prepare(sql: string) {
			const prepared = facade.prepare(sql);
			const read: StatementRead = { sql, params: [] };
			statements.push(read);
			preparedReads.set(prepared, read);
			const bind = prepared.bind.bind(prepared);
			prepared.bind = (...params: unknown[]) => {
				read.params = params;
				return bind(...params);
			};
			return prepared;
		},
		batch(queries) {
			batches.push(queries.map((query) => preparedReads.get(query)!));
			return facade.batch(queries);
		},
	});
	return { sqlite, client, entries, statements, batches };
}

describe("getAppsBySlugsWithTools catalog chunk boundaries", () => {
	it.each([51, 101])(
		"isolates %i catalogs across D1 statement groups",
		async (catalogCount) => {
			const { sqlite, client, entries, statements, batches } =
				fixture(catalogCount);
			try {
				const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
				const requests = [
					...entries.toReversed().map(({ slug }) => ({ slug })),
					...entries.map(({ slug }) => ({ slug, toolIds: ["second"] })),
					...entries
						.toReversed()
						.map(({ slug }) => ({ slug, toolIds: ["first"] })),
					{ slug: "fictional-absent" },
				];
				const results = await getAppsBySlugsWithTools(client, requests);
				expect(results).toHaveLength(requests.length);
				for (const [index, request] of requests.entries()) {
					const entry = bySlug.get(request.slug);
					const result = results[index];
					if (!entry) {
						expect(result).toBeNull();
						continue;
					}
					expect(result?.app.slug).toBe(request.slug);
					expect(result?.app.catalogAppId).toBe(entry.catalogId);
					expect(result?.catalogMcp).toEqual(
						entry.metadata
							? {
									id: entry.catalogId,
									slug: `fictional-${Number(entry.catalogId!.slice(-3))}`,
									baseUrl: `https://fictional-${Number(entry.catalogId!.slice(-3))}.example`,
									mcpEndpointNormalized: null,
									scanConnectionId: null,
									scanConnectionHeader: null,
									scanConnectionTemplate: null,
								}
							: null,
					);
					const keys = entry.live ? ["alpha", "zeta"] : [];
					expect(
						result?.catalogResources.map(
							({ id, catalogAppId, uri, removedAt }) => ({
								id,
								catalogAppId,
								uri,
								removedAt,
							}),
						),
					).toEqual(
						keys.map((key) => ({
							id: `${entry.catalogId}-resource-${key}`,
							catalogAppId: entry.catalogId,
							uri: `fictional://${key}`,
							removedAt: null,
						})),
					);
					expect(
						result?.catalogResourceTemplates.map(
							({ id, catalogAppId, name, uriTemplate, removedAt }) => ({
								id,
								catalogAppId,
								name,
								uriTemplate,
								removedAt,
							}),
						),
					).toEqual(
						keys.map((key) => ({
							id: `${entry.catalogId}-template-${key}`,
							catalogAppId: entry.catalogId,
							name: key,
							uriTemplate: `fictional://${key}/{id}`,
							removedAt: null,
						})),
					);
					expect(
						result?.catalogPrompts.map(
							({ id, catalogAppId, promptName, removedAt }) => ({
								id,
								catalogAppId,
								promptName,
								removedAt,
							}),
						),
					).toEqual(
						keys.map((key) => ({
							id: `${entry.catalogId}-prompt-${key}`,
							catalogAppId: entry.catalogId,
							promptName: key,
							removedAt: null,
						})),
					);
					const hasTools =
						request.slug !== "fictional-alias" &&
						request.slug !== "fictional-unlinked";
					expect(
						result?.tools.map(({ id, appId, toolId }) => ({
							id,
							appId,
							toolId,
						})),
					).toEqual(
						(hasTools
							? "toolIds" in request
								? request.toolIds!
								: ["first", "second"]
							: []
						).map((toolId) => ({
							id: `${request.slug}-${toolId}`,
							appId: request.slug,
							toolId,
						})),
					);
				}

				const catalogReads = statements.filter(({ sql }) =>
					CATALOG_TABLES.some((table) => sql.includes(`from "${table}"`)),
				);
				const catalogBatches = batches.filter((batch) =>
					batch.some((read) => catalogReads.includes(read)),
				);
				const chunks = Math.ceil((catalogCount + 2) / 50);
				expect(catalogReads).toHaveLength(chunks * 4);
				expect(catalogBatches).toHaveLength(chunks);
				for (const batch of catalogBatches) {
					expect(
						batch.map(({ sql }) => sql.match(/from "([^"]+)"/)?.[1]).sort(),
					).toEqual([...CATALOG_TABLES].sort());
					for (const read of batch) {
						expect(read.params.length).toBeGreaterThan(0);
						expect(read.params.length).toBeLessThanOrEqual(50);
						expect(read.params).toEqual(batch[0]!.params);
					}
				}
				const catalogIds = [
					...new Set(
						entries.flatMap(({ catalogId }) => (catalogId ? [catalogId] : [])),
					),
				].sort();
				for (const table of CATALOG_TABLES) {
					expect(
						catalogReads
							.filter(({ sql }) => sql.includes(`from "${table}"`))
							.flatMap(({ params }) => params)
							.sort(),
					).toEqual(catalogIds);
				}
				expect(statements.length).toBeGreaterThan(catalogReads.length);
				for (const { sql, params } of statements) {
					expect(params.length).toBeLessThanOrEqual(100);
					expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
				}
			} finally {
				sqlite.close();
			}
		},
	);
});
