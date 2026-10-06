import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	embeddedContactUsers,
	providerInstallations,
} from "../schema/provider-installations";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getEmbeddedContactCompany,
	getEmbeddedContactUser,
	identifyEmbeddedContact,
	listEmbeddedContacts,
	resolveProviderContactInstallation,
} from "./embedded-contacts";
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(organizations, providerInstallations, embeddedContactUsers),
	);
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(organizations).values({
		id: "customer",
		name: "Original company",
		slug: "customer",
		descopeTenantId: "customer",
	});
	const installation = {
		id: "installed",
		providerOrganizationId: "provider",
		providerAppId: "app",
		providerApiKeyId: "key",
		externalTenantId: "367",
		customerOrganizationId: "customer",
		primaryWorkspaceId: "workspace",
		primaryTediId: "tedi",
		allowedOrigin: "https://host.example",
		hostTenantArgument: "companyId",
		hostTenantNamespace: "host",
		provisionedBy: "test",
		status: "paused" as const,
		pausedAt: "2026-09-12T00:00:00Z",
	};
	await db.insert(providerInstallations).values(installation);
	return { db, sqlite };
}
const base = {
	providerOrganizationId: "provider",
	installationId: "installed",
	hostUserId: "1743",
	now: "2026-09-12T00:00:00Z",
};
describe("durable embedded profiles", () => {
	it("identifies paused installations without analytics or granting access", async () => {
		const { db } = await fixture();
		expect(
			await resolveProviderContactInstallation(db, {
				providerOrganizationId: "provider",
				providerApiKeyId: "key",
				externalTenantId: "367",
			}),
		).toMatchObject({ status: "paused" });
		const result = await identifyEmbeddedContact(db, {
			...base,
			hostRole: "owner",
			profile: {
				user: {
					name: "Daniel",
					email: "demo@acme.example",
					customAttributes: { count: 0, active: false },
				},
				company: { name: "Acme", customAttributes: { plan: "pro" } },
			},
		});
		expect(result.user).toMatchObject({
			name: "Daniel",
			email: "demo@acme.example",
			customAttributes: { count: 0, active: false },
		});
		expect(result.company?.companyProfile?.name).toBe("Acme");
		const [installation] = await db.select().from(providerInstallations);
		expect(installation.status).toBe("paused");
		expect(installation.provenance).toBeNull();
	});
	it("preserves omissions, clears explicit null, and does not resurrect older labels", async () => {
		const { db } = await fixture();
		await identifyEmbeddedContact(db, {
			...base,
			profile: {
				user: {
					name: "Name",
					email: "a@example.com",
					customAttributes: { a: 1, b: false },
				},
				company: { name: "Company" },
			},
		});
		const next = await identifyEmbeddedContact(db, {
			...base,
			now: "2026-09-13T00:00:00Z",
			profile: {
				user: { name: null, customAttributes: { a: null, c: 0 } },
				company: { name: null },
			},
		});
		expect(next.user).toMatchObject({
			name: null,
			email: "a@example.com",
			customAttributes: { b: false, c: 0 },
			firstSeenAt: base.now,
			lastSeenAt: "2026-09-13T00:00:00Z",
		});
		expect(next.company?.companyProfile?.name).toBeNull();
		const clear = await identifyEmbeddedContact(db, {
			...base,
			profile: { user: { email: null, customAttributes: null } },
		});
		expect(clear.user).toMatchObject({ email: null, customAttributes: {} });
	});
	it("isolates provider keys, directory reads, and writes", async () => {
		const { db } = await fixture();
		for (const input of [
			{
				providerOrganizationId: "other",
				providerApiKeyId: "key",
				externalTenantId: "367",
			},
			{
				providerOrganizationId: "provider",
				providerApiKeyId: "other",
				externalTenantId: "367",
			},
		])
			expect(
				await resolveProviderContactInstallation(db, input),
			).toBeUndefined();
		await expect(
			identifyEmbeddedContact(db, {
				...base,
				providerOrganizationId: "other",
				profile: { user: { name: "Wrong" } },
			}),
		).rejects.toThrow("not found");
		expect(
			await getEmbeddedContactCompany(db, "other", "installed"),
		).toBeUndefined();
		expect(
			await getEmbeddedContactUser(db, "other", "installed", "1743"),
		).toBeUndefined();
	});
	it("searches persisted email and IDs with pagination beyond event windows", async () => {
		const { db } = await fixture();
		for (const [hostUserId, email] of [
			["1", "first@example.com"],
			["2", "second@example.com"],
			["3", "third@example.com"],
		])
			await identifyEmbeddedContact(db, {
				...base,
				hostUserId,
				profile: { user: { email } },
			});
		const page = await listEmbeddedContacts(db, {
			providerOrganizationId: "provider",
			kind: "people",
			limit: 1,
			offset: 1,
		});
		expect(page.total).toBe(3);
		expect(page.people[0].hostUserId).toBe("2");
		expect(page.companies).toHaveLength(1);
		expect(
			(
				await listEmbeddedContacts(db, {
					providerOrganizationId: "provider",
					kind: "people",
					search: "third@",
					limit: 50,
					offset: 0,
				})
			).people[0].hostUserId,
		).toBe("3");
		expect(
			(
				await listEmbeddedContacts(db, {
					providerOrganizationId: "provider",
					kind: "people",
					installationId: "installed",
					hostUserIds: ["3"],
					limit: 100,
					offset: 0,
				})
			).people.map((row) => row.hostUserId),
		).toEqual(["3"]);
		expect(
			(
				await listEmbeddedContacts(db, {
					providerOrganizationId: "other",
					kind: "people",
					limit: 50,
					offset: 0,
				})
			).total,
		).toBe(0);
		expect(
			(
				await listEmbeddedContacts(db, {
					providerOrganizationId: "provider",
					kind: "people",
					search: "%",
					limit: 50,
					offset: 0,
				})
			).total,
		).toBe(0);
	});
	it("preserves simultaneous sparse updates to one user", async () => {
		const { db } = await fixture();
		await Promise.all([
			identifyEmbeddedContact(db, {
				...base,
				profile: { user: { customAttributes: { a: 1 } } },
			}),
			identifyEmbeddedContact(db, {
				...base,
				profile: { user: { customAttributes: { b: 2 } } },
			}),
		]);
		expect(
			(await getEmbeddedContactUser(db, "provider", "installed", "1743"))
				?.customAttributes,
		).toEqual({ a: 1, b: 2 });
	});
	it("keeps the same host user distinct across businesses and preserves concurrent company patches", async () => {
		const { db } = await fixture();
		const [first] = await db.select().from(providerInstallations);
		await db
			.insert(providerInstallations)
			.values({ ...first, id: "second", externalTenantId: "999" });
		await identifyEmbeddedContact(db, {
			...base,
			profile: { user: { name: "First business user" } },
		});
		await identifyEmbeddedContact(db, {
			...base,
			installationId: "second",
			profile: { user: { name: "Second business user" } },
		});
		expect(
			(await getEmbeddedContactUser(db, "provider", "installed", "1743"))?.name,
		).toBe("First business user");
		expect(
			(await getEmbeddedContactUser(db, "provider", "second", "1743"))?.name,
		).toBe("Second business user");
		await Promise.all([
			identifyEmbeddedContact(db, {
				...base,
				profile: { company: { customAttributes: { a: 1 } } },
			}),
			identifyEmbeddedContact(db, {
				...base,
				profile: { company: { customAttributes: { b: 2 } } },
			}),
		]);
		expect(
			(await getEmbeddedContactCompany(db, "provider", "installed"))
				?.companyProfile?.customAttributes,
		).toEqual({ a: 1, b: 2 });
		expect(
			(
				await listEmbeddedContacts(db, {
					providerOrganizationId: "provider",
					kind: "companies",
					search: "999",
					offset: 0,
					limit: 50,
				})
			).companies.map((row) => row.installationId),
		).toEqual(["second"]);
	});
	it("bounds the merged attribute count across incremental updates", async () => {
		const { db } = await fixture();
		const customAttributes = Object.fromEntries(
			Array.from({ length: 50 }, (_, i) => [`key${i}`, i]),
		);
		await identifyEmbeddedContact(db, {
			...base,
			profile: { user: { customAttributes } },
		});
		await expect(
			identifyEmbeddedContact(db, {
				...base,
				profile: { user: { customAttributes: { overflow: 1 } } },
			}),
		).rejects.toThrow();
		expect(
			(await getEmbeddedContactUser(db, "provider", "installed", "1743"))
				?.customAttributes,
		).toEqual(customAttributes);
	});
});
