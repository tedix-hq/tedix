import { DatabaseSync } from "node:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { createDbClient } from "../../client";
import { apps } from "../../schema/apps";
import { appCatalog, appCatalogHealthHistory } from "../../schema/catalog";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { calculateCatalogAppUptime } from "./health-history";

const NOW = "2026-10-21T12:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) =>
	new Date(Date.parse(NOW) - days * DAY).toISOString();
type Status = typeof appCatalogHealthHistory.$inferInsert.status;

describe("calculateCatalogAppUptime", () => {
	let sqlite: DatabaseSync;
	let db: ReturnType<typeof createDbClient>;
	const queries: string[] = [];

	beforeEach(async () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse(NOW));
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(apps, appCatalog, appCatalogHealthHistory));
		db = createDbClient(
			createD1Facade(sqlite, { onPrepare: (query) => queries.push(query) }),
		);
		for (const id of ["example-app", "other-app"]) {
			await db.insert(appCatalog).values({
				id,
				name: id,
				slug: id,
				toolSource: "upstream_mcp",
				connectorType: "MCP",
				lastSyncedAt: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			});
		}
		queries.length = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		sqlite.close();
	});

	async function check(status: Status, days = 1, catalogAppId = "example-app") {
		await db.insert(appCatalogHealthHistory).values({
			id: crypto.randomUUID(),
			catalogAppId,
			checkedAt: daysAgo(days),
			status,
		});
	}

	it("counts older eligible checks beyond the newest 100 in the window", async () => {
		for (let index = 0; index < 100; index++) {
			await check(index % 2 === 0 ? "healthy" : "degraded", 1);
			await check("unhealthy", 20);
		}
		await check("healthy", 31);
		await check("unhealthy", 1, "other-app");
		for (const status of [
			"requires_auth",
			"blocked",
			"unsupported",
			"unknown",
		] as const) {
			await check(status, 0);
		}

		queries.length = 0;
		expect(await calculateCatalogAppUptime(db, "example-app")).toBe(50);
		expect(queries).toHaveLength(1);
		const rows = sqlite
			.prepare(queries[0]!)
			.all("example-app", "healthy", "degraded", "unhealthy", daysAgo(30));
		expect(rows).toEqual([{ eligible_checks: 200, up_checks: 100 }]);
	});

	it("includes the requested cutoff and excludes checks just before it", async () => {
		await check("healthy", 1);
		await check("unhealthy", 7);
		await check("healthy", 7 + 1 / DAY);
		expect(await calculateCatalogAppUptime(db, "example-app", 7)).toBe(50);
	});

	it("defaults to 30 days", async () => {
		await check("healthy", 30);
		await check("unhealthy", 30 + 1 / DAY);
		expect(await calculateCatalogAppUptime(db, "example-app")).toBe(100);
	});

	it.each([
		[["healthy", "degraded", "unhealthy"], (2 / 3) * 100],
		[["healthy", "degraded"], 100],
		[["unhealthy", "unhealthy"], 0],
		[["requires_auth", "blocked", "unsupported", "unknown"], null],
		[[], null],
	] as [Status[], number | null][])(
		"returns the percentage for %j",
		async (statuses, expected) => {
			for (const status of statuses) await check(status);
			expect(await calculateCatalogAppUptime(db, "example-app")).toBe(expected);
		},
	);

	it("returns null when eligible checks belong to another app or precede the window", async () => {
		await check("healthy", 1, "other-app");
		await check("unhealthy", 31);
		expect(await calculateCatalogAppUptime(db, "example-app")).toBeNull();
	});

	it("preserves a zero-day request as an unbounded time window", async () => {
		await check("healthy", 1);
		await check("unhealthy", 90);
		expect(await calculateCatalogAppUptime(db, "example-app", 0)).toBe(50);
	});
});
