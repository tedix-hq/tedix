/**
 * Catalog browsing hides a non-runnable row behind a runnable same-vendor
 * sibling using the SQL predicate `catalogRunnableSql`. That predicate must
 * agree with `calculateCatalogInstallability`: SQL-runnable rows are exactly
 * the enabled rows whose state is `installable` or `needs_base_app`.
 */

import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { catalogRunnableSql } from "@tedix/db/queries/catalog/vendor-variants";
import { appCatalog } from "@tedix/db/schema/catalog";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import { calculateCatalogInstallability } from "./catalog";

const CONNECTOR_TYPES = [
	"MCP",
	"SERVICE",
	"NATIVE",
	"FIRST_PARTY_ECOSYSTEM",
] as const;
const ENDPOINTS = [null, "", "https://mcp.vendor.example/mcp"] as const;
const COUNTS = [0, 2] as const;

describe("catalogRunnableSql", () => {
	it("matches calculateCatalogInstallability for every endpoint/inventory shape", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(appCatalog));
		const insert = sqlite.prepare(
			`INSERT INTO app_catalog (id, name, connector_type, base_url, mcp_endpoint_normalized, mcp_tool_count, mcp_resource_count, mcp_prompt_count, status, last_synced_at)
			 VALUES (?, 'Vendor', ?, ?, ?, ?, ?, ?, 'ENABLED', '2026-01-01T00:00:00Z')`,
		);
		const cases: Array<{
			id: string;
			connectorType: (typeof CONNECTOR_TYPES)[number];
			baseUrl: string | null;
			mcpEndpointNormalized: string | null;
			mcpToolCount: number;
			mcpResourceCount: number;
			mcpPromptCount: number;
		}> = [];
		for (const connectorType of CONNECTOR_TYPES) {
			for (const baseUrl of ENDPOINTS) {
				for (const mcpEndpointNormalized of ENDPOINTS) {
					for (const mcpToolCount of COUNTS) {
						for (const mcpPromptCount of COUNTS) {
							const id = `case-${cases.length}`;
							cases.push({
								id,
								connectorType,
								baseUrl,
								mcpEndpointNormalized,
								mcpToolCount,
								mcpResourceCount: 0,
								mcpPromptCount,
							});
							insert.run(
								id,
								connectorType,
								baseUrl,
								mcpEndpointNormalized,
								mcpToolCount,
								0,
								mcpPromptCount,
							);
						}
					}
				}
			}
		}
		const db = createDbClient(createD1Facade(sqlite));
		const rows = await db
			.select({
				id: appCatalog.id,
				runnable: catalogRunnableSql(appCatalog).as("runnable"),
			})
			.from(appCatalog);
		const runnableById = new Map(
			rows.map((row) => [row.id, Boolean(row.runnable)]),
		);
		for (const testCase of cases) {
			const { state } = calculateCatalogInstallability({
				...testCase,
				status: "ENABLED",
			});
			expect({ ...testCase, runnable: runnableById.get(testCase.id) }).toEqual({
				...testCase,
				runnable: state === "installable" || state === "needs_base_app",
			});
		}
	});
});
