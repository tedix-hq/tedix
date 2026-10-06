import { DatabaseSync } from "node:sqlite";
import { getColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { apps } from "../schema/apps";
import { appToolCspDomains } from "../schema/configuration";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { getAppBySlugWithTools } from "./app-records";

/**
 * `getAppBySlugWithTools` hydrates every enabled tool for an app. For the
 * aggregate gateway app that is hundreds of tools of raw input_schema, and
 * building it several times at once in one isolate exhausts the Worker memory
 * limit.
 *
 * The guarantee under test is narrow on purpose — concurrent identical reads
 * share one execution, and nothing is retained afterwards, so this can never
 * serve a stale tool surface.
 */

/**
 * DDL derived from the Drizzle definitions rather than hand-written, so a new
 * column on `apps`/`app_tools` cannot silently break this suite the way a
 * hand-maintained copy would.
 */
function ddlFor(table: SQLiteTable): string {
	const columns = Object.values(getColumns(table));
	const name = getTableName(table);
	const defs = columns.map((column) => {
		const type = column.getSQLType();
		return `"${column.name}" ${type}${column.primary ? " PRIMARY KEY" : ""}`;
	});
	return `CREATE TABLE ${name} (${defs.join(", ")});`;
}

const DDL = [appToolCspDomains, appTools, apps]
	.map((table) => ddlFor(table as SQLiteTable))
	.join("\n");

function db(): { client: DbClient; counts: () => number } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	sqlite
		.prepare(
			"INSERT INTO apps (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run("app-1", "tedix", "Tedix", "2026-07-30", "2026-07-30");
	for (let i = 0; i < 5; i += 1) {
		sqlite
			.prepare(
				"INSERT INTO app_tools (id, app_id, tool_id, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)",
			)
			.run(`tool-${i}`, "app-1", `list_${i}`, i, "2026-07-30", "2026-07-30");
	}
	let selects = 0;
	const facade = createD1Facade(sqlite);
	const counted = new Proxy(facade as object, {
		get(target, prop, receiver) {
			if (prop === "prepare") selects += 1;
			return Reflect.get(target, prop, receiver);
		},
	});
	return {
		client: createDbClient(counted as never),
		counts: () => selects,
	};
}

describe("getAppBySlugWithTools single-flight", () => {
	it("collapses concurrent identical reads onto one execution", async () => {
		const { client, counts } = db();
		const [a, b, c] = await Promise.all([
			getAppBySlugWithTools(client, "tedix"),
			getAppBySlugWithTools(client, "tedix"),
			getAppBySlugWithTools(client, "tedix"),
		]);
		// Same object identity: they shared one in-flight read rather than each
		// materialising the full tool surface.
		expect(a).toBe(b);
		expect(b).toBe(c);
		expect(a?.tools).toHaveLength(5);
		expect(counts()).toBeGreaterThan(0);
	});

	it("does not retain the surface once settled", async () => {
		const { client } = db();
		const first = await getAppBySlugWithTools(client, "tedix");
		const second = await getAppBySlugWithTools(client, "tedix");
		// Sequential reads must re-execute. If these were identical the map would
		// be acting as an unbounded cache and could serve a stale tool surface.
		expect(first).not.toBe(second);
		expect(second?.tools).toHaveLength(5);
	});

	it("does not share between different tool selections", async () => {
		const { client } = db();
		const [all, narrowed] = await Promise.all([
			getAppBySlugWithTools(client, "tedix"),
			getAppBySlugWithTools(client, "tedix", { toolIds: ["list_1"] }),
		]);
		expect(all).not.toBe(narrowed);
		expect(all?.tools).toHaveLength(5);
		expect(narrowed?.tools).toHaveLength(1);
	});

	it("shares a rejection and then clears, so a failure cannot pin the entry", async () => {
		const sqlite = new DatabaseSync(":memory:");
		// No tables: the read throws.
		const broken = createDbClient(createD1Facade(sqlite));
		const results = await Promise.allSettled([
			getAppBySlugWithTools(broken, "tedix"),
			getAppBySlugWithTools(broken, "tedix"),
		]);
		expect(results.every((r) => r.status === "rejected")).toBe(true);
		// The failed entry must not persist: a later good client still works.
		const { client } = db();
		expect((await getAppBySlugWithTools(client, "tedix"))?.tools).toHaveLength(
			5,
		);
	});
});
