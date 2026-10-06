import { describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "../client";
import { listTediRuntimeMetaBySlugs } from "./tedis";

/**
 * Minimal drizzle double: `select().from().where()` resolves to `rows`.
 * `select` is a spy so we can assert the empty-slug guard short-circuits before
 * touching the database.
 */
function makeDb(rows: unknown[]): {
	db: DbClient;
	select: ReturnType<typeof vi.fn>;
} {
	const node = {
		from: () => node,
		where: () => Promise.resolve(rows),
	};
	const select = vi.fn(() => node);
	return { db: { select } as unknown as DbClient, select };
}

describe("listTediRuntimeMetaBySlugs", () => {
	it("short-circuits on an empty slug list without querying", async () => {
		const { db, select } = makeDb([{ slug: "x" }]);
		const out = await listTediRuntimeMetaBySlugs(db, []);
		expect(out).toEqual([]);
		expect(select).not.toHaveBeenCalled();
	});

	it("dedups slugs before querying (guard survives all-duplicate input)", async () => {
		const { db, select } = makeDb([]);
		// All-duplicate, non-empty input must still query (unique set is non-empty).
		await listTediRuntimeMetaBySlugs(db, ["a", "a", "a"]);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("returns the served projection rows unchanged", async () => {
		const rows = [
			{
				slug: "cto",
				id: "id-cto",
				organizationId: "org-1",
				runtimeKind: "agent",
				runtimeState: "active",
				status: "active",
			},
		];
		const { db } = makeDb(rows);
		const out = await listTediRuntimeMetaBySlugs(db, ["cto"]);
		expect(out).toEqual(rows);
	});
});
