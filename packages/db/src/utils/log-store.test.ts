import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { configureLogStore, createDbClient, getLogStores } from "../client";
import { logPartition } from "../schema/logs-db";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { mergeLogStoreRows, readLogStores } from "./log-store";

function store(partition?: { from: string; to?: string }) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(logPartition));
	if (partition)
		sqlite
			.prepare("INSERT INTO log_partition VALUES (?, ?, ?, ?, ?)")
			.run(
				"partition-example",
				partition.to ? "sealed" : "active",
				partition.from,
				partition.to ?? null,
				"2026-01-01T00:00:00.000Z",
			);
	const binding = createD1Facade(sqlite);
	return { sqlite, binding, db: createDbClient(binding) };
}

afterEach(() => vi.useRealTimers());

describe("log partition directory", () => {
	it("keeps main-only fallback and treats an empty directory as an open range", async () => {
		const main = store();
		const logs = store();
		const read = vi.fn(async () => []);
		expect(await readLogStores(main.db, read)).toBeNull();
		expect(read).not.toHaveBeenCalled();
		configureLogStore(main.db, { LOGS_DB_1: logs.binding });
		expect(await readLogStores(main.db, read, { to: "2000-01-01" })).toEqual([
			[],
			[],
		]);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("discovers numbered partitions, reads all without a range and dedupes main first", async () => {
		const main = store();
		const active = store({ from: "2026-03-01" });
		const old = store({ from: "2026-01-01", to: "2026-01-31" });
		const middle = store({ from: "2026-02-01", to: "2026-02-28" });
		configureLogStore(main.db, {
			LOGS_DB_12: middle.binding,
			LOGS_DB_2: old.binding,
			LOGS_DB: active.binding,
			LOGS_DB_COPY: store().binding,
		});
		const stores = getLogStores(main.db)!;
		expect(stores.partitions.map((p) => p.binding)).toEqual([
			"LOGS_DB",
			"LOGS_DB_2",
			"LOGS_DB_12",
		]);
		expect(stores.logs?.$client).toBe(createDbClient(active.binding).$client);
		const pages = await readLogStores(main.db, async (db) => [
			{
				id: "duplicate",
				source: db.$client === main.db.$client ? "main" : "logs",
			},
			{
				id: stores.partitions.find((p) => p.db === db)?.binding ?? "main",
				source: "unique",
			},
		]);
		expect(pages).toHaveLength(4);
		const rows = mergeLogStoreRows(pages!);
		expect(rows).toHaveLength(5);
		expect(rows[0]).toEqual({ id: "duplicate", source: "main" });
		expect(mergeLogStoreRows(pages!, { offset: 2, limit: 1 })).toEqual([
			{ id: "LOGS_DB", source: "unique" },
		]);
	});

	it("skips non-overlapping partitions and includes boundary timestamps", async () => {
		const main = store();
		const active = store({ from: "2026-03-01" });
		const old = store({ from: "2026-01-01", to: "2026-02-01" });
		configureLogStore(main.db, {
			LOGS_DB: active.binding,
			LOGS_DB_7: old.binding,
		});
		const read = vi.fn(async (db) => db.$client);
		expect(
			await readLogStores(main.db, read, {
				from: "2026-02-01",
				to: "2026-02-01",
			}),
		).toEqual([main.db.$client, old.db.$client]);
		expect(read).toHaveBeenCalledTimes(2);
		expect(await readLogStores(main.db, read, { from: "2026-04-01" })).toEqual([
			main.db.$client,
			active.db.$client,
		]);
	});

	it("caches directory reads across request clients and refreshes after 30 seconds", async () => {
		vi.useFakeTimers();
		const main = store();
		const logs = store({ from: "2026-01-01", to: "2026-02-01" });
		const prepare = vi.spyOn(logs.binding, "prepare");
		const otherRequest = createDbClient(main.binding);
		configureLogStore(main.db, { LOGS_DB_1: logs.binding });
		configureLogStore(otherRequest, { LOGS_DB_1: logs.binding });
		await Promise.all([
			readLogStores(main.db, async () => []),
			readLogStores(otherRequest, async () => []),
		]);
		expect(prepare).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_001);
		await readLogStores(main.db, async () => []);
		expect(prepare).toHaveBeenCalledTimes(2);
	});

	it("surfaces partition query failures instead of returning a partial timeline", async () => {
		const main = store();
		const logs = store();
		configureLogStore(main.db, { LOGS_DB_1: logs.binding });
		await expect(
			readLogStores(main.db, async (db) => {
				if (db.$client === logs.db.$client)
					throw new Error("partition unavailable");
				return [{ id: "main" }];
			}),
		).rejects.toThrow("partition unavailable");
	});

	it("surfaces directory failures and retries them without caching an empty partition", async () => {
		const main = store();
		const logs = store();
		logs.sqlite.exec("DROP TABLE log_partition");
		configureLogStore(main.db, { LOGS_DB_1: logs.binding });
		await expect(readLogStores(main.db, async () => [])).rejects.toThrow();
		logs.sqlite.exec(schemaDdl(logPartition));
		expect(await readLogStores(main.db, async () => [])).toEqual([[], []]);
	});

	it("rejects ambiguous directories and invalid sealed bounds", async () => {
		const main = store();
		const logs = store({ from: "2026-01-01", to: "2026-02-01" });
		logs.sqlite.exec(
			"INSERT INTO log_partition VALUES ('second', 'active', '2026-02-01', NULL, '2026-02-01')",
		);
		configureLogStore(main.db, { LOGS_DB_1: logs.binding });
		await expect(readLogStores(main.db, async () => [])).rejects.toThrow(
			"Multiple log_partition rows",
		);
		logs.sqlite.exec(
			"DELETE FROM log_partition WHERE id = 'second'; UPDATE log_partition SET to_ts = NULL",
		);
		await expect(readLogStores(main.db, async () => [])).rejects.toThrow(
			"Invalid log_partition",
		);
	});

	it("supports historical-only bindings without redirecting writers and ignores duplicate bindings", async () => {
		const main = store();
		const logs = store();
		configureLogStore(main.db, {
			LOGS_DB_4: logs.binding,
			LOGS_DB_8: logs.binding,
		});
		expect(getLogStores(main.db)?.logs).toBeUndefined();
		expect(await readLogStores(main.db, async () => [])).toEqual([[], []]);
	});
});
