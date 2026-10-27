import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { cmsDomainClaims } from "../schema/cms-domain-claims";
import { organizations } from "../schema/organizations";
import {
	deleteOrganizationDomain,
	finishOrganizationDomainVerification,
	getOrganizationDomain,
	lockOrganizationDomain,
	reserveOrganizationDomain,
	resolveOrganizationHostname,
} from "./organization-domains";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(schemaDdl(organizations, cmsDomainClaims));
	sqlite.exec(`CREATE TABLE cms_sites (id TEXT PRIMARY KEY, custom_domain TEXT);
	INSERT INTO organizations (id,name,slug,features,descope_tenant_id) VALUES
	('org-a','Alpha','alpha','{"os":true}','tenant-a'), ('org-b','Beta','beta','{"os":true}','tenant-b'), ('disabled','Disabled','disabled','{}',NULL);
	INSERT INTO cms_sites VALUES ('legacy','legacy.example.com');`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}
const input = {
	id: "claim-a",
	organizationId: "org-a",
	hostname: "share.example.com",
	verificationToken: "a".repeat(64),
	expiresAt: new Date(Date.now() + 86400_000).toISOString(),
};

describe("organization domain claims on D1", () => {
	it("reserves globally across CMS, organizations and legacy domains", async () => {
		const { db } = fixture();
		expect(await reserveOrganizationDomain(db, input)).toMatchObject({
			kind: "organization",
			siteId: null,
		});
		expect(
			await reserveOrganizationDomain(db, {
				...input,
				id: "claim-b",
				organizationId: "org-b",
			}),
		).toBeNull();
		expect(
			await reserveOrganizationDomain(db, {
				...input,
				id: "second",
				hostname: "other.example.com",
			}),
		).toBeNull();
		expect(
			await reserveOrganizationDomain(db, {
				...input,
				id: "legacy",
				organizationId: "org-b",
				hostname: "legacy.example.com",
			}),
		).toBeNull();
		expect(
			await reserveOrganizationDomain(db, {
				...input,
				id: "disabled",
				organizationId: "disabled",
				hostname: "disabled.example.com",
			}),
		).toBeNull();
	});
	it("activates only the current organization lease, then cuts routing before provider cleanup", async () => {
		const { db } = fixture();
		await reserveOrganizationDomain(db, input);
		expect(await resolveOrganizationHostname(db, input.hostname)).toBeNull();
		expect(
			await lockOrganizationDomain(db, "org-b", input.id, "provisioning"),
		).toBeNull();
		const claim = (await lockOrganizationDomain(
			db,
			"org-a",
			input.id,
			"provisioning",
		))!;
		expect(
			await lockOrganizationDomain(db, "org-a", input.id, "provisioning"),
		).toBeNull();
		expect(
			await lockOrganizationDomain(db, "org-a", input.id, "removing"),
		).toBeNull();
		expect(
			await finishOrganizationDomainVerification(db, {
				...input,
				lease: "stale",
				status: "active",
				providerHostnameId: "provider",
			}),
		).toBeNull();
		await finishOrganizationDomainVerification(db, {
			...input,
			lease: claim.updatedAt,
			status: "active",
			providerHostnameId: "provider",
		});
		expect(
			await resolveOrganizationHostname(db, "SHARE.EXAMPLE.COM."),
		).toMatchObject({
			organizationId: "org-a",
			slug: "alpha",
			descopeTenantId: "tenant-a",
		});
		expect(
			await lockOrganizationDomain(db, "org-b", input.id, "removing"),
		).toBeNull();
		await lockOrganizationDomain(db, "org-a", input.id, "removing");
		expect(await resolveOrganizationHostname(db, input.hostname)).toBeNull();
		expect(
			await finishOrganizationDomainVerification(db, {
				...input,
				lease: claim.updatedAt,
				status: "active",
				providerHostnameId: "provider",
			}),
		).toBeNull();
		expect(await deleteOrganizationDomain(db, "org-b", input.id)).toBe(false);
		expect(await deleteOrganizationDomain(db, "org-a", input.id)).toBe(true);
		expect(await getOrganizationDomain(db, "org-a")).toBeNull();
	});
	it("refuses expired verification and disabled organizations on a fresh lookup", async () => {
		const { db, sqlite } = fixture();
		await reserveOrganizationDomain(db, {
			...input,
			expiresAt: "2000-01-01T00:00:00.000Z",
		});
		expect(
			await lockOrganizationDomain(db, "org-a", input.id, "provisioning"),
		).toBeNull();
		sqlite.exec(
			"UPDATE cms_domain_claims SET status='active', provider_hostname_id='provider'; UPDATE organizations SET features='{}' WHERE id='org-a'",
		);
		expect(await resolveOrganizationHostname(db, input.hostname)).toBeNull();
		expect(
			await lockOrganizationDomain(db, "org-a", input.id, "removing"),
		).not.toBeNull();
	});
});

describe("organization domain migration", () => {
	it("preserves existing CMS claims and foreign keys while allowing organization claims", () => {
		const sqlite = new DatabaseSync(":memory:");
		databases.push(sqlite);
		sqlite.exec(
			`PRAGMA foreign_keys=ON; CREATE TABLE organizations (id TEXT PRIMARY KEY); CREATE TABLE cms_sites (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-a'); INSERT INTO cms_sites VALUES ('site-a');`,
		);
		sqlite.exec(
			readFileSync(
				new URL(
					"../../drizzle/20260926205640_cms-domain-claims/migration.sql",
					import.meta.url,
				),
				"utf8",
			),
		);
		sqlite.exec(
			"ALTER TABLE cms_domain_claims ADD COLUMN kind TEXT NOT NULL DEFAULT 'primary'; INSERT INTO cms_domain_claims (id,organization_id,site_id,hostname,verification_token,expires_at,provider_hostname_id,status) VALUES ('existing','org-a','site-a','cms.example.com','proof','2027-01-01','provider','active');",
		);
		const before = sqlite.prepare("SELECT * FROM cms_domain_claims").all();
		sqlite.exec("BEGIN");
		sqlite.exec(
			readFileSync(
				new URL(
					"../../drizzle/20261027115059_organization-domains/migration.sql",
					import.meta.url,
				),
				"utf8",
			),
		);
		sqlite.exec("COMMIT");
		expect(sqlite.prepare("SELECT * FROM cms_domain_claims").all()).toEqual(
			before,
		);
		expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		sqlite.exec(
			"INSERT INTO cms_domain_claims (id,organization_id,hostname,kind,verification_token,expires_at) VALUES ('organization','org-a','share.example.com','organization','proof','2027-01-01')",
		);
		expect(
			sqlite
				.prepare(
					"SELECT site_id FROM cms_domain_claims WHERE id='organization'",
				)
				.get(),
		).toMatchObject({ site_id: null });
	});
});
