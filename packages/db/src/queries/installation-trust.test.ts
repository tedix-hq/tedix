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
	catalogScan: {
		endpoints: [
			{
				url: "https://tools.example/mcp",
				transport: "mcp",
				headers: {},
			},
		],
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

	it("rejects malformed endpoint grants and secret header injection", async () => {
		for (const endpoint of [
			{ url: "http://tools.example/mcp", transport: "mcp", headers: {} },
			{
				url: "https://user:password@tools.example/mcp",
				transport: "mcp",
				headers: {},
			},
			{
				url: "https://tools.example/mcp#fragment",
				transport: "mcp",
				headers: {},
			},
			{
				url: "https://tools.example/mcp",
				transport: "mcp",
				headers: { Authorization: "secret" },
			},
		]) {
			const { db, insert } = fixture();
			await insert({
				definition: {
					installationTrust: {
						...policy,
						catalogScan: { endpoints: [endpoint] },
					},
				},
			});
			expect(await getInstallationTrustPolicy(db)).toBeNull();
		}
	});
});
