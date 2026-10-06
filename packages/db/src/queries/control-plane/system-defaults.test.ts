/**
 * The platform defaults are a D1 fact, not a compiled-in id.
 *
 * Three UUID literals used to name the system-default runtime profile, policy
 * pack and workspace template set. Publishing a revision mints a NEW row id, so
 * the literals went stale the first time anyone published: in production the
 * policy-pack constant still pointed at v26 while the live head was v27, and
 * every caller that took the hardcoded fallback ran an outdated policy.
 *
 * What these tests pin is that resolution follows the published head of the
 * `system-default` slug, and that it refuses the revisions that are not
 * deployable — a draft, an archived row, or one that was never published.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../../schema/control-plane";
import { organizations } from "../../schema/organizations";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	getSystemDefaultPolicyPack,
	getSystemDefaultRuntimeProfile,
	getSystemDefaultWorkspaceTemplateSet,
} from "./definitions";

function setup(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec(
		schemaDdl(
			organizations,
			runtimeProfiles,
			policyPacks,
			workspaceTemplateSets,
		),
	);
	return createDbClient(createD1Facade(sqlite));
}

describe("system-default resolution follows the published head", () => {
	it("returns the highest active published version, not the oldest id", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = ON;");
		sqlite.exec(
			schemaDdl(
				organizations,
				runtimeProfiles,
				policyPacks,
				workspaceTemplateSets,
			),
		);
		// v1 is the id a constant would have been written against; v2 is the head.
		sqlite.exec(`
			INSERT INTO runtime_profiles
				(id, organization_id, name, slug, scope, status, version, config, published_at)
			VALUES
				('rp-v1', NULL, 'System Default', 'system-default', 'system', 'active', 1, '{}', '2026-01-01T00:00:00.000Z'),
				('rp-v2', NULL, 'System Default', 'system-default', 'system', 'active', 2, '{}', '2026-02-01T00:00:00.000Z');
		`);
		const db = createDbClient(createD1Facade(sqlite));

		const resolved = await getSystemDefaultRuntimeProfile(db);

		expect(resolved?.id).toBe("rp-v2");
		expect(resolved?.version).toBe(2);
	});

	it("ignores a draft, an archived row and an unpublished one", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = ON;");
		sqlite.exec(
			schemaDdl(
				organizations,
				runtimeProfiles,
				policyPacks,
				workspaceTemplateSets,
			),
		);
		// Higher versions exist but none of them is deployable, so the active
		// published v2 stays the default rather than a draft v4 winning on version.
		sqlite.exec(`
			INSERT INTO runtime_profiles
				(id, organization_id, name, slug, scope, status, version, config, published_at)
			VALUES
				('rp-v2', NULL, 'System Default', 'system-default', 'system', 'active', 2, '{}', '2026-02-01T00:00:00.000Z'),
				('rp-v3', NULL, 'System Default', 'system-default', 'system', 'archived', 3, '{}', '2026-03-01T00:00:00.000Z'),
				('rp-v4', NULL, 'System Default', 'system-default', 'system', 'draft', 4, '{}', '2026-04-01T00:00:00.000Z'),
				('rp-v5', NULL, 'System Default', 'system-default', 'system', 'active', 5, '{}', NULL);
		`);
		const db = createDbClient(createD1Facade(sqlite));

		expect((await getSystemDefaultRuntimeProfile(db))?.id).toBe("rp-v2");
	});

	it("never returns an organization-scoped profile that shares the slug", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = ON;");
		sqlite.exec(
			schemaDdl(
				organizations,
				runtimeProfiles,
				policyPacks,
				workspaceTemplateSets,
			),
		);
		sqlite.exec(`
			INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
			INSERT INTO runtime_profiles
				(id, organization_id, name, slug, scope, status, version, config, published_at)
			VALUES
				('rp-sys', NULL, 'System Default', 'system-default', 'system', 'active', 1, '{}', '2026-01-01T00:00:00.000Z'),
				('rp-org', 'org-1', 'Theirs', 'system-default', 'organization', 'active', 9, '{}', '2026-05-01T00:00:00.000Z');
		`);
		const db = createDbClient(createD1Facade(sqlite));

		// The org row has a much higher version. Scope is the boundary, not version.
		expect((await getSystemDefaultRuntimeProfile(db))?.id).toBe("rp-sys");
	});

	it("returns null when no deployable default exists at all", async () => {
		const db = setup();
		expect(await getSystemDefaultRuntimeProfile(db)).toBeNull();
		expect(await getSystemDefaultPolicyPack(db)).toBeNull();
		expect(await getSystemDefaultWorkspaceTemplateSet(db)).toBeNull();
	});

	it("only accepts a tedi-assignable policy pack target", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = ON;");
		sqlite.exec(
			schemaDdl(
				organizations,
				runtimeProfiles,
				policyPacks,
				workspaceTemplateSets,
			),
		);
		// v3 is newer but targets something a tedi cannot run under, so the
		// tedi-targeted v2 remains the default.
		sqlite.exec(`
			INSERT INTO policy_packs
				(id, organization_id, name, slug, scope, status, version, target, definition, published_at)
			VALUES
				('pp-v2', NULL, 'System Default', 'system-default', 'system', 'active', 2, 'tedi', '{}', '2026-02-01T00:00:00.000Z'),
				('pp-v3', NULL, 'System Default', 'system-default', 'system', 'active', 3, 'organization', '{}', '2026-03-01T00:00:00.000Z');
		`);
		const db = createDbClient(createD1Facade(sqlite));

		expect((await getSystemDefaultPolicyPack(db))?.id).toBe("pp-v2");
	});

	it("resolves the workspace template set head the same way", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = ON;");
		sqlite.exec(
			schemaDdl(
				organizations,
				runtimeProfiles,
				policyPacks,
				workspaceTemplateSets,
			),
		);
		sqlite.exec(`
			INSERT INTO workspace_template_sets
				(id, organization_id, name, slug, scope, status, version, templates, published_at)
			VALUES
				('wts-v1', NULL, 'System Default', 'system-default', 'system', 'active', 1, '{}', '2026-01-01T00:00:00.000Z'),
				('wts-v2', NULL, 'System Default', 'system-default', 'system', 'active', 2, '{}', '2026-02-01T00:00:00.000Z');
		`);
		const db = createDbClient(createD1Facade(sqlite));

		expect((await getSystemDefaultWorkspaceTemplateSet(db))?.id).toBe("wts-v2");
	});
});
