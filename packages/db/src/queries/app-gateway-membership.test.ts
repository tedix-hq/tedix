import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { setAppGatewayMembership } from "./app-records";

const EXISTING = {
	appId: "00000000-0000-4000-8000-000000000001",
	slug: "existing",
};
const ACME = { appId: "00000000-0000-4000-8000-000000000002", slug: "acme" };
const DRIVE = { appId: "00000000-0000-4000-8000-000000000003", slug: "drive" };

function fixture(
	aggregateApps: unknown[] = [
		{ ...EXISTING, prefix: "keep", toolIds: ["read"] },
	],
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE apps (id TEXT PRIMARY KEY, organization_id TEXT, metadata TEXT, updated_at TEXT)",
	);
	const metadata = {
		custom: { untouched: true },
		mcpConfig: {
			authMode: "authenticated",
			inactiveAggregateApps: [],
			toolScopes: { read: ["apps:read"] },
			aggregateApps,
		},
	};
	sqlite
		.prepare("INSERT INTO apps VALUES (?, ?, ?, ?)")
		.run("gateway", "org", JSON.stringify(metadata), "before");
	const read = () =>
		JSON.parse(
			sqlite.prepare("SELECT metadata FROM apps WHERE id = ?").get("gateway")!
				.metadata as string,
		);
	return { db: createDbClient(createD1Facade(sqlite)), read, metadata };
}
describe("atomic gateway membership", () => {
	it("adds concurrently without losing other members or settings", async () => {
		const { db, read, metadata } = fixture();
		await Promise.all([
			setAppGatewayMembership(db, "org", "gateway", ACME, true),
			setAppGatewayMembership(db, "org", "gateway", DRIVE, true),
		]);
		expect(read()).toEqual({
			...metadata,
			mcpConfig: {
				...metadata.mcpConfig,
				aggregateApps: [...metadata.mcpConfig.aggregateApps, ACME, DRIVE],
			},
		});
	});
	it("is idempotent and preserves existing per-app restrictions", async () => {
		const { db, read, metadata } = fixture();
		await setAppGatewayMembership(db, "org", "gateway", EXISTING, true);
		expect(read()).toEqual(metadata);
		await setAppGatewayMembership(db, "org", "gateway", ACME, false);
		expect(read()).toEqual(metadata);
		await setAppGatewayMembership(db, "org", "gateway", EXISTING, false);
		expect(read().mcpConfig.aggregateApps).toEqual([]);
		expect(read().mcpConfig.toolScopes).toEqual(metadata.mcpConfig.toolScopes);
		await setAppGatewayMembership(db, "org", "gateway", EXISTING, true);
		expect(read()).toEqual(metadata);
	});
	it("matches an old slug-only entry and stamps the app id onto it", async () => {
		const { db, read } = fixture([{ slug: "existing", prefix: "keep" }]);
		await setAppGatewayMembership(db, "org", "gateway", EXISTING, true);
		expect(read().mcpConfig.aggregateApps).toEqual([
			{ ...EXISTING, prefix: "keep" },
		]);
	});
	it("still finds an entry by id after the app was renamed", async () => {
		const { db, read } = fixture([{ ...EXISTING, prefix: "keep" }]);
		const renamed = { appId: EXISTING.appId, slug: "existing-renamed" };
		await setAppGatewayMembership(db, "org", "gateway", renamed, true);
		expect(read().mcpConfig.aggregateApps).toEqual([
			{ ...renamed, prefix: "keep" },
		]);
		await setAppGatewayMembership(db, "org", "gateway", renamed, false);
		expect(read().mcpConfig.aggregateApps).toEqual([]);
		expect(read().mcpConfig.inactiveAggregateApps).toEqual([
			{ ...renamed, prefix: "keep" },
		]);
	});
	it("does not treat another app that took the old slug as the member", async () => {
		const { db, read, metadata } = fixture();
		const impostor = {
			appId: "00000000-0000-4000-8000-000000000009",
			slug: "existing",
		};
		await setAppGatewayMembership(db, "org", "gateway", impostor, false);
		expect(read()).toEqual(metadata);
	});
	it("cannot mutate a different tenant's gateway", async () => {
		const { db, read, metadata } = fixture();
		expect(
			await setAppGatewayMembership(db, "foreign", "gateway", ACME, true),
		).toEqual([]);
		expect(read()).toEqual(metadata);
	});
});
