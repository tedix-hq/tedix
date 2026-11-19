import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { policyPacks } from "../schema/control-plane";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getInstallationTrustPolicy } from "./installation-trust";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

const policy = {
	version: 1,
	aggregate: {
		sharedSourceOrganizationIds: ["org-publisher"],
		aggregateHostOrganizationIds: ["org-host"],
	},
};

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(policyPacks));
	const db = createDbClient(createD1Facade(sqlite));
	const insert = (overrides: Record<string, unknown> = {}) =>
		db.insert(policyPacks).values({
			id: "trust-1",
			name: "Installation trust",
			slug: "installation-trust",
			scope: "system",
			organizationId: null,
			target: "shared",
			status: "active",
			version: 1,
			publishedAt: "2026-01-01T00:00:00.000Z",
			publishedBy: "platform-operator",
			definition: { installationTrust: policy },
			...overrides,
		} as typeof policyPacks.$inferInsert);
	return { db, insert };
}

describe("installation trust authority", () => {
	it("requires an exact ownerless system publication", async () => {
		for (const overrides of [
			{ organizationId: "org-publisher" },
			{ scope: "organization" },
			{ target: "app" },
			{ status: "draft" },
			{ status: "archived" },
			{ publishedAt: null },
			{ publishedAt: "invalid" },
			{ publishedBy: "" },
		]) {
			const { db, insert } = fixture();
			await insert(overrides);
			expect(await getInstallationTrustPolicy(db)).toBeNull();
		}
	});

	it("follows the published revision without trusting organization lookalikes", async () => {
		const { db, insert } = fixture();
		await insert();
		await insert({ id: "trust-2", version: 2 });
		await insert({
			id: "tenant-trust",
			scope: "organization",
			organizationId: "org-host",
			version: 9,
		});
		expect(await getInstallationTrustPolicy(db)).toEqual(policy);
	});

	it("does not revive a previous grant when its head is revoked or malformed", async () => {
		for (const override of [
			{ status: "archived" },
			{ definition: { installationTrust: { ...policy, version: 2 } } },
			{ definition: { installationTrust: policy, unexpectedAuthority: true } },
		]) {
			const { db, insert } = fixture();
			await insert();
			await insert({ id: "trust-2", version: 2, ...override });
			expect(await getInstallationTrustPolicy(db)).toBeNull();
		}
	});

	it("keeps reading aggregate authority from published revisions with retired scan data", async () => {
		const { db, insert } = fixture();
		await insert({
			definition: {
				installationTrust: {
					...policy,
					catalogScan: {
						endpoints: [{ url: "https://old-tools.example/mcp" }],
					},
				},
			},
		});
		expect(await getInstallationTrustPolicy(db)).toEqual(policy);
	});

	it("still rejects unexpected aggregate authority fields", async () => {
		const { db, insert } = fixture();
		await insert({
			definition: {
				installationTrust: {
					...policy,
					aggregate: { ...policy.aggregate, unexpectedAuthority: true },
				},
			},
		});
		expect(await getInstallationTrustPolicy(db)).toBeNull();
	});
});
