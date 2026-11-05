import { expect, test } from "vite-plus/test";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { createPostgresTestDb } from "./postgres";

const harnessRows = pgTable("harness_rows", {
	id: text().primaryKey(),
	value: integer().notNull(),
});

test("runs Drizzle Postgres queries in an isolated PGlite database", async () => {
	const db = await createPostgresTestDb();
	await db.$client.exec(`
		CREATE TABLE harness_rows (
			id text PRIMARY KEY,
			value integer NOT NULL
		)
	`);
	await db.insert(harnessRows).values({ id: "first", value: 7 });

	await expect(db.select().from(harnessRows)).resolves.toEqual([
		{ id: "first", value: 7 },
	]);
});

test("resets the shared engine between parity tests", async () => {
	const db = await createPostgresTestDb();
	await db.$client.exec(`
		CREATE TABLE harness_rows (
			id text PRIMARY KEY,
			value integer NOT NULL
		)
	`);

	await expect(db.select().from(harnessRows)).resolves.toEqual([]);
});
