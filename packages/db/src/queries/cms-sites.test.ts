import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	activateCmsSiteAfterMedia,
	getCmsSiteByHostname,
	getCmsSiteByActiveWwwAlias,
	getCmsSiteBySlug,
	listCmsSitesByOrganization,
	registerCmsSite,
	registerCmsSiteIfAbsent,
	registerCmsSiteWithinQuota,
	updateCmsSiteDomain,
} from "./cms-sites";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE cms_sites (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			slug TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			description TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			restore_epoch INTEGER NOT NULL DEFAULT 0,
			canonical_url TEXT NOT NULL,
			custom_domain TEXT UNIQUE,
			public_path_prefix TEXT,
			template_slug TEXT NOT NULL DEFAULT 'tedix',
			config TEXT,
			mcp_app_id TEXT,
			authoring_app_id TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE cms_domain_claims (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, site_id TEXT NOT NULL,
			hostname TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'primary',
			verification_token TEXT NOT NULL, provider_hostname_id TEXT,
			status TEXT NOT NULL, expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE cms_restore_fences (
			site_id TEXT PRIMARY KEY, slug TEXT NOT NULL,
			generation TEXT NOT NULL, capture_id TEXT NOT NULL
		);
		CREATE TABLE cms_deprovision_operations (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, slug TEXT NOT NULL
		);
	`);
	return { db: createDbQueryClient(createD1Facade(sqlite)), sqlite };
}

describe("CMS site create on D1", () => {
	it("resolves a provider-bound www alias only while its owner retains the apex", async () => {
		const { db, sqlite } = fixture();
		await registerCmsSite(db, {
			id: "site-one",
			organizationId: "org-one",
			slug: "first",
			name: "First",
			canonicalUrl: "https://example.com",
			customDomain: "example.com",
		});
		sqlite.exec(`INSERT INTO cms_domain_claims VALUES
			('primary-one','org-one','site-one','example.com','primary','proof','provider-primary','active','2099-01-01','2026-01-01','2026-01-01'),
			('alias-one','org-one','site-one','www.example.com','www_alias','proof','provider-one','pending','2099-01-01','2026-01-01','2026-01-01')`);
		expect(await getCmsSiteByActiveWwwAlias(db, "www.example.com")).toBeNull();
		sqlite.exec(
			"UPDATE cms_domain_claims SET status='active' WHERE id='alias-one'",
		);
		expect((await getCmsSiteByActiveWwwAlias(db, "WWW.EXAMPLE.COM"))?.id).toBe(
			"site-one",
		);
		sqlite.exec(
			"UPDATE cms_sites SET custom_domain='new.example.com' WHERE id='site-one'",
		);
		expect(await getCmsSiteByActiveWwwAlias(db, "www.example.com")).toBeNull();
		sqlite.exec(
			"UPDATE cms_sites SET custom_domain='example.com', status='paused' WHERE id='site-one'",
		);
		expect(await getCmsSiteByActiveWwwAlias(db, "www.example.com")).toBeNull();
		sqlite.exec("UPDATE cms_sites SET status='active' WHERE id='site-one'");
		sqlite.exec(
			"UPDATE cms_domain_claims SET provider_hostname_id=NULL WHERE id='alias-one'",
		);
		expect(await getCmsSiteByActiveWwwAlias(db, "www.example.com")).toBeNull();
		sqlite.exec(
			"UPDATE cms_domain_claims SET provider_hostname_id='provider-one', organization_id='org-two' WHERE id='alias-one'",
		);
		expect(await getCmsSiteByActiveWwwAlias(db, "www.example.com")).toBeNull();
		sqlite.exec(
			"UPDATE cms_domain_claims SET organization_id='org-one' WHERE id='alias-one'",
		);
		sqlite.exec(
			"UPDATE cms_domain_claims SET status='removing' WHERE id='primary-one'",
		);
		expect(await getCmsSiteByActiveWwwAlias(db, "www.example.com")).toBeNull();
	});
	it("atomically rejects another site at quota while preserving slug idempotency", async () => {
		const { db, sqlite } = fixture();
		const site = {
			id: "site-one",
			organizationId: "org-one",
			slug: "first",
			name: "First",
			canonicalUrl: "https://first.cms.tedix.dev",
			config: { blog: { defaultLocale: "en" } },
		};
		expect(await registerCmsSiteWithinQuota(db, site, 1)).toMatchObject(site);
		expect(
			await registerCmsSiteWithinQuota(
				db,
				{ ...site, id: "site-two", slug: "second" },
				1,
			),
		).toBeNull();
		expect(
			await registerCmsSiteWithinQuota(db, { ...site, id: "site-three" }, 1),
		).toBeNull();
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM cms_sites").get(),
		).toEqual({ count: 1 });
		expect(
			await registerCmsSiteWithinQuota(
				db,
				{ ...site, id: "site-four", slug: "third" },
				-1,
			),
		).toMatchObject({ slug: "third" });
	});

	it("activates only the exact provisioned site if no fence or teardown receipt exists", async () => {
		const { db, sqlite } = fixture();
		const input = {
			id: "site-one",
			organizationId: "org-one",
			slug: "first",
			name: "First",
			canonicalUrl: "https://first.cms.tedix.dev",
			status: "provisioning" as const,
		};
		expect(await registerCmsSiteWithinQuota(db, input, 1)).toMatchObject({
			...input,
			status: "provisioning",
		});
		const identity = { siteId: input.id, slug: input.slug };
		expect(
			await activateCmsSiteAfterMedia(db, { ...identity, slug: "wrong" }),
		).toBeNull();
		sqlite.exec(`INSERT INTO cms_restore_fences (site_id, slug, generation, capture_id)
			VALUES ('site-one', 'first', 'generation', 'capture')`);
		expect(await activateCmsSiteAfterMedia(db, identity)).toBeNull();
		sqlite.exec("DELETE FROM cms_restore_fences WHERE site_id = 'site-one'");
		sqlite.exec(`INSERT INTO cms_deprovision_operations (id, organization_id, slug)
			VALUES ('site-one', 'org-one', 'first')`);
		expect(await activateCmsSiteAfterMedia(db, identity)).toBeNull();
		sqlite.exec("DELETE FROM cms_deprovision_operations WHERE id = 'site-one'");
		expect(await activateCmsSiteAfterMedia(db, identity)).toMatchObject({
			id: "site-one",
			status: "active",
		});
		expect(await activateCmsSiteAfterMedia(db, identity)).toBeNull();
	});

	it("inserts a site once and leaves the existing row intact on retry", async () => {
		const { db, sqlite } = fixture();
		const input = {
			id: "site-one",
			organizationId: "org-one",
			slug: "new-site",
			name: "New site",
			canonicalUrl: "https://new-site.cms.tedix.dev",
			templateSlug: "marketing",
			authoringAppId: "app-one",
		};
		const first = await registerCmsSiteIfAbsent(db, input);
		expect(first).toMatchObject(input);
		expect(
			await registerCmsSiteIfAbsent(db, {
				...input,
				id: "site-two",
				organizationId: "foreign-org",
			}),
		).toBeNull();
		expect((await getCmsSiteBySlug(db, input.slug))?.id).toBe("site-one");
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM cms_sites").get(),
		).toEqual({ count: 1 });
	});

	it("creates and reads a site without a tenant D1 column", async () => {
		const { db } = fixture();
		const created = await registerCmsSite(db, {
			id: "site-two",
			organizationId: "org-one",
			slug: "direct-site",
			name: "Direct site",
			canonicalUrl: "https://direct-site.cms.tedix.dev",
		});
		expect(
			(await getCmsSiteByHostname(db, "direct-site.cms.tedix.dev"))?.id,
		).toBe(created.id);
		expect((await listCmsSitesByOrganization(db, "org-one"))[0]?.id).toBe(
			created.id,
		);
		const updated = await updateCmsSiteDomain(db, {
			id: created.id,
			organizationId: "org-one",
			customDomain: "direct.example",
			canonicalUrl: "https://direct.example",
		});
		expect(updated?.customDomain).toBe("direct.example");
	});
});
