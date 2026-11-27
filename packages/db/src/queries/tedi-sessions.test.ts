import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	getTediSessionState,
	upsertTediSessionState,
	listTediSessionStates,
	listTediConversationActivity,
	bulkSoftDeleteTediSessionStates,
} from "./tedi-sessions";

for (const store of ["d1", "postgres"] as const) {
	describe(`conversation state (${store})`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		const scope = { organizationId: "org", tediId: "tedi", userId: "person" };
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
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
				{ id: "org", name: "Example", slug: "example" },
				{ id: "other", name: "Other", slug: "other" },
			]);
			await db.insert(coreTable(db, tedis)).values([
				{ id: "tedi", organizationId: "org", name: "Example", slug: "example" },
				{ id: "other", organizationId: "other", name: "Other", slug: "other" },
			]);
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("preserves explicit titles, pinned ordering and scoped activity", async () => {
			await upsertTediSessionState(db, {
				...scope,
				sessionKey: "pinned",
				title: "My title",
				pinned: true,
				lastSeenAt: 123,
			});
			await upsertTediSessionState(db, {
				...scope,
				sessionKey: "pinned",
				derivedTitle: "Replacement",
			});
			await upsertTediSessionState(db, {
				...scope,
				sessionKey: "plain",
				title: "Chat",
			});
			await upsertTediSessionState(db, {
				...scope,
				sessionKey: "plain",
				derivedTitle: "Planning",
			});
			expect(
				(await listTediSessionStates(db, scope)).map((row) => row.sessionKey),
			).toEqual(["pinned", "plain"]);
			expect(
				await getTediSessionState(db, { ...scope, sessionKey: "pinned" }),
			).toMatchObject({ title: "My title", lastSeenAt: 123 });
			expect(
				await getTediSessionState(db, { ...scope, sessionKey: "plain" }),
			).toMatchObject({ title: "Planning" });
			await db.insert(coreTable(db, tediRuntimeEvents)).values([
				{
					id: "one",
					organizationId: "org",
					tediId: "tedi",
					conversationId: "chat",
					kind: "message.completed",
					runtimeBackend: "cloudflare-agents",
					createdAt: "2026-01-01",
				},
				{
					id: "two",
					organizationId: "org",
					tediId: "tedi",
					conversationId: "chat",
					kind: "message.completed",
					runtimeBackend: "cloudflare-agents",
					createdAt: "2026-01-02",
				},
				{
					id: "foreign",
					organizationId: "other",
					tediId: "other",
					conversationId: "foreign",
					kind: "message.completed",
					runtimeBackend: "cloudflare-agents",
					createdAt: "2026-01-03",
				},
			]);
			expect(await listTediConversationActivity(db, scope)).toEqual([
				{ id: "chat", lastActivityIso: "2026-01-02" },
			]);
		});

		it("deletes a large key set once, keeps other users and creates tombstones", async () => {
			await upsertTediSessionState(db, {
				...scope,
				userId: "other-person",
				sessionKey: "pinned",
				pinned: true,
			});
			const keys = [
				"pinned",
				"pinned",
				...Array.from({ length: 150 }, (_, i) => `new-${i}`),
			];
			const insert = vi.spyOn(db, "insert");
			try {
				expect(
					await bulkSoftDeleteTediSessionStates(db, {
						...scope,
						sessionKeys: keys,
					}),
				).toBe(keys.length);
				expect(insert).toHaveBeenCalledTimes(1);
			} finally {
				insert.mockRestore();
			}
			expect(
				await getTediSessionState(db, { ...scope, sessionKey: "pinned" }),
			).toMatchObject({
				title: "My title",
				pinnedAt: null,
				deletedAt: expect.any(String),
			});
			expect(
				await getTediSessionState(db, { ...scope, sessionKey: "new-149" }),
			).toMatchObject({ deletedAt: expect.any(String) });
			expect(
				await getTediSessionState(db, {
					...scope,
					userId: "other-person",
					sessionKey: "pinned",
				}),
			).toMatchObject({ deletedAt: null, pinnedAt: expect.any(String) });
			expect(
				await getTediSessionState(db, {
					...scope,
					organizationId: "other",
					sessionKey: "pinned",
				}),
			).toBeNull();
			expect(
				await bulkSoftDeleteTediSessionStates(db, {
					...scope,
					sessionKeys: [],
				}),
			).toBe(0);
		});
	});
}
