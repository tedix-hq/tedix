/**
 * Installability derivation — the `service_connector` (brokered) state.
 *
 * Store-brokered connectors (e.g. GitHub's ChatGPT SERVICE connector) publish
 * no public MCP endpoint and must surface as a distinct, non-installable state
 * rather than a generic listing.
 */

import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { catalogRunnableSql } from "@tedix/db/queries/catalog/vendor-variants";
import { appCatalog } from "@tedix/db/schema/catalog";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { calculateCatalogInstallability } from "./catalog";

const endpoint = "https://mcp.example.test/mcp";

describe("catalog installability", () => {
	it("keeps API installability aligned with SQL runnability", async () => {
		const sqlite = new DatabaseSync(":memory:");
		onTestFinished(() => sqlite.close());
		sqlite.exec(schemaDdl(appCatalog));
		const db = createDbClient(createD1Facade(sqlite));
		const samples = [
			[{ connectorType: "MCP" }, "needs_mcp_endpoint"],
			[{ connectorType: "MCP", baseUrl: endpoint }, "needs_base_app"],
			[
				{ connectorType: "MCP", mcpEndpointNormalized: endpoint },
				"needs_base_app",
			],
			[{ connectorType: "SERVICE" }, "service_connector"],
			[{ connectorType: "SERVICE", baseUrl: endpoint }, "listing_only"],
			[{ connectorType: "SERVICE", mcpToolCount: 1 }, "needs_base_app"],
			[{ connectorType: "NATIVE", mcpResourceCount: 1 }, "needs_base_app"],
			[{ connectorType: "NATIVE", mcpPromptCount: 1 }, "needs_base_app"],
			[
				{
					connectorType: "FIRST_PARTY_ECOSYSTEM",
					baseUrl: endpoint,
					mcpToolCount: 1,
				},
				"listing_only",
			],
		] as const;
		const entries = samples.map(([sample], index) => ({
			...sample,
			id: String(index),
			name: "Vendor",
			status: "ENABLED" as const,
			lastSyncedAt: "2026-01-01T00:00:00Z",
		}));
		for (const entry of entries) await db.insert(appCatalog).values(entry);
		const rows = await db
			.select({
				id: appCatalog.id,
				runnable: catalogRunnableSql(appCatalog).as("runnable"),
			})
			.from(appCatalog)
			.orderBy(appCatalog.id);

		expect(
			entries.map((entry) => calculateCatalogInstallability(entry).state),
		).toEqual(samples.map(([, state]) => state));
		expect(rows.map((row) => Boolean(row.runnable))).toEqual(
			samples.map(([, state]) => state === "needs_base_app"),
		);
	});

	it("still reports a real MCP app with a prepared base app as installable", () => {
		const result = calculateCatalogInstallability(
			{
				status: "ENABLED",
				connectorType: "MCP",
				baseUrl: endpoint,
				mcpEndpointNormalized: endpoint,
				mcpToolCount: 44,
			},
			{ metadata: {} } as never,
		);
		expect(result.installable).toBe(true);
		expect(result.state).toBe("installable");
	});
});
