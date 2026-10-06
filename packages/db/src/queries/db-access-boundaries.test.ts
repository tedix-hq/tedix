import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import { organizations } from "../schema/organizations";
import { tediRationaleRecords } from "../schema/rationale-records";
import { workstationLeases } from "../schema/workstations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getAppMetadataById,
	getLinkedOpenApiCatalogSnapshot,
	listApiSyncApps,
	listBaseAppsForCatalogApp,
} from "./apps";
import { listActiveProviderCatalogApps } from "./catalog/health-metrics";
import { getOrganizationDescopeTenantId } from "./organizations";
import { closeStalePendingRationaleRecords } from "./rationale-records";
import {
	hasActiveWorkstationLease,
	updateWorkstationLeaseBodyGeneration,
} from "./workstations";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			organizations,
			appCatalog,
			apps,
			tediRationaleRecords,
			workstationLeases,
		),
	);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("platform D1 access boundaries", () => {
	it("selects scheduled catalog and API-sync work through typed helpers", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
			INSERT INTO organizations (id, name, slug, descope_tenant_id)
			VALUES ('org-1', 'One', 'one', 'tenant-one');
			INSERT INTO app_catalog (
				id, slug, name, connector_type, status, mcp_endpoint_normalized, tool_source, last_synced_at
			) VALUES
				('cat-live', 'live', 'Live', 'MCP', 'ENABLED', 'https://live.test/mcp', 'openapi', '2026-08-01T00:00:00.000Z'),
				('cat-disabled', 'disabled', 'Disabled', 'MCP', 'DISABLED', 'https://disabled.test/mcp', 'upstream_mcp', '2026-08-01T00:00:00.000Z');
			INSERT INTO apps (id, organization_id, name, slug, metadata, catalog_app_id)
			VALUES
				('app-openapi', 'org-1', 'OpenAPI', 'openapi', '{"mcpConfig":{"openApiSync":{"enabled":true}}}', 'cat-live'),
				('app-google', 'org-1', 'Google', 'google', '{"mcpConfig":{"googleDiscoverySync":{"enabled":true}}}', NULL),
				('app-proxy', 'org-1', 'Proxy', 'proxy', '{}', 'cat-live');
			UPDATE apps SET source_app_id = 'app-openapi' WHERE id = 'app-proxy';
		`);

		expect(await getOrganizationDescopeTenantId(db, "org-1")).toBe(
			"tenant-one",
		);
		expect(
			await listActiveProviderCatalogApps(db, ["live", "disabled"]),
		).toEqual([{ id: "cat-live", slug: "live" }]);
		expect((await listApiSyncApps(db)).map(({ id }) => id).sort()).toEqual([
			"app-google",
			"app-openapi",
		]);
		expect(await getLinkedOpenApiCatalogSnapshot(db, "app-openapi")).toEqual({
			catalogAppId: "cat-live",
			toolSource: "openapi",
		});
		expect(await getAppMetadataById(db, "app-openapi")).toEqual({
			mcpConfig: { openApiSync: { enabled: true } },
		});
		expect(await listBaseAppsForCatalogApp(db, "cat-live")).toHaveLength(1);
	});

	it("owns stale-rationale and workstation generation mutations", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
			INSERT INTO tedi_rationale_records (
				id, tedi_id, org_id, action, rationale, category, confidence,
				evidence, outcome_status, created_at
			) VALUES
				('old', 'tedi-1', 'org-1', 'act', 'why', 'custom', 0.5, '{}', 'pending', '2020-01-01T00:00:00.000Z'),
				('done', 'tedi-1', 'org-1', 'act', 'why', 'custom', 0.5, '{}', 'success', '2020-01-01T00:00:00.000Z');
			INSERT INTO workstation_leases (
				id, workstation_id, profile_id, status, capabilities, adapters,
				approval_ids, artifact_refs, metadata, created_at, updated_at
			) VALUES
				('lease-active', 'ws-1', 'general', 'active', '[]', '[]', '[]', '[]', '{}', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
				('lease-released', 'ws-2', 'general', 'released', '[]', '[]', '[]', '[]', '{}', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
		`);

		expect(await closeStalePendingRationaleRecords(db)).toBe(1);
		expect(await hasActiveWorkstationLease(db, "lease-active")).toBe(true);
		expect(await hasActiveWorkstationLease(db, "lease-released")).toBe(false);

		await updateWorkstationLeaseBodyGeneration(db, {
			leaseId: "lease-active",
			generationId: "generation-1",
			status: "ready",
			tokenHash: "hash",
			tokenExpiresAt: "2026-08-01T01:00:00.000Z",
			externalId: "ws-1",
			heartbeatAt: "2026-08-01T00:10:00.000Z",
			updatedAt: "2026-08-01T00:10:00.000Z",
		});
		const row = sqlite
			.prepare(
				"SELECT body_generation_id AS id, body_generation_status AS status FROM workstation_leases WHERE id = 'lease-active'",
			)
			.get();
		expect(row).toEqual({ id: "generation-1", status: "ready" });
	});
});
