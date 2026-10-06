import {
	Kysely,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
	type Driver,
} from "../templates/marketing/node_modules/kysely";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import {
	createCoalescingDialect as createTedixCoalescingDialect,
	createDialect as createTedixDialect,
} from "../templates/tedix/src/lib/worker-loader-do-sql-runtime";
import {
	createCoalescingDialect as createMarketingCoalescingDialect,
	createDialect as createMarketingDialect,
} from "../templates/marketing/src/lib/worker-loader-do-sql-runtime";
import { withTransaction as withTedixTransaction } from "../templates/tedix/node_modules/emdash/src/database/transaction";
import { withTransaction as withMarketingTransaction } from "../templates/marketing/node_modules/emdash/src/database/transaction";

const dialects = [
	["tedix", createTedixDialect, withTedixTransaction],
	["tedix coalescing", createTedixCoalescingDialect, withTedixTransaction],
	["marketing", createMarketingDialect, withMarketingTransaction],
	[
		"marketing coalescing",
		createMarketingCoalescingDialect,
		withMarketingTransaction,
	],
] as const;

describe("Emdash Worker Loader DO transaction handling", () => {
	for (const [name, createDialect, withTransaction] of dialects) {
		it(`${name} executes without probing unsupported transactions`, async () => {
			const db = new Kysely<never>({
				dialect: createDialect({ binding: "DB_DO" }),
			});
			try {
				expect(
					(db.getExecutor().adapter as { supportsTransactions?: boolean })
						.supportsTransactions,
				).toBe(false);
				const transaction = vi
					.spyOn(db, "transaction")
					.mockImplementation(() => {
						throw new Error("DO transaction probe was attempted");
					});
				await expect(
					withTransaction(db, async () => "completed"),
				).resolves.toBe("completed");
				expect(transaction).not.toHaveBeenCalled();
			} finally {
				await db.destroy();
			}
		});
	}

	it("continues using a transaction for an ordinary SQLite adapter", async () => {
		let begun = 0;
		let committed = 0;
		const driver: Driver = {
			async init() {},
			async acquireConnection() {
				return {
					async executeQuery() {
						return { rows: [] };
					},
					async *streamQuery() {},
				};
			},
			async beginTransaction() {
				begun++;
			},
			async commitTransaction() {
				committed++;
			},
			async rollbackTransaction() {},
			async releaseConnection() {},
			async destroy() {},
		};
		const db = new Kysely<never>({
			dialect: {
				createAdapter: () => new SqliteAdapter(),
				createDriver: () => driver,
				createIntrospector: (database) => new SqliteIntrospector(database),
				createQueryCompiler: () => new SqliteQueryCompiler(),
			},
		});
		try {
			await expect(
				withTedixTransaction(db, async () => "committed"),
			).resolves.toBe("committed");
			expect(begun).toBe(1);
			expect(committed).toBe(1);
		} finally {
			await db.destroy();
		}
	});
});
