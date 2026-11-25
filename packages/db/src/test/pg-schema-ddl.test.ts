import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { sql } from "drizzle-orm";
import {
	pgTable,
	text,
	integer,
	boolean,
	check,
	uniqueIndex,
	unique,
	primaryKey,
} from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import { pgTableDdl } from "./pg-schema-ddl";

it("enforces partial expression uniqueness, checks, composite uniqueness and foreign key actions", async () => {
	const parent = pgTable("ddl_parent", { id: text().primaryKey() });
	const child = pgTable(
		"ddl_child",
		{
			id: integer().notNull(),
			parentId: text("parent_id")
				.notNull()
				.references(() => parent.id, {
					onDelete: "cascade",
					onUpdate: "cascade",
				}),
			email: text().notNull(),
			active: boolean().notNull(),
			rank: integer().notNull(),
		},
		(t) => [
			primaryKey({ columns: [t.parentId, t.id] }),
			unique("ddl_child_rank_unique").on(t.parentId, t.rank),
			check("ddl_child_rank_positive", sql`${t.rank} > 0`),
			uniqueIndex("ddl_child_active_email")
				.on(sql`lower(${t.email})`)
				.where(sql`${t.active}`),
		],
	);
	const engine = new PGlite();
	try {
		for (const table of [parent, child])
			for (const ddl of pgTableDdl(table)) await engine.exec(ddl);
		await engine.exec(
			"INSERT INTO ddl_parent VALUES ('parent'); INSERT INTO ddl_child VALUES (1,'parent','Name@example.test',true,1)",
		);
		await engine.exec(
			"INSERT INTO ddl_child VALUES (2,'parent','NAME@example.test',false,2), (3,'parent','NAME@example.test',false,3)",
		);
		await expect(
			engine.exec(
				"INSERT INTO ddl_child VALUES (4,'parent','NAME@example.test',true,4)",
			),
		).rejects.toMatchObject({ code: "23505" });
		await expect(
			engine.exec(
				"INSERT INTO ddl_child VALUES (4,'parent','other@example.test',false,1)",
			),
		).rejects.toMatchObject({ code: "23505" });
		await expect(
			engine.exec(
				"INSERT INTO ddl_child VALUES (4,'parent','other@example.test',false,0)",
			),
		).rejects.toMatchObject({ code: "23514" });
		await expect(
			engine.exec(
				"INSERT INTO ddl_child VALUES (4,'absent','other@example.test',false,4)",
			),
		).rejects.toMatchObject({ code: "23503" });
		await engine.exec("UPDATE ddl_parent SET id='renamed' WHERE id='parent'");
		expect(
			(await engine.query("SELECT DISTINCT parent_id FROM ddl_child")).rows,
		).toEqual([{ parent_id: "renamed" }]);
		await engine.exec("DELETE FROM ddl_parent");
		expect((await engine.query("SELECT * FROM ddl_child")).rows).toEqual([]);
	} finally {
		await engine.close();
	}
});

it("ports the Work Item count triggers with backfill, owner moves and rollback", async () => {
	const engine = new PGlite();
	try {
		await engine.exec(`CREATE TABLE work_items(id text PRIMARY KEY, org_id text NOT NULL);
CREATE TABLE work_item_org_counts(org_id text PRIMARY KEY, total bigint NOT NULL);
INSERT INTO work_items VALUES ('one','org'),('two','org');`);
		await engine.exec(
			readFileSync(
				new URL("../../examples/pg-work-item-counts.sql", import.meta.url),
				"utf8",
			),
		);
		await engine.exec(
			"UPDATE work_items SET org_id='org' WHERE id='one'; INSERT INTO work_items VALUES ('three','org'); UPDATE work_items SET org_id='other' WHERE id='one'; DELETE FROM work_items WHERE id='two'",
		);
		const counts = async () =>
			(
				await engine.query(
					"SELECT org_id, total::int FROM work_item_org_counts ORDER BY org_id",
				)
			).rows;
		expect(await counts()).toEqual([
			{ org_id: "org", total: 1 },
			{ org_id: "other", total: 1 },
		]);
		await engine.exec(
			"BEGIN; INSERT INTO work_items VALUES ('rollback','org'); UPDATE work_items SET org_id='org' WHERE id='one'; DELETE FROM work_items WHERE id='three'; ROLLBACK",
		);
		expect(await counts()).toEqual([
			{ org_id: "org", total: 1 },
			{ org_id: "other", total: 1 },
		]);
	} finally {
		await engine.close();
	}
});
