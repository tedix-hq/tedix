import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { policyPacks } from "../schema/control-plane";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getActivePolicyPackDefinition } from "./kernel-runtime-support";

function setup(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec(schemaDdl(organizations, policyPacks));
	sqlite.exec(
		"INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org')",
	);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("getActivePolicyPackDefinition", () => {
	it("falls back to the newest published system default for a fresh organization", async () => {
		const { db, sqlite } = setup();
		sqlite.exec(`
			INSERT INTO policy_packs
				(id, organization_id, name, slug, scope, status, version, target, definition, published_at)
			VALUES
				('system-v1', NULL, 'System Default', 'system-default', 'system', 'active', 1, 'tedi', '{"version":1}', '2026-01-01T00:00:00.000Z'),
				('system-v2', NULL, 'System Default', 'system-default', 'system', 'active', 2, 'tedi', '{"version":2}', '2026-02-01T00:00:00.000Z'),
				('system-v3', NULL, 'System Default', 'system-default', 'system', 'draft', 3, 'tedi', '{"version":3}', NULL);
		`);

		expect(await getActivePolicyPackDefinition(db, "org-1")).toEqual({
			version: 2,
		});
	});

	it("keeps an organization policy authoritative over the system default", async () => {
		const { db, sqlite } = setup();
		sqlite.exec(`
			INSERT INTO policy_packs
				(id, organization_id, name, slug, scope, status, version, target, definition, published_at)
			VALUES
				('system-v2', NULL, 'System Default', 'system-default', 'system', 'active', 2, 'tedi', '{"source":"system"}', '2026-02-01T00:00:00.000Z'),
				('org-v1', 'org-1', 'Org Policy', 'org-policy', 'organization', 'active', 1, 'tedi', '{"source":"organization"}', '2026-03-01T00:00:00.000Z');
		`);

		expect(await getActivePolicyPackDefinition(db, "org-1")).toEqual({
			source: "organization",
		});
	});

	it("uses the newest active organization policy revision", async () => {
		const { db, sqlite } = setup();
		sqlite.exec(`
			INSERT INTO policy_packs
				(id, organization_id, name, slug, scope, status, version, target, definition, published_at)
			VALUES
				('org-v1', 'org-1', 'Org Policy', 'org-policy', 'organization', 'active', 1, 'tedi', '{"version":1}', '2026-02-01T00:00:00.000Z'),
				('org-v2', 'org-1', 'Org Policy', 'org-policy', 'organization', 'active', 2, 'tedi', '{"version":2}', '2026-03-01T00:00:00.000Z');
		`);

		expect(await getActivePolicyPackDefinition(db, "org-1")).toEqual({
			version: 2,
		});
	});
});
