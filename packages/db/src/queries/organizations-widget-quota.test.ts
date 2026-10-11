import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	listOrganizationWidgetQuotaStatus,
	projectOrganizationWidgetQuota,
} from "./organizations";

describe("projectOrganizationWidgetQuota", () => {
	it("returns null per ceiling when the quota was never set", () => {
		expect(projectOrganizationWidgetQuota(null)).toEqual({
			visitorTurnsPerHour: null,
			originTurnsPerHour: null,
		});
		expect(
			projectOrganizationWidgetQuota({ tediWidget: { version: 1 } }),
		).toEqual({ visitorTurnsPerHour: null, originTurnsPerHour: null });
	});

	it("projects each ceiling independently and drops malformed values", () => {
		expect(
			projectOrganizationWidgetQuota({
				tediWidget: { version: 1, turnQuota: { visitorTurnsPerHour: 40 } },
			}),
		).toEqual({ visitorTurnsPerHour: 40, originTurnsPerHour: null });
		expect(
			projectOrganizationWidgetQuota({
				tediWidget: {
					version: 1,
					turnQuota: {
						visitorTurnsPerHour: -1,
						originTurnsPerHour: 2.5,
					},
				},
			}),
		).toEqual({ visitorTurnsPerHour: null, originTurnsPerHour: null });
	});
});

describe("listOrganizationWidgetQuotaStatus", () => {
	it("lists active organizations with only their widget quota", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(organizations));
		const db = createDbClient(createD1Facade(sqlite));
		try {
			await db.insert(organizations).values([
				{
					id: "org-set",
					name: "Quota set",
					slug: "quota-set",
					metadata: {
						contactEmail: "ops@example.test",
						tediWidget: {
							version: 1,
							turnQuota: { visitorTurnsPerHour: 20, originTurnsPerHour: 500 },
						},
					},
				},
				{ id: "org-unset", name: "Quota unset", slug: "quota-unset" },
				{
					id: "org-retired",
					name: "Retired",
					slug: "retired",
					metadata: { retiredAt: "2026-01-01T00:00:00.000Z" } as never,
				},
			]);

			const rows = await listOrganizationWidgetQuotaStatus(db);

			expect(rows).toEqual([
				{
					id: "org-set",
					slug: "quota-set",
					name: "Quota set",
					visitorTurnsPerHour: 20,
					originTurnsPerHour: 500,
				},
				{
					id: "org-unset",
					slug: "quota-unset",
					name: "Quota unset",
					visitorTurnsPerHour: null,
					originTurnsPerHour: null,
				},
			]);
			for (const row of rows) {
				expect(row).not.toHaveProperty("metadata");
				expect(row).not.toHaveProperty("contactEmail");
			}
		} finally {
			sqlite.close();
		}
	});
});
