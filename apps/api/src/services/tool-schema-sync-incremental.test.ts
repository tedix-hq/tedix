/**
 * Incremental projection planning against a real SQLite-backed D1 facade.
 *
 * The post-deploy sync plans only endpoints whose stored contract hash differs
 * from the deployed contract. These tests pin the round trip the deploy relies
 * on: a projection stores the hash, the next plan skips the endpoint, and any
 * code-derived change or non-projection write brings it back.
 */

import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { upsertTool } from "@tedix/db/queries/tools";
import { apps, appTools } from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import {
	planIncrementalToolSchemaSyncProjection,
	runToolSchemaSync,
} from "./tool-schema-sync";

const APP_ID = "5eed0020-0000-4000-8000-000000000020";
const ROUTER = "toolSchemaSync";

async function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(apps, appTools));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(apps).values({
		id: APP_ID,
		organizationId: "org-fixture",
		name: "Tedix",
		slug: "tedix",
	} as never);
	return { sqlite, db };
}

type Db = Awaited<ReturnType<typeof setup>>["db"];

function plan(db: Db, options: Record<string, unknown> = {}) {
	return planIncrementalToolSchemaSyncProjection(
		db,
		{ mode: "projection", router: ROUTER, ...options },
		APP_ID,
	);
}

/** One workflow batch, exactly as ToolSchemaSyncWorkflow hands it over. */
async function runBatch(
	db: Db,
	frozen: Awaited<ReturnType<typeof plan>>,
	options: Record<string, unknown> = {},
) {
	return runToolSchemaSync(db, {
		mode: "projection",
		source: "rpc",
		target: "both",
		apply: true,
		router: ROUTER,
		...options,
		appId: APP_ID,
		endpoints: frozen.endpoints,
		toolIdOverrides: frozen.toolIds,
	});
}

describe("incremental tool schema projection", () => {
	it("plans every endpoint once, then nothing after the projection stored its hashes", async () => {
		const { db, sqlite } = await setup();

		const first = await plan(db);
		expect(first.endpoints.length).toBeGreaterThan(0);
		expect(first.unchanged).toBe(0);
		expect(Object.keys(first.toolIds)).toEqual(first.endpoints);

		const result = await runBatch(db, first);
		expect(result.created).toBe(first.endpoints.length);
		expect(result.failed).toBe(0);

		const hashes = sqlite
			.prepare("SELECT contract_hash FROM app_tools")
			.all() as Array<{ contract_hash: string | null }>;
		expect(
			hashes.every((row) => /^[0-9a-f]{64}$/.test(row.contract_hash ?? "")),
		).toBe(true);

		const second = await plan(db);
		expect(second.endpoints).toEqual([]);
		expect(second.toolIds).toEqual({});
		expect(second.unchanged).toBe(first.endpoints.length);
	});

	it("backfills hashes on in-sync rows without moving updated_at, then plans nothing", async () => {
		const { db, sqlite } = await setup();
		await runBatch(db, await plan(db));
		sqlite.exec(
			"UPDATE app_tools SET contract_hash = NULL, updated_at = '2026-01-01T00:00:00.000Z'",
		);

		const backfill = await plan(db);
		expect(backfill.unchanged).toBe(0);
		const result = await runBatch(db, backfill);
		expect(result.inSync).toBe(backfill.endpoints.length);
		expect(result.created + result.updated).toBe(0);

		const rows = sqlite
			.prepare("SELECT updated_at, contract_hash FROM app_tools")
			.all() as Array<{ updated_at: string; contract_hash: string | null }>;
		expect(
			rows.every((row) => row.updated_at === "2026-01-01T00:00:00.000Z"),
		).toBe(true);
		expect(rows.every((row) => row.contract_hash !== null)).toBe(true);
		expect((await plan(db)).endpoints).toEqual([]);
	});

	it("re-plans a row that a non-projection write changed", async () => {
		const { db } = await setup();
		const first = await plan(db);
		await runBatch(db, first);
		const target = first.endpoints[0] as string;
		const row = await db.query.appTools.findFirst({
			where: { toolId: first.toolIds[target] as string },
		});
		if (!row) throw new Error("projected row missing");
		const { id, createdAt, updatedAt, contractHash, ...rest } = row;
		expect(contractHash).not.toBeNull();
		await upsertTool(db, { ...rest, id, description: "hand edited" } as never);

		const replanned = await plan(db);
		expect(replanned.endpoints).toEqual([target]);
		const repaired = await runBatch(db, replanned);
		expect(repaired.updated).toBe(1);
		expect((await plan(db)).endpoints).toEqual([]);
	});

	it("re-plans an endpoint whose code-derived projection changed", async () => {
		const { db } = await setup();
		const first = await plan(db);
		await runBatch(db, first);
		const target = first.endpoints[0] as string;
		const kindOverrides = { [target]: "destructive" as const };

		const changed = await plan(db, { kindOverrides });
		expect(changed.endpoints).toEqual([target]);
		expect(changed.toolIds).toEqual({ [target]: first.toolIds[target] });
		const result = await runBatch(db, changed, { kindOverrides });
		expect(result.updated).toBe(1);
		expect((await plan(db, { kindOverrides })).endpoints).toEqual([]);
	});
});
