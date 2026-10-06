import type { DbClient } from "../client";
import { describe, expect, it } from "vite-plus/test";
import {
	listAppReferenceMetadataByOrganization,
	listAppReferenceMetadataBySlugs,
} from "./apps";
import { listToolConnectionReferencesByAppIds } from "./tools";

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
			["id", "slug", "organizationId", "metadata"],
		]);
	});

	it("chunks narrow app metadata projections below the D1 parameter cap", async () => {
		const mock = makeReadDb();
		await listAppReferenceMetadataBySlugs(
			mock.db,
			Array.from({ length: 51 }, (_, index) => `app-${index}`),
		);

		expect(mock.queryCount()).toBe(2);
		expect(mock.selections).toEqual([
			["id", "slug", "organizationId", "metadata"],
			["id", "slug", "organizationId", "metadata"],
		]);
	});

	it("chunks narrow tool config projections below the D1 parameter cap", async () => {
		const mock = makeReadDb();
		await listToolConnectionReferencesByAppIds(
			mock.db,
			Array.from({ length: 51 }, (_, index) => `app-${index}`),
		);

		expect(mock.queryCount()).toBe(2);
		expect(mock.selections).toEqual([
			["appId", "connectionId"],
			["appId", "connectionId"],
		]);
	});
});
