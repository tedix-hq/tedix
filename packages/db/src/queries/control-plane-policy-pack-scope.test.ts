/**
 * `getPolicyPackBySlugForOrganization` is the resolver a Blueprint's pinned
 * policy-pack requirement goes through, and it is the one place a blueprint
 * imported from another tenant could read a stranger's row.
 *
 * Revision identity is globally unique on `(scope, slug, version)`, while the
 * resolver's `organization_id` predicate remains the tenant fence. A gallery
 * import carries the publisher's slugs verbatim, so an unbound lookup could
 * otherwise return the publisher's private revision.
 *
 * These run against DDL derived from the production Drizzle table, so the
 * global uniqueness the fence has to survive is the real one.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { policyPacks } from "../schema/control-plane";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getPolicyPackBySlugForOrganization } from "./control-plane/definitions";

const NOW = "2026-08-17T12:00:00.000Z";

function setup(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec(schemaDdl(organizations, policyPacks));
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug)
			VALUES ('org-1', 'First Org', 'first'), ('org-2', 'Second Org', 'second');
		INSERT INTO policy_packs
			(id, organization_id, scope, slug, name, status, version, definition, created_at, updated_at)
		VALUES
			('pp-1', 'org-1', 'organization', 'revenue-ops', 'Revenue Ops', 'active', 2, '{}', '${NOW}', '${NOW}'),
			('pp-1-v3', 'org-1', 'organization', 'revenue-ops', 'Revenue Ops', 'active', 3, '{"new":true}', '${NOW}', '${NOW}'),
			('pp-sys', NULL, 'system', 'baseline', 'Baseline', 'active', 1, '{}', '${NOW}', '${NOW}'),
			-- A system-scoped pack that CARRIES AN OWNER. Nothing in the schema
			-- forbids it and the platform-admin create path defaults the owner to
			-- the caller org, so this shape occurs in real data.
			('pp-sys-owned', 'org-2', 'system', 'secret-guardrails', 'Secret Guardrails', 'active', 1, '{}', '${NOW}', '${NOW}');
	`);
	return createDbClient(createD1Facade(sqlite));
}

describe("policy pack slug resolution", () => {
	it("resolves an org-scoped slug only inside the organization that owns it", async () => {
		const db = setup();
		const params = { scope: "organization" as const, slug: "revenue-ops" };

		expect(
			await getPolicyPackBySlugForOrganization(db, "org-1", params),
		).toMatchObject({ id: "pp-1-v3", version: 3 });
		// An unbound lookup would return org-1's private row to org-2.
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-2", params),
		).toBeNull();
	});

	it("resolves the exact pinned revision when a version is declared", async () => {
		const db = setup();
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-1", {
				scope: "organization",
				slug: "revenue-ops",
				version: 2,
			}),
		).toMatchObject({ id: "pp-1", version: 2, definition: {} });
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-1", {
				scope: "organization",
				slug: "revenue-ops",
				version: 1,
			}),
		).toBeNull();
	});

	it("resolves an ownerless system pack for anyone", async () => {
		const db = setup();
		const params = { scope: "system" as const, slug: "baseline" };
		// A genuinely global pack has a NULL organization and must stay reachable.
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-1", params),
		).toMatchObject({ id: "pp-sys" });
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-2", params),
		).toMatchObject({ id: "pp-sys" });
	});

	it("never resolves a system-scoped pack owned by ANOTHER tenant", async () => {
		const db = setup();
		const params = { scope: "system" as const, slug: "secret-guardrails" };
		// System scope used to skip the ownership predicate entirely on the
		// reasoning that system packs are global and ownerless. They are not:
		// this one belongs to org-2. Unbound, org-1's blueprint pin resolved
		// `allowed` against org-2's row, and that foreign id + version was then
		// persisted into the workspace's preflight record and returned on the wire.
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-1", params),
		).toBeNull();
		// Its owner still reaches it.
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-2", params),
		).toMatchObject({ id: "pp-sys-owned" });
	});

	it("refuses to hand a second tenant the only holder of a globally unique slug", async () => {
		const db = setup();
		// The exact gallery-import shape: org-2 imports a blueprint pinning
		// org-1's org-scoped pack. Resolution happens in org-2 and finds nothing,
		// so the blueprint preflight reports `missing` instead of binding.
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-2", {
				scope: "organization",
				slug: "revenue-ops",
			}),
		).toBeNull();
		// Proof the row is genuinely there and reachable by its owner.
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-1", {
				scope: "organization",
				slug: "revenue-ops",
			}),
		).not.toBeNull();
	});

	it("resolves a system-scoped slug globally and keeps the scopes disjoint", async () => {
		const db = setup();
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-2", {
				scope: "system",
				slug: "baseline",
			}),
		).toMatchObject({ id: "pp-sys", scope: "system" });
		// Scope is part of the declared identity, so an org-scoped lookup can
		// never fall through to the system pack of the same name, or vice versa.
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-1", {
				scope: "organization",
				slug: "baseline",
			}),
		).toBeNull();
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-1", {
				scope: "system",
				slug: "revenue-ops",
			}),
		).toBeNull();
	});

	it("normalizes the declared slug the same way writes do", async () => {
		const db = setup();
		expect(
			await getPolicyPackBySlugForOrganization(db, "org-1", {
				scope: "organization",
				slug: "  Revenue-Ops  ",
			}),
		).toMatchObject({ id: "pp-1-v3" });
	});
});
