import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { getTableName, is, Table, type Column } from "drizzle-orm";
import type { AnyRelations } from "drizzle-orm/relations";
import { relations as d1Relations } from "../schema/relations";
import { relations } from "./relations";
import * as schema from "./core";
import { createPGliteFacade } from "../test/pglite-facade";
import { pgTableDdl } from "../test/pg-schema-ddl";

function graph(config: AnyRelations) {
	return Object.fromEntries(
		Object.entries(config).map(([key, table]) => [
			key,
			{
				table: getTableName(table.table as Table),
				relations: Object.fromEntries(
					Object.entries(table.relations).map(([name, relation]) => [
						name,
						{
							type: relation.relationType,
							target: relation.targetTableName,
							alias: relation.alias,
							from: relation.sourceColumns.map((c) => [
								c._.tableName,
								(c._.column as Column).name,
								c._.through?._.tableName,
								c._.through?._.key,
							]),
							to: relation.targetColumns.map((c) => [
								c._.tableName,
								(c._.column as Column).name,
								c._.through?._.tableName,
								c._.through?._.key,
							]),
						},
					]),
				),
			},
		]),
	);
}

it("preserves every canonical relationship and covers all current db.query table accesses", () => {
	const pg = graph(relations);
	for (const [name, config] of Object.entries(graph(d1Relations)))
		expect(pg[name], name).toEqual(config);
	expect(Object.keys(relations).sort()).toEqual(
		Object.entries(schema)
			.filter(([, value]) => is(value, Table))
			.map(([name]) => name)
			.sort(),
	);
	const queries = new URL("../queries/", import.meta.url);
	for (const file of readdirSync(queries, {
		recursive: true,
		encoding: "utf8",
	})) {
		if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
		const source = readFileSync(new URL(file, queries), "utf8");
		for (const match of source.matchAll(/\bdb\.query\.(\w+)/g))
			expect(relations, `${file}: ${match[0]}`).toHaveProperty(match[1]!);
	}
});

it("loads nested to-many and reverse to-one relationships through the pg facade", async () => {
	const { db, engine, close } = await createPGliteFacade();
	try {
		for (const table of [schema.organizations, schema.organizationMembers])
			for (const ddl of pgTableDdl(table)) await engine.exec(ddl);
		await engine.exec(
			"INSERT INTO organizations(id,name,slug) VALUES ('org','Org','org'),('other','Other','other'); INSERT INTO organization_members(id,organization_id,descope_user_id,email) VALUES ('member','org','person','person@example.test'),('foreign','other','someone','other@example.test')",
		);
		const org = await db.query.organizations.findFirst({
			where: { id: "org" },
			columns: { id: true },
			with: {
				members: {
					columns: { id: true },
					with: { organization: { columns: { id: true } } },
				},
			},
		});
		expect(org).toEqual({
			id: "org",
			members: [{ id: "member", organization: { id: "org" } }],
		});
	} finally {
		await close();
	}
});
