/**
 * D1 rejects any statement carrying more than 100 bound parameters, and
 * `catalog.list` accepts `limit` up to 200. Every id-keyed lookup that fans a
 * page of catalog app ids into an `inArray(...)` therefore has to batch, or the
 * endpoint 500s for exactly the large pages that `/sitemap-apps.xml` requests —
 * which is how the app catalog silently dropped out of the sitemap.
 */

import { describe, expect, it } from "vite-plus/test";
import { catalogRouterTestInternals } from "./catalog";

const { CATALOG_ID_LOOKUP_BATCH_SIZE, selectByCatalogAppIds } =
	catalogRouterTestInternals;

const D1_BOUND_PARAM_LIMIT = 100;
const CATALOG_LIST_MAX_LIMIT = 200;

const ids = (count: number) =>
	Array.from({ length: count }, (_, index) => `app-${index}`);

describe("selectByCatalogAppIds", () => {
	it("keeps every batch under the D1 bound-parameter ceiling", () => {
		expect(CATALOG_ID_LOOKUP_BATCH_SIZE).toBeLessThan(D1_BOUND_PARAM_LIMIT);
	});

	it("batches a max-limit page instead of binding all ids at once", async () => {
		const batches: string[][] = [];

		await selectByCatalogAppIds(ids(CATALOG_LIST_MAX_LIMIT), async (batch) => {
			batches.push(batch);
			return [];
		});

		expect(batches.length).toBeGreaterThan(1);
		for (const batch of batches) {
			expect(batch.length).toBeLessThanOrEqual(D1_BOUND_PARAM_LIMIT);
		}
	});

	it("covers every id exactly once, in order, and concatenates the rows", async () => {
		const appIds = ids(CATALOG_LIST_MAX_LIMIT + 7);

		const rows = await selectByCatalogAppIds(appIds, async (batch) =>
			batch.map((id) => ({ id })),
		);

		expect(rows.map((row) => row.id)).toEqual(appIds);
	});

	it("issues no query for an empty id list", async () => {
		let calls = 0;

		const rows = await selectByCatalogAppIds([], async () => {
			calls += 1;
			return [];
		});

		expect(calls).toBe(0);
		expect(rows).toEqual([]);
	});
});
