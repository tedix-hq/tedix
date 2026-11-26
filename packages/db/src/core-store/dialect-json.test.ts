import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import { workItemComments } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import { createPGliteFacade } from "../test/pglite-facade";
import { coreTable, createCoreStore } from "./client";
import { jsonParameter, jsonWrite } from "./dialect";

const nativeUrl = process.env.TEST_POSTGRES_URL;
for (const store of ["d1", "pglite", "postgres"] as const) {
	describe.skipIf(store === "postgres" && !nativeUrl)(store, () => {
		it("preserves JSON types in bound inserts and nested builder writes", async () => {
			let db: DbQueryClient;
			let close: () => void | Promise<void>;
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				db = createDbQueryClient(createD1Facade(sqlite));
				close = () => sqlite.close();
			} else if (store === "pglite") {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
			} else {
				const url = new URL(nativeUrl!);
				if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
					throw new Error("TEST_POSTGRES_URL must be loopback");
				const admin = postgres(url.href, { max: 1 });
				const schema = `json_${randomUUID().replaceAll("-", "")}`;
				try {
					await admin.unsafe(`CREATE SCHEMA "${schema}"`);
				} catch (error) {
					await admin.end();
					throw error;
				}
				url.searchParams.set("options", `-c search_path=${schema}`);
				const core = createCoreStore({
					CORE_STORE: "postgres",
					CORE_HYPERDRIVE: { connectionString: url.href },
				});
				db = core.db;
				close = async () => {
					try {
						await core.close();
						await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
					} finally {
						await admin.end();
					}
				};
			}
			try {
				// Only these columns are needed to exercise the shared helpers and driver.
				await db.run(
					sql.raw(
						`CREATE TABLE work_item_comments (id TEXT PRIMARY KEY, metadata ${store === "d1" ? "TEXT" : "JSONB"})`,
					),
				);
				const table = coreTable(db, workItemComments);
				const values = [
					null,
					'quote"\\; -- $1 雪',
					{ seo: { title: "Keep" } },
					[1, "two", null, { three: true }],
					true,
					false,
					42.5,
				];
				for (const [index, value] of values.entries()) {
					const id = String(index);
					const rootType =
						store === "d1"
							? sql`json_type(${table.metadata})`
							: sql`jsonb_typeof(${table.metadata})`;
					const [, roots] = await db.batch([
						db.run(sql`INSERT INTO ${table} (id, metadata)
							SELECT ${id}, ${jsonParameter(db, value)}`),
						db
							.select({ metadata: table.metadata })
							.from(table)
							.where(eq(table.id, id)),
					]);
					expect(roots[0]?.metadata).toEqual(value);
					const root = await db.get<{ kind: string; absent: number | boolean }>(
						sql`SELECT ${rootType} AS kind, metadata IS NULL AS absent FROM ${table} WHERE id = ${id}`,
					);
					expect(Boolean(root?.absent)).toBe(false);
					if (value === null) expect(root?.kind).toBe("null");
					const seed = { seo: { title: "Keep" } };
					const [, written] = await db.batch([
						db
							.update(table)
							.set({ metadata: jsonParameter(db, seed) })
							.where(eq(table.id, id)),
						db
							.update(table)
							.set({
								metadata: jsonWrite(
									db,
									table.metadata,
									["changed", "nested"],
									value,
								),
							})
							.where(eq(table.id, id))
							.returning({ metadata: table.metadata }),
					]);
					expect(written[0]?.metadata).toEqual({
						...seed,
						changed: { nested: value },
					});
				}
			} finally {
				await close();
			}
		}, 30000);
	});
}
