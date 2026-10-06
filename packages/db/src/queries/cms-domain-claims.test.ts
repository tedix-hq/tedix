import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	activateCmsDomainClaim,
	activateCmsWwwAliasClaim,
	adoptLegacyCmsDomainClaim,
	beginCmsDomainProvisioning,
	beginRemovingCmsDomainClaim,
	beginRemovingReplacedCmsDomainClaim,
	finishCmsDomainProvisioning,
	getCmsDomainClaimForSite,
	removeCmsDomainClaim,
	reserveCmsDomainClaim,
} from "./cms-domain-claims";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE cms_sites (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, slug TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active', custom_domain TEXT UNIQUE,
			canonical_url TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE cms_domain_claims (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, site_id TEXT NOT NULL,
			hostname TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'primary',
			verification_token TEXT NOT NULL,
			provider_hostname_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
			expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX cms_domain_claims_site_pending_unique
			ON cms_domain_claims(site_id) WHERE status = 'pending';
		INSERT INTO cms_sites VALUES
			('site-a', 'org-a', 'alpha', 'active', NULL, 'https://alpha.cms.tedix.dev', '2026-01-01'),
			('site-b', 'org-b', 'beta', 'active', 'legacy.example.com', 'https://legacy.example.com', '2026-01-01');
	`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

const key = { id: "claim-a", organizationId: "org-a", siteId: "site-a" };
const expiresAt = new Date(Date.now() + 60_000).toISOString();

describe("CMS domain claims on D1", () => {
	it("reserves a www alias only behind this site's active verified primary", async () => {
		const { db, sqlite } = fixture();
		const aliasKey = { ...key, id: "alias-a" };
		const aliasInput = {
			...aliasKey,
			kind: "www_alias" as const,
			hostname: "www.example.com",
			verificationToken: "alias-proof",
			expiresAt,
		};
		expect(await reserveCmsDomainClaim(db, aliasInput)).toBeNull();
		await reserveCmsDomainClaim(db, {
			...key,
			hostname: "example.com",
			verificationToken: "primary-proof",
			expiresAt,
		});
		const lease = await beginCmsDomainProvisioning(db, key);
		await finishCmsDomainProvisioning(db, {
			...key,
			providerHostnameId: "provider-primary",
			provisioningStartedAt: lease!.updatedAt,
		});
		await activateCmsDomainClaim(db, key);
		expect(await reserveCmsDomainClaim(db, aliasInput)).toMatchObject({
			kind: "www_alias",
			hostname: "www.example.com",
		});
		expect(
			await reserveCmsDomainClaim(db, {
				...aliasInput,
				id: "alias-foreign",
				organizationId: "org-b",
			}),
		).toBeNull();
		expect(
			await reserveCmsDomainClaim(db, {
				...aliasInput,
				id: "alias-wrong",
				hostname: "www.other.com",
			}),
		).toBeNull();
		expect(
			sqlite
				.prepare("SELECT custom_domain FROM cms_sites WHERE id='site-a'")
				.get(),
		).toEqual({ custom_domain: "example.com" });
	});

	it("activates a www alias without changing canonical and rejects a stale apex", async () => {
		const { db, sqlite } = fixture();
		await reserveCmsDomainClaim(db, {
			...key,
			hostname: "example.com",
			verificationToken: "primary-proof",
			expiresAt,
		});
		const primaryLease = await beginCmsDomainProvisioning(db, key);
		await finishCmsDomainProvisioning(db, {
			...key,
			providerHostnameId: "provider-primary",
			provisioningStartedAt: primaryLease!.updatedAt,
		});
		await activateCmsDomainClaim(db, key);
		const aliasKey = { ...key, id: "alias-a" };
		await reserveCmsDomainClaim(db, {
			...aliasKey,
			kind: "www_alias",
			hostname: "www.example.com",
			verificationToken: "alias-proof",
			expiresAt,
		});
		const aliasLease = await beginCmsDomainProvisioning(db, aliasKey);
		await finishCmsDomainProvisioning(db, {
			...aliasKey,
			providerHostnameId: "provider-alias",
			provisioningStartedAt: aliasLease!.updatedAt,
		});
		expect(await activateCmsDomainClaim(db, aliasKey)).toBeNull();
		expect(await activateCmsWwwAliasClaim(db, aliasKey)).toMatchObject({
			status: "active",
			kind: "www_alias",
		});
		expect(
			sqlite
				.prepare(
					"SELECT custom_domain, canonical_url FROM cms_sites WHERE id='site-a'",
				)
				.get(),
		).toEqual({
			custom_domain: "example.com",
			canonical_url: "https://example.com",
		});
		expect(await activateCmsWwwAliasClaim(db, aliasKey)).toBeNull();
		expect(await beginRemovingCmsDomainClaim(db, aliasKey)).toMatchObject({
			status: "removing",
		});
		expect(
			sqlite
				.prepare(
					"SELECT custom_domain, canonical_url FROM cms_sites WHERE id='site-a'",
				)
				.get(),
		).toEqual({
			custom_domain: "example.com",
			canonical_url: "https://example.com",
		});
		expect(await removeCmsDomainClaim(db, aliasKey)).toBe(true);
		await reserveCmsDomainClaim(db, {
			...aliasKey,
			kind: "www_alias",
			hostname: "www.example.com",
			verificationToken: "alias-proof-2",
			expiresAt,
		});
		sqlite.exec(
			"UPDATE cms_domain_claims SET status='pending' WHERE id='alias-a'",
		);
		sqlite.exec(
			"UPDATE cms_sites SET custom_domain='different.com' WHERE id='site-a'",
		);
		expect(await activateCmsWwwAliasClaim(db, aliasKey)).toBeNull();
	});
	it("reserves a fresh hostname only for an owned site and leaves routing unchanged", async () => {
		const { db, sqlite } = fixture();
		const claim = await reserveCmsDomainClaim(db, {
			...key,
			hostname: "Blog.Example.com",
			verificationToken: "proof",
			expiresAt,
		});
		expect(claim?.hostname).toBe("blog.example.com");
		expect(claim?.status).toBe("pending");
		expect(
			sqlite
				.prepare("SELECT custom_domain FROM cms_sites WHERE id='site-a'")
				.get(),
		).toEqual({ custom_domain: null });
		expect(
			await reserveCmsDomainClaim(db, {
				...key,
				id: "claim-other",
				hostname: "blog.example.com",
				verificationToken: "other",
				expiresAt,
			}),
		).toBeNull();
		expect(
			await reserveCmsDomainClaim(db, {
				...key,
				id: "claim-foreign",
				organizationId: "foreign-org",
				hostname: "new.example.com",
				verificationToken: "proof",
				expiresAt,
			}),
		).toBeNull();
	});

	it("rejects a legacy active hostname atomically", async () => {
		const { db } = fixture();
		expect(
			await reserveCmsDomainClaim(db, {
				...key,
				hostname: "legacy.example.com",
				verificationToken: "proof",
				expiresAt,
			}),
		).toBeNull();
	});

	it("lets the owner of a legacy site verify its existing hostname", async () => {
		const { db } = fixture();
		const claim = await reserveCmsDomainClaim(db, {
			id: "claim-legacy",
			organizationId: "org-b",
			siteId: "site-b",
			hostname: "legacy.example.com",
			verificationToken: "new-proof",
			expiresAt,
		});
		expect(claim).toMatchObject({
			siteId: "site-b",
			hostname: "legacy.example.com",
			status: "pending",
		});
	});

	it("adopts only a matching active legacy route without changing it", async () => {
		const { db, sqlite } = fixture();
		const legacyKey = {
			id: "claim-legacy",
			organizationId: "org-b",
			siteId: "site-b",
		};
		await reserveCmsDomainClaim(db, {
			...legacyKey,
			hostname: "legacy.example.com",
			verificationToken: "new-proof",
			expiresAt,
		});
		expect(
			await adoptLegacyCmsDomainClaim(db, {
				...legacyKey,
				providerHostnameId: "provider-legacy",
			}),
		).toMatchObject({
			status: "active",
			providerHostnameId: "provider-legacy",
		});
		expect(
			sqlite
				.prepare(
					"SELECT custom_domain, canonical_url FROM cms_sites WHERE id='site-b'",
				)
				.get(),
		).toEqual({
			custom_domain: "legacy.example.com",
			canonical_url: "https://legacy.example.com",
		});
		expect(
			await adoptLegacyCmsDomainClaim(db, {
				...legacyKey,
				providerHostnameId: "other-provider",
			}),
		).toBeNull();
	});

	it("does not adopt a legacy claim after route, owner, or site status changes", async () => {
		const { db, sqlite } = fixture();
		const legacyKey = {
			id: "claim-legacy",
			organizationId: "org-b",
			siteId: "site-b",
		};
		await reserveCmsDomainClaim(db, {
			...legacyKey,
			hostname: "legacy.example.com",
			verificationToken: "new-proof",
			expiresAt,
		});
		expect(
			await adoptLegacyCmsDomainClaim(db, {
				...legacyKey,
				organizationId: "org-a",
				providerHostnameId: "provider-legacy",
			}),
		).toBeNull();
		expect(
			await adoptLegacyCmsDomainClaim(db, {
				...legacyKey,
				providerHostnameId: "",
			}),
		).toBeNull();
		sqlite.exec("UPDATE cms_sites SET status='paused' WHERE id='site-b'");
		expect(
			await adoptLegacyCmsDomainClaim(db, {
				...legacyKey,
				providerHostnameId: "provider-legacy",
			}),
		).toBeNull();
		sqlite.exec(
			"UPDATE cms_sites SET status='active', custom_domain='different.example.com' WHERE id='site-b'",
		);
		expect(
			await adoptLegacyCmsDomainClaim(db, {
				...legacyKey,
				providerHostnameId: "provider-legacy",
			}),
		).toBeNull();
	});

	it("marks an unbound legacy route for exact provider cleanup before deletion", async () => {
		const { db, sqlite } = fixture();
		const legacyKey = {
			id: "claim-legacy",
			organizationId: "org-b",
			siteId: "site-b",
		};
		await reserveCmsDomainClaim(db, {
			...legacyKey,
			hostname: "legacy.example.com",
			verificationToken: "new-proof",
			expiresAt,
		});
		expect(await beginRemovingCmsDomainClaim(db, legacyKey)).toMatchObject({
			status: "removing_legacy",
			providerHostnameId: null,
		});
		expect(
			sqlite
				.prepare("SELECT custom_domain FROM cms_sites WHERE id='site-b'")
				.get(),
		).toEqual({ custom_domain: null });
		expect(await removeCmsDomainClaim(db, legacyKey)).toBe(true);
	});

	it("does not reserve a claim after the site is paused", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec("UPDATE cms_sites SET status='paused' WHERE id='site-a'");
		expect(
			await reserveCmsDomainClaim(db, {
				...key,
				hostname: "blog.example.com",
				verificationToken: "proof",
				expiresAt,
			}),
		).toBeNull();
	});

	it("fences provider creation and preserves the ID after a site pause", async () => {
		const { db, sqlite } = fixture();
		await reserveCmsDomainClaim(db, {
			...key,
			hostname: "blog.example.com",
			verificationToken: "proof",
			expiresAt,
		});
		const lease = await beginCmsDomainProvisioning(db, key);
		expect(lease).toMatchObject({
			status: "provisioning",
		});
		expect(await beginCmsDomainProvisioning(db, key)).toBeNull();
		expect(
			await reserveCmsDomainClaim(db, {
				...key,
				id: "second-claim",
				hostname: "other.example.com",
				verificationToken: "other",
				expiresAt,
			}),
		).toBeNull();
		expect(await beginRemovingCmsDomainClaim(db, key)).toBeNull();
		sqlite.exec("UPDATE cms_sites SET status='paused' WHERE id='site-a'");
		expect(
			await finishCmsDomainProvisioning(db, {
				...key,
				providerHostnameId: "provider-a",
				provisioningStartedAt: lease!.updatedAt,
			}),
		).toMatchObject({ status: "pending", providerHostnameId: "provider-a" });
		expect(await activateCmsDomainClaim(db, key)).toBeNull();
	});

	it("recovers a stale provisioning lease for removal", async () => {
		const { db, sqlite } = fixture();
		await reserveCmsDomainClaim(db, {
			...key,
			hostname: "blog.example.com",
			verificationToken: "proof",
			expiresAt,
		});
		await beginCmsDomainProvisioning(db, key);
		const staleAt = new Date("2026-01-01T00:00:00.000Z");
		sqlite
			.prepare("UPDATE cms_domain_claims SET updated_at=? WHERE id=?")
			.run(staleAt.toISOString(), key.id);
		expect(
			await beginRemovingCmsDomainClaim(
				db,
				key,
				new Date("2026-01-01T00:04:59.000Z"),
			),
		).toBeNull();
		expect(
			await beginRemovingCmsDomainClaim(
				db,
				key,
				new Date("2026-01-01T00:05:01.000Z"),
			),
		).toMatchObject({ status: "removing_provisioning" });
		expect(await removeCmsDomainClaim(db, key)).toBe(true);
	});

	it("reclaims a stale provisioning lease without accepting the old provider ID", async () => {
		const { db, sqlite } = fixture();
		await reserveCmsDomainClaim(db, {
			...key,
			hostname: "blog.example.com",
			verificationToken: "proof",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		});
		const oldLease = await beginCmsDomainProvisioning(db, key);
		sqlite.exec(
			"UPDATE cms_domain_claims SET updated_at='2026-01-01T00:00:00.000Z' WHERE id='claim-a'",
		);
		const newLease = await beginCmsDomainProvisioning(
			db,
			key,
			new Date(Date.now() + 6 * 60 * 1000),
		);
		expect(newLease).toMatchObject({ status: "provisioning" });
		expect(newLease?.updatedAt).not.toBe(oldLease?.updatedAt);
		expect(
			await finishCmsDomainProvisioning(db, {
				...key,
				providerHostnameId: "provider-old",
				provisioningStartedAt: oldLease!.updatedAt,
			}),
		).toBeNull();
		expect(
			await finishCmsDomainProvisioning(db, {
				...key,
				providerHostnameId: "provider-new",
				provisioningStartedAt: newLease!.updatedAt,
			}),
		).toMatchObject({ status: "pending", providerHostnameId: "provider-new" });
	});

	it("activates only a live, provisioned claim and restores the site slug on removal", async () => {
		const { db, sqlite } = fixture();
		await reserveCmsDomainClaim(db, {
			...key,
			hostname: "blog.example.com",
			verificationToken: "proof",
			expiresAt,
		});
		expect(await activateCmsDomainClaim(db, key)).toBeNull();
		const lease = await beginCmsDomainProvisioning(db, key);
		expect(lease).toMatchObject({
			status: "provisioning",
		});
		expect(
			await finishCmsDomainProvisioning(db, {
				...key,
				providerHostnameId: "provider-a",
				provisioningStartedAt: lease!.updatedAt,
			}),
		).toMatchObject({ providerHostnameId: "provider-a" });
		expect(await activateCmsDomainClaim(db, key)).toMatchObject({
			status: "active",
		});
		expect(
			sqlite
				.prepare(
					"SELECT custom_domain, canonical_url FROM cms_sites WHERE id='site-a'",
				)
				.get(),
		).toEqual({
			custom_domain: "blog.example.com",
			canonical_url: "https://blog.example.com",
		});
		expect(await beginRemovingCmsDomainClaim(db, key)).toMatchObject({
			status: "removing",
		});
		expect(
			sqlite
				.prepare(
					"SELECT custom_domain, canonical_url FROM cms_sites WHERE id='site-a'",
				)
				.get(),
		).toEqual({
			custom_domain: null,
			canonical_url: "https://alpha.cms.tedix.dev",
		});
		expect(await removeCmsDomainClaim(db, key)).toBe(true);
		expect(await getCmsDomainClaimForSite(db, key)).toBeNull();
	});

	it("replacement cleanup cannot remove the currently routed hostname", async () => {
		const { db, sqlite } = fixture();
		await reserveCmsDomainClaim(db, {
			...key,
			hostname: "old.example.com",
			verificationToken: "proof",
			expiresAt,
		});
		const oldLease = await beginCmsDomainProvisioning(db, key);
		await finishCmsDomainProvisioning(db, {
			...key,
			providerHostnameId: "provider-old",
			provisioningStartedAt: oldLease!.updatedAt,
		});
		await activateCmsDomainClaim(db, key);
		expect(await beginRemovingReplacedCmsDomainClaim(db, key)).toBeNull();
		const nextKey = { ...key, id: "claim-new" };
		await reserveCmsDomainClaim(db, {
			...nextKey,
			hostname: "new.example.com",
			verificationToken: "proof",
			expiresAt,
		});
		const newLease = await beginCmsDomainProvisioning(db, nextKey);
		await finishCmsDomainProvisioning(db, {
			...nextKey,
			providerHostnameId: "provider-new",
			provisioningStartedAt: newLease!.updatedAt,
		});
		await activateCmsDomainClaim(db, nextKey);
		expect(await beginRemovingReplacedCmsDomainClaim(db, nextKey)).toBeNull();
		expect(await beginRemovingReplacedCmsDomainClaim(db, key)).toMatchObject({
			status: "removing",
		});
		expect(
			sqlite
				.prepare("SELECT custom_domain FROM cms_sites WHERE id='site-a'")
				.get(),
		).toEqual({ custom_domain: "new.example.com" });
	});
});
