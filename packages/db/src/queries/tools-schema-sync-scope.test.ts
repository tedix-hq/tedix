import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	listToolContractHashesForSchemaSync,
	listToolIdsForSchemaSync,
	listToolsForScopePreview,
	listToolsForSchemaSync,
	listToolsForSchemaSyncScoped,
	recordToolContractHashes,
	refreshToolSchemaProvenance,
	upsertTool,
} from "./tools";

const APP_ID = "5eed0020-0000-4000-8000-000000000020";
const OTHER_APP_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-18T00:00:00.000Z";

async function setup(
	rows: Array<{
		id: string;
		toolId: string;
		endpoint?: string | null;
		appId?: string;
	}>,
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(appTools));
	const db = createDbClient(createD1Facade(sqlite));
	for (const row of rows) {
		await db.insert(appTools).values({
			id: row.id,
			appId: row.appId ?? APP_ID,
			toolId: row.toolId,
			title: row.toolId,
			toolTypeId: "rpc",
			config:
				row.endpoint === null
					? {}
					: {
							transport: "rpc",
							endpoint: row.endpoint ?? `router/${row.toolId}`,
						},
			createdAt: NOW,
			updatedAt: NOW,
		} as never);
	}
	return { db };
}

describe("listToolsForSchemaSyncScoped", () => {
	it("matches the same rows the unscoped read matches, by endpoint and by tool id", async () => {
		const { db } = await setup([
			{ id: "a", toolId: "list_alpha", endpoint: "alpha/list" },
			{ id: "b", toolId: "list_bravo", endpoint: "bravo/list" },
			{ id: "c", toolId: "renamed_charlie", endpoint: "charlie/list" },
			{ id: "d", toolId: "list_delta", endpoint: "delta/list" },
		]);

		// A batch scopes by its endpoint paths plus its resolved tool ids. `c` is
		// only reachable by endpoint (its stored name drifted from the generated
		// one) and `d` only by tool id — the sync looks rows up by exactly these
		// two keys, so both have to come back.
		const scoped = await listToolsForSchemaSyncScoped(db, APP_ID, {
			endpoints: ["alpha/list", "charlie/list"],
			toolIds: ["list_alpha", "list_delta"],
		});

		expect(scoped.map((row) => row.id)).toEqual(["a", "d", "c"]);
	});

	it("never returns rows outside the requested scope or the requested app", async () => {
		const { db } = await setup([
			{ id: "a", toolId: "list_alpha", endpoint: "alpha/list" },
			{ id: "b", toolId: "list_bravo", endpoint: "bravo/list" },
			{
				id: "x",
				toolId: "list_alpha",
				endpoint: "alpha/list",
				appId: OTHER_APP_ID,
			},
		]);

		const scoped = await listToolsForSchemaSyncScoped(db, APP_ID, {
			endpoints: ["alpha/list"],
			toolIds: ["list_alpha"],
		});

		expect(scoped.map((row) => row.id)).toEqual(["a"]);
	});

	it("returns nothing for an empty scope instead of the whole app", async () => {
		const { db } = await setup([
			{ id: "a", toolId: "list_alpha", endpoint: "alpha/list" },
		]);
		expect(
			await listToolsForSchemaSyncScoped(db, APP_ID, {
				endpoints: [],
				toolIds: [],
			}),
		).toEqual([]);
		expect(await listToolsForSchemaSyncScoped(db, APP_ID, {})).toEqual([]);
	});

	it("chunks past the D1 bound-parameter cap without dropping or duplicating rows", async () => {
		const rows = Array.from({ length: 137 }, (_, index) => ({
			id: `id-${String(index).padStart(3, "0")}`,
			toolId: `tool_${String(index).padStart(3, "0")}`,
			endpoint: `router/proc${String(index).padStart(3, "0")}`,
		}));
		const { db } = await setup(rows);

		const scoped = await listToolsForSchemaSyncScoped(db, APP_ID, {
			// Overlapping key sets: every row is reachable by both keys, so a
			// missing dedupe would double every row.
			endpoints: rows.map((row) => row.endpoint),
			toolIds: rows.map((row) => row.toolId),
		});

		expect(scoped).toHaveLength(rows.length);
		expect(new Set(scoped.map((row) => row.id)).size).toBe(rows.length);
		const unscoped = await listToolsForSchemaSync(db, APP_ID);
		expect(scoped.map((row) => row.toolId)).toEqual(
			unscoped.map((row) => row.toolId),
		);
	});
});

describe("listToolIdsForSchemaSync", () => {
	it("enumerates the app's tool ids in the stable sync order", async () => {
		const { db } = await setup([
			{ id: "b", toolId: "list_bravo" },
			{ id: "a", toolId: "list_alpha" },
			{ id: "x", toolId: "list_zulu", appId: OTHER_APP_ID },
		]);
		expect(await listToolIdsForSchemaSync(db, APP_ID)).toEqual([
			"list_alpha",
			"list_bravo",
		]);
	});
});

