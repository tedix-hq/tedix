import {
	Kysely,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
	type Driver,
} from "../templates/marketing/node_modules/kysely";
import { describe, expect, it, vi } from "vite-plus/test";

import { inspectTargetDomain } from "../templates/marketing/node_modules/emdash/src/transfer/analyze/target";
import { inspectPortableDomain } from "../templates/marketing/node_modules/emdash/src/transfer/domain";
import { clearScaffold } from "../templates/marketing/node_modules/emdash/src/transfer/import/scaffold";
import {
	SchemaError,
	SchemaRegistry,
} from "../templates/marketing/node_modules/emdash/src/schema/registry";

const processDue = vi.hoisted(() => vi.fn());
vi.mock(
	"../templates/marketing/node_modules/emdash/src/media/usage/collection-deletion-processor",
	() => ({ processDueMediaUsageCollectionDeletions: processDue }),
);

/** Simulates a late deletion: the registry row and ec_* table are already gone. */
function targetWithDeletion() {
	let deletion: Record<string, string> | null = {
		collection_id: "old-pages",
		collection_slug: "pages",
		state: "retry",
		phase: "status",
	};
	const driver = {
		async init() {},
		async acquireConnection() {
			return {
				async executeQuery(query: { sql: string }) {
					const statement = query.sql;
					if (statement.includes("_emdash_media_usage_collection_deletions")) {
						return { rows: deletion ? [deletion] : [] };
					}
					return { rows: statement.startsWith("SELECT (SELECT") ? [{}] : [] };
				},
				async *streamQuery() {},
			};
		},
		async beginTransaction() {},
		async commitTransaction() {},
		async rollbackTransaction() {},
		async releaseConnection() {},
		async destroy() {},
	} as Driver;
	const db = new Kysely({
		dialect: {
			createAdapter: () => new SqliteAdapter(),
			createDriver: () => driver,
			createIntrospector: (database) => new SqliteIntrospector(database),
			createQueryCompiler: () => new SqliteQueryCompiler(),
		},
	});
	return { db, finishDeletion: () => (deletion = null) };
}

describe("Emdash import target preflight", () => {
	it("blocks a late-phase collection tombstone until deletion finalizes", async () => {
		const target = targetWithDeletion();
		try {
			const domain = await inspectPortableDomain(target.db as never);
			expect(domain.empty).toBe(false);
			expect(domain.blockers).toContainEqual({
				code: "collection_deletion_unfinished",
				id: "old-pages",
				slug: "pages",
				state: "retry",
				phase: "status",
			});
			expect(
				(await inspectTargetDomain(target.db as never, ["pages"])).blockers,
			).toContainEqual(
				expect.objectContaining({
					code: "target_not_empty",
					detail: {
						reason: "collection_deletion_unfinished",
						collection: "pages",
						state: "retry",
						phase: "status",
					},
				}),
			);

			target.finishDeletion();
			expect((await inspectPortableDomain(target.db as never)).empty).toBe(
				true,
			);
			expect(
				(await inspectTargetDomain(target.db as never, ["pages"])).blockers,
			).toEqual([]);
		} finally {
			await target.db.destroy();
		}
	});
});

describe("Emdash scaffold deletion recovery", () => {
	it("advances an exact active tombstone within the import fence", async () => {
		const deleteCollection = vi
			.spyOn(SchemaRegistry.prototype, "deleteCollection")
			.mockRejectedValue(new SchemaError("deletion in progress", "CONFLICT"));
		processDue.mockResolvedValue({ outcome: "progress" });
		let checkpoints = 0;
		const db = {
			selectFrom(table: string) {
				const query = {
					select(_column: string) {
						return query;
					},
					where(_column: string, _operator: string, _value: unknown) {
						return query;
					},
					async executeTakeFirst() {
						return table === "_emdash_collections"
							? { slug: "pages" }
							: { collection_id: "old-pages" };
					},
				};
				return query;
			},
		};
		const context = {
			db,
			plan: {
				transformations: [
					{
						code: "seeded_scaffold_removed",
						items: [{ type: "collection", id: "old-pages" }],
					},
				],
			},
			budget: { canStart: () => true, start: () => undefined },
		};
		try {
			expect(
				await clearScaffold(context as never, 0, async () => {
					checkpoints++;
				}),
			).toEqual({ state: "wait", step: 0 });
			expect(processDue).toHaveBeenCalledExactlyOnceWith(db);
			expect(checkpoints).toBe(0);
		} finally {
			deleteCollection.mockRestore();
			processDue.mockReset();
		}
	});
});
