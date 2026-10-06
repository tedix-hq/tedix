import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { setAppGatewayMembership } from "./app-records";

function fixture() {
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
			aggregateApps: [{ slug: "existing", prefix: "keep", toolIds: ["read"] }],
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
			setAppGatewayMembership(db, "org", "gateway", "acme", true),
			setAppGatewayMembership(db, "org", "gateway", "drive", true),
		]);
		expect(read()).toEqual({
			...metadata,
			mcpConfig: {
				...metadata.mcpConfig,
				aggregateApps: [
					...metadata.mcpConfig.aggregateApps,
					{ slug: "acme" },
					{ slug: "drive" },
				],
			},
		});
	});
	it("is idempotent and preserves existing per-app restrictions", async () => {
		const { db, read, metadata } = fixture();
		await setAppGatewayMembership(db, "org", "gateway", "existing", true);
		expect(read()).toEqual(metadata);
		await setAppGatewayMembership(db, "org", "gateway", "missing", false);
		expect(read()).toEqual(metadata);
		await setAppGatewayMembership(db, "org", "gateway", "existing", false);
		expect(read().mcpConfig.aggregateApps).toEqual([]);
		expect(read().mcpConfig.toolScopes).toEqual(metadata.mcpConfig.toolScopes);
		await setAppGatewayMembership(db, "org", "gateway", "existing", true);
		expect(read()).toEqual(metadata);
	});
	it("cannot mutate a different tenant's gateway", async () => {
		const { db, read, metadata } = fixture();
		expect(
			await setAppGatewayMembership(db, "foreign", "gateway", "acme", true),
		).toEqual([]);
		expect(read()).toEqual(metadata);
	});
});
