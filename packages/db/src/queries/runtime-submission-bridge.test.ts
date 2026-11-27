import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { createPGliteFacade } from "../test/pglite-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { getTediSubmissionInputEvent } from "./runtime-submission-bridge";

describe.each(["d1", "postgres"] as const)("submission input (%s)", (store) => {
	let db: DbClient;
	let close: () => void | Promise<void>;
	beforeAll(async () => {
		if (store === "d1") {
			const sqlite = createMigratedSqlite();
			db = createDbClient(createD1Facade(sqlite));
			close = () => sqlite.close();
		} else {
			const fixture = await createPGliteFacade();
			db = fixture.db;
			close = fixture.close;
			for (const migration of readMigrationFiles({
				migrationsFolder: fileURLToPath(
					new URL("../../drizzle-pg", import.meta.url),
				),
			}))
				for (const ddl of migration.sql) await fixture.engine.exec(ddl);
		}
		await db.insert(coreTable(db, organizations)).values([
			{ id: "org-a", name: "A", slug: "a" },
			{ id: "org-b", name: "B", slug: "b" },
		]);
		await db.insert(coreTable(db, tedis)).values([
			{ id: "tedi-a", organizationId: "org-a", name: "A", slug: "a" },
			{ id: "tedi-b", organizationId: "org-a", name: "B", slug: "b" },
		]);
	}, 30_000);
	afterAll(async () => {
		await close?.();
	});

	it("recovers the earliest received input with decoded JSON only within its organization, tedi and run", async () => {
		const input = { organizationId: "org-a", tediId: "tedi-a", runId: "run-a" };
		const base = {
			...input,
			kind: "message.received" as const,
			runtimeBackend: "codex" as const,
			conversationId: "conversation-a",
			payload: { content: "original", nested: { enabled: true } },
			createdAt: "2026-08-01T00:00:00.000Z",
		};
		await db.insert(coreTable(db, tediRuntimeEvents)).values([
			{ ...base, id: "other-org", organizationId: "org-b" },
			{ ...base, id: "other-tedi", tediId: "tedi-b" },
			{ ...base, id: "other-run", runId: "run-b" },
			{ ...base, id: "other-kind", kind: "message.completed" },
			{
				...base,
				id: "later",
				createdAt: "2026-08-03T00:00:00.000Z",
				payload: { content: "later" },
			},
			{ ...base, id: "first", createdAt: "2026-08-02T00:00:00.000Z" },
		]);
		expect(await getTediSubmissionInputEvent(db, input)).toEqual({
			conversationId: base.conversationId,
			payload: base.payload,
		});
		expect(
			await getTediSubmissionInputEvent(db, { ...input, runId: "missing" }),
		).toBeUndefined();
	});
});
