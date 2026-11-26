import { DatabaseSync } from "node:sqlite";
import { createDbClient, type DbClient } from "../client";
import { describe, expect, it } from "vite-plus/test";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	listAppReferenceMetadataByOrganization,
	listAppReferenceMetadataBySlugs,
} from "./apps";
import { listConnectionToolPoliciesByAppIds } from "./tools";

function makeReadDb() {
	const selections: string[][] = [];
	let queryCount = 0;
	const node = {
		from: () => node,
		where: async () => {
			queryCount += 1;
			return [];
		},
	};
	return {
		db: {
			select: (selection: Record<string, unknown>) => {
				selections.push(Object.keys(selection));
				return node;
			},
		} as unknown as DbClient,
		selections,
		queryCount: () => queryCount,
	};
}

describe("connection reference bulk queries", () => {
	it("uses a narrow organization-scoped app seed projection", async () => {
		const mock = makeReadDb();
		await listAppReferenceMetadataByOrganization(mock.db, "org-1");

		expect(mock.queryCount()).toBe(1);
		expect(mock.selections).toEqual([
			["id", "slug", "name", "organizationId", "metadata"],
		]);
	});

	it("binds narrow app metadata projections as one JSON id set", async () => {
		const mock = makeReadDb();
		await listAppReferenceMetadataBySlugs(
			mock.db,
			Array.from({ length: 51 }, (_, index) => `app-${index}`),
		);

		expect(mock.queryCount()).toBe(1);
		expect(mock.selections).toEqual([
			["id", "slug", "name", "organizationId", "metadata"],
		]);
	});

	it("reads tool policies beyond 100 ids under the D1 parameter cap", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys = OFF");
			sqlite.exec(schemaDdl(appTools));
			const db = createDbClient(createD1Facade(sqlite));
			const ids = Array.from({ length: 151 }, (_, index) => `app-${index}`);
			for (const appId of [...ids, "outside"]) {
				await db.insert(appTools).values({
					id: appId,
					appId,
					toolId: "read",
					title: "Read",
					toolTypeId: "rpc",
					config: { auth: { type: "oauth", connectionId: "connection" } },
				});
			}
			const rows = await listConnectionToolPoliciesByAppIds(db, ids);
			expect(rows.map((row) => row.appId).sort()).toEqual([...ids].sort());
			expect(rows[0]).toMatchObject({
				toolId: "read",
				authType: "oauth",
				connectionId: "connection",
			});
		} finally {
			sqlite.close();
		}
	});

	it("binds narrow tool config projections as one JSON id set", async () => {
		const mock = makeReadDb();
		await listConnectionToolPoliciesByAppIds(
			mock.db,
			Array.from({ length: 51 }, (_, index) => `app-${index}`),
		);

		expect(mock.queryCount()).toBe(1);
		expect(mock.selections).toEqual([
			["appId", "toolId", "title", "meta", "authType", "connectionId"],
		]);
	});
});