describe("listToolsForScopePreview", () => {
	it("returns only the bounded authorization projection", async () => {
		const { db } = await setup([{ id: "scope-tool", toolId: "list_alpha" }]);

		const [tool] = await listToolsForScopePreview(db, APP_ID);

		expect(tool).toEqual({
			id: "scope-tool",
			appId: APP_ID,
			toolId: "list_alpha",
			toolTypeId: "rpc",
			annotations: null,
			writeCapability: null,
			authRequired: false,
			visibility: "public",
			config: {
				transport: "rpc",
				endpoint: "router/list_alpha",
			},
			enabled: true,
		});
		expect(tool).not.toHaveProperty("inputSchema");
		expect(tool).not.toHaveProperty("outputSchema");
		expect(tool).not.toHaveProperty("meta");
	});
});

describe("refreshToolSchemaProvenance", () => {
	it("touches synced_at in chunks and re-certifies drifted rows without moving updated_at", async () => {
		// 120 touched ids exceed D1's 100 bound-parameter ceiling, which the
		// facade enforces per statement: the chunking is what keeps this passing.
		const touched = Array.from({ length: 120 }, (_, index) => ({
			id: `touch-${index}`,
			toolId: `touch_${String(index).padStart(3, "0")}`,
		}));
		const { db } = await setup([
			...touched,
			{ id: "drift", toolId: "drifted" },
			{ id: "untouched", toolId: "untouched" },
		]);
		const later = "2026-08-19T00:00:00.000Z";

		await refreshToolSchemaProvenance(db, {
			touchIds: touched.map((row) => row.id),
			certify: [
				{
					id: "drift",
					schemaSourceRef: "router/drifted",
					schemaSourceHash: "a".repeat(64),
				},
			],
			now: later,
		});

		const rows = await listToolsForSchemaSync(db, APP_ID);
		const byId = new Map(rows.map((row) => [row.id, row]));
		for (const row of touched) {
			expect(byId.get(row.id)).toMatchObject({
				schemaSyncedAt: later,
				updatedAt: NOW,
				schemaSourceHash: null,
			});
		}
		expect(byId.get("drift")).toMatchObject({
			schemaDialect: "json-schema-2020-12",
			schemaSource: "orpc",
			schemaSourceRef: "router/drifted",
			schemaSourceHash: "a".repeat(64),
			schemaSyncedAt: later,
			updatedAt: NOW,
		});
		expect(byId.get("untouched")).toMatchObject({
			schemaSyncedAt: null,
			updatedAt: NOW,
		});
	});

	it("is a no-op with nothing to refresh", async () => {
		const { db } = await setup([{ id: "a", toolId: "list_alpha" }]);
		await refreshToolSchemaProvenance(db, {
			touchIds: [],
			certify: [],
			now: "2026-08-19T00:00:00.000Z",
		});
		expect((await listToolsForSchemaSync(db, APP_ID))[0]).toMatchObject({
			schemaSyncedAt: null,
		});
	});
});

describe("tool contract hashes", () => {
	it("lists lookup keys and hashes, records hashes without moving updated_at", async () => {
		const { db } = await setup([
			{ id: "a", toolId: "list_alpha", endpoint: "alpha/list" },
			{ id: "b", toolId: "custom_tool", endpoint: null },
			{
				id: "x",
				toolId: "list_alpha",
				endpoint: "alpha/list",
				appId: OTHER_APP_ID,
			},
		]);
		await recordToolContractHashes(db, [
			{ id: "a", contractHash: "c".repeat(64) },
		]);

		expect(await listToolContractHashesForSchemaSync(db, APP_ID)).toEqual([
			{
				toolId: "custom_tool",
				transport: null,
				endpoint: null,
				contractHash: null,
			},
			{
				toolId: "list_alpha",
				transport: "rpc",
				endpoint: "alpha/list",
				contractHash: "c".repeat(64),
			},
		]);
		const [alpha] = (await listToolsForSchemaSync(db, APP_ID)).filter(
			(row) => row.id === "a",
		);
		expect(alpha).toMatchObject({ updatedAt: NOW });
	});

	it("clears the hash on any upsert that does not supply one", async () => {
		const { db } = await setup([
			{ id: "a", toolId: "list_alpha", endpoint: "alpha/list" },
		]);
		await recordToolContractHashes(db, [
			{ id: "a", contractHash: "c".repeat(64) },
		]);
		const [row] = await listToolsForSchemaSync(db, APP_ID);
		if (!row) throw new Error("row missing");
		const {
			createdAt: _createdAt,
			updatedAt: _updatedAt,
			contractHash: _hash,
			...rest
		} = row;
		await upsertTool(db, { ...rest, description: "edited" } as never);

		const [edited] = await listToolContractHashesForSchemaSync(db, APP_ID);
		expect(edited?.contractHash).toBeNull();
	});
});
