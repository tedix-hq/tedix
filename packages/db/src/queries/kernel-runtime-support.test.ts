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

it("system defaults cannot grant autonomy through either policy slot", async () => {
	const { db, sqlite } = setup();
	const definition = JSON.stringify({
		governancePolicy: {
			approvalTtlHours: 12,
			autonomy: { version: 1, maxRisk: "medium" },
		},
		gatingPolicy: { autonomy: { version: 1, maxRisk: "medium" } },
	});
	sqlite
		.prepare(
			"INSERT INTO policy_packs (id, name, slug, scope, status, version, target, definition, published_at) VALUES ('system', 'System', 'system-default', 'system', 'active', 1, 'tedi', ?, '2026-01-01')",
		)
		.run(definition);
	expect(await getActivePolicyPackDefinition(db, "org-1")).toEqual({
		governancePolicy: { approvalTtlHours: 12 },
		gatingPolicy: {},
	});
	expect(
		JSON.parse(
			(
				sqlite.prepare("SELECT definition FROM policy_packs").get() as {
					definition: string;
				}
			).definition,
		),
	).toEqual(JSON.parse(definition));
});
it("pins organization autonomy to its pack id and version, replacing supplied provenance", async () => {
	const { db, sqlite } = setup();
	const definition = JSON.stringify({
		governancePolicy: {
			autonomy: {
				version: 1,
				maxRisk: "medium",
				policyPack: { id: "forged", version: 999 },
			},
		},
	});
	sqlite
		.prepare(
			"INSERT INTO policy_packs (id, organization_id, name, slug, scope, status, version, target, definition) VALUES ('org-policy', 'org-1', 'Org', 'org', 'organization', 'active', 7, 'tedi', ?)",
		)
		.run(definition);
	expect(await getActivePolicyPackDefinition(db, "org-1")).toEqual({
		governancePolicy: {
			autonomy: {
				version: 1,
				maxRisk: "medium",
				policyPack: { id: "org-policy", version: 7 },
			},
		},
	});
});
