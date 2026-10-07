import { DatabaseSync } from "node:sqlite";
import { getColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { apps } from "../schema/apps";
import { appToolCspDomains } from "../schema/configuration";
import { organizations } from "../schema/organizations";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { getAppBySlugWithTools, getAppsBySlugsWithTools } from "./app-records";

/**
 * `getAppsBySlugsWithTools` is the batched form of `getAppBySlugWithTools`.
 *
 * The MCP aggregate rebuild resolves ~40 apps and was issuing one
 * `apps.getBySlugWithTools` per app; each apps/api invocation pays a
 * per-isolate startup cost, so the fan-out pushed entries past the gateway's
 * per-entry deadline and degraded the surface.
 *
 * The guarantees under test are the ones a caller depends on to replace N calls
 * with one: the result is positionally complete, per-app tool ORDER matches the
 * single-app query, and per-entry tool SELECTION is honoured independently.
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

const DDL = [appToolCspDomains, appTools, apps, organizations]
	.map((table) => ddlFor(table as SQLiteTable))
	.join("\n");

function db(extraToolCount = 0): {
	client: DbClient;
	sqlite: DatabaseSync;
	statements: () => string[];
} {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	const insertApp = sqlite.prepare(
		"INSERT INTO apps (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
	);
	const insertTool = sqlite.prepare(
		"INSERT INTO app_tools (id, app_id, tool_id, enabled, sort_order, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	// Three apps. `beta` deliberately has its tools inserted in an order that
	// does NOT match sort_order, so a batched query that forgets to sort would
	// return them the wrong way round.
	for (const slug of ["alpha", "beta", "gamma"]) {
		insertApp.run(`app-${slug}`, slug, slug, "2026-07-31", "2026-07-31");
	}
	insertTool.run(
		"t-beta-2",
		"app-beta",
		"second",
		1,
		2,
		JSON.stringify({ endpoint: "catalog/list" }),
		"2026-07-31",
		"2026-07-31",
	);
	for (let index = 0; index < extraToolCount; index += 1) {
		insertTool.run(
			`t-beta-extra-${index}`,
			"app-beta",
			`extra_${index}`,
			1,
			index + 10,
			JSON.stringify({ endpoint: `extra/list${index}` }),
			"2026-07-31",
			"2026-07-31",
		);
	}
	insertTool.run(
		"t-beta-1",
		"app-beta",
		"first",
		1,
		1,
		JSON.stringify({ endpoint: "skills/list" }),
		"2026-07-31",
		"2026-07-31",
	);
	insertTool.run(
		"t-beta-off",
		"app-beta",
		"disabled",
		0,
		0,
		JSON.stringify({ endpoint: "skills/list" }),
		"2026-07-31",
		"2026-07-31",
	);
	insertTool.run(
		"t-alpha-1",
		"app-alpha",
		"only",
		1,
		1,
		JSON.stringify({ endpoint: "skills/list" }),
		"2026-07-31",
		"2026-07-31",
	);
	// `gamma` exists but has no tools at all.

	const statements: string[] = [];
	const facade = createD1Facade(sqlite);
	const counted = new Proxy(facade as object, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (prop === "prepare" && typeof value === "function") {
				return (sql: string) => {
					statements.push(sql);
					return (value as (s: string) => unknown).call(target, sql);
				};
			}
			return value;
		},
	});
	return {
		client: createDbClient(counted as never),
		sqlite,
		statements: () => statements,
	};
}

describe("getAppsBySlugsWithTools", () => {
	it("answers every requested slug in request order, distinguishing empty from missing", async () => {
		const { client } = db();
		const results = await getAppsBySlugsWithTools(client, [
			{ slug: "alpha" },
			{ slug: "nope" },
			{ slug: "gamma" },
		]);

		expect(results).toHaveLength(3);
		// Asked for and found, with one tool.
		expect(results[0]?.app.slug).toBe("alpha");
		expect(results[0]?.tools).toHaveLength(1);
		// Asked for and does not exist — null, never a silent gap.
		expect(results[1]).toBeNull();
		// Exists but has NO tools: an empty array, clearly not the same as null.
		expect(results[2]?.app.slug).toBe("gamma");
		expect(results[2]?.tools).toEqual([]);
	});

	it("reads many apps without one statement per app", async () => {
		const { client, statements } = db();
		await getAppsBySlugsWithTools(client, [
			{ slug: "alpha" },
			{ slug: "beta" },
			{ slug: "gamma" },
		]);
		// The whole point: a fixed handful of statements regardless of app count.
		// One apps read + one app_tools read + one csp read (no catalog ids here).
		const selects = statements().filter((sql) =>
			sql.toLowerCase().startsWith("select"),
		);
		// Guard against a vacuous pass: the proxy must actually be observing SQL.
		expect(selects.length).toBeGreaterThan(0);
		expect(selects.length).toBeLessThanOrEqual(3);
		// And every app must be covered by a single `in (...)` read, not by N reads.
		expect(selects.filter((sql) => sql.includes("app_tools"))).toHaveLength(1);
	});

	it("preserves per-app tool ordering (sort_order, created_at)", async () => {
		const { client } = db();
		const [beta] = await getAppsBySlugsWithTools(client, [{ slug: "beta" }]);
		// Inserted 2-then-1; sort_order must win, and disabled tools are excluded.
		expect(beta?.tools.map((tool) => tool.toolId)).toEqual(["first", "second"]);
	});

	it("applies each entry's tool selection independently", async () => {
		const { client } = db();
		const results = await getAppsBySlugsWithTools(client, [
			{ slug: "beta", toolIds: ["second"] },
			{ slug: "beta" },
			{ slug: "beta", endpointPrefixes: ["skills"] },
		]);
		// Same slug three times, three different selections — no cross-talk.
		expect(results[0]?.tools.map((t) => t.toolId)).toEqual(["second"]);
		expect(results[1]?.tools.map((t) => t.toolId)).toEqual(["first", "second"]);
		expect(results[2]?.tools.map((t) => t.toolId)).toEqual(["first"]);
	});

	it("never exceeds D1's bound-parameter cap, even at the contract maximum", async () => {
		const { client, statements } = db();
		const slugs = Array.from({ length: 50 }, (_, i) => ({
			slug: `missing-${i}`,
			toolIds: ["a", "b", "c"],
		}));
		await getAppsBySlugsWithTools(client, slugs);
		expect(statements().length).toBeGreaterThan(0);
		for (const sql of statements()) {
			expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
		}
	});

	it("chunks oversized tool selections in both single-app and batched reads", async () => {
		const toolIds = Array.from({ length: 105 }, (_, index) => `extra_${index}`);
		const { client, statements } = db(toolIds.length);

		const single = await getAppBySlugWithTools(client, "beta", { toolIds });
		const [batched] = await getAppsBySlugsWithTools(client, [
			{ slug: "beta", toolIds },
		]);

		expect(single?.tools.map((tool) => tool.toolId)).toEqual(toolIds);
		expect(batched?.tools.map((tool) => tool.toolId)).toEqual(toolIds);
		for (const sql of statements()) {
			expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
		}
	});

	it("returns [] for an empty request without touching the database", async () => {
		const { client, statements } = db();
		expect(await getAppsBySlugsWithTools(client, [])).toEqual([]);
		expect(statements()).toEqual([]);
	});
});

/**
 * Aggregate entries that carry a stable `appId` resolve by id, so renaming an
 * app's slug cannot break the link — but an id must never reach an app the
 * aggregate ownership rule refuses: the host's own organization or the Tedix
 * platform organization only (unless the host is the platform organization).
 */
describe("getAppsBySlugsWithTools with id-linked entries", () => {
	const PROXY_ID = "3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
	const BASE_ID = "7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d";
	const FOREIGN_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

	function ownershipDb() {
		const fixture = db();
		const insertOrg = fixture.sqlite.prepare(
			"INSERT INTO organizations (id, name, slug, descope_tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		);
		insertOrg.run("org-acme", "Acme", "acme", null, "2026-07-31", "2026-07-31");
		insertOrg.run(
			"org-sample",
			"Sample",
			"sample",
			null,
			"2026-07-31",
			"2026-07-31",
		);
		insertOrg.run(
			"org-platform",
			"Platform",
			"tedix",
			null,
			"2026-07-31",
			"2026-07-31",
		);
		const insertApp = fixture.sqlite.prepare(
			"INSERT INTO apps (id, organization_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		);
		// The acme proxy, already renamed away from the slug its links stored.
		insertApp.run(
			PROXY_ID,
			"org-acme",
			"crm-acme-renamed",
			"CRM",
			"2026-07-31",
			"2026-07-31",
		);
		insertApp.run(
			BASE_ID,
			"org-platform",
			"crm",
			"CRM",
			"2026-07-31",
			"2026-07-31",
		);
		insertApp.run(
			FOREIGN_ID,
			"org-sample",
			"sample-private",
			"Private",
			"2026-07-31",
			"2026-07-31",
		);
		const insertTool = fixture.sqlite.prepare(
			"INSERT INTO app_tools (id, app_id, tool_id, enabled, sort_order, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		);
		insertTool.run(
			"t-base-1",
			BASE_ID,
			"list_contacts",
			1,
			1,
			"{}",
			"2026-07-31",
			"2026-07-31",
		);
		insertTool.run(
			"t-foreign-1",
			FOREIGN_ID,
			"private_list",
			1,
			1,
			"{}",
			"2026-07-31",
			"2026-07-31",
		);
		return fixture;
	}

	it("resolves by id after the target's slug changed", async () => {
		const { client } = ownershipDb();
		const [proxy, base] = await getAppsBySlugsWithTools(client, [
			// Stored slug is stale; the id still names the app.
			{ slug: "crm-acme", appId: PROXY_ID, hostOrganizationId: "org-acme" },
			{ slug: "crm-old", appId: BASE_ID, hostOrganizationId: "org-acme" },
		]);
		expect(proxy?.app.id).toBe(PROXY_ID);
		expect(proxy?.app.slug).toBe("crm-acme-renamed");
		// A platform base app is shared with every organization.
		expect(base?.app.id).toBe(BASE_ID);
		expect(base?.tools.map((tool) => tool.toolId)).toEqual(["list_contacts"]);
	});

	it("still resolves entries without an id by slug", async () => {
		const { client } = ownershipDb();
		const [legacy, linked] = await getAppsBySlugsWithTools(client, [
			{ slug: "crm" },
			{ slug: "crm-acme", appId: PROXY_ID, hostOrganizationId: "org-acme" },
		]);
		expect(legacy?.app.id).toBe(BASE_ID);
		expect(linked?.app.id).toBe(PROXY_ID);
	});

	it("refuses an id naming another organization's app, without falling back to the slug", async () => {
		const { client } = ownershipDb();
		const results = await getAppsBySlugsWithTools(client, [
			// The stored slug names a resolvable app; the id must still be refused.
			{ slug: "crm", appId: FOREIGN_ID, hostOrganizationId: "org-acme" },
			// No host organization: nothing to check ownership against.
			{ slug: "crm", appId: BASE_ID },
			// The owning organization itself may link its own app.
			{ slug: "x", appId: FOREIGN_ID, hostOrganizationId: "org-sample" },
		]);
		expect(results[0]).toBeNull();
		expect(results[1]).toBeNull();
		expect(results[2]?.app.id).toBe(FOREIGN_ID);
	});

	it("lets a platform-organization host link any organization's app by id", async () => {
		const { client } = ownershipDb();
		const [foreign] = await getAppsBySlugsWithTools(client, [
			{ slug: "x", appId: FOREIGN_ID, hostOrganizationId: "org-platform" },
		]);
		expect(foreign?.app.id).toBe(FOREIGN_ID);
	});

	it("keeps id reads within D1's bound-parameter cap", async () => {
		const { client, statements } = ownershipDb();
		const requests = Array.from({ length: 50 }, (_, index) => ({
			slug: `missing-${index}`,
			appId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			hostOrganizationId: `org-host-${index}`,
		}));
		await getAppsBySlugsWithTools(client, [
			...requests,
			{ slug: "x", appId: FOREIGN_ID, hostOrganizationId: "org-acme" },
		]);
		for (const sql of statements()) {
			expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
		}
	});
});
