import { afterEach, describe, expect, it } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { coreTable } from "../core-store/client";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { createPGliteFacade } from "../test/pglite-facade";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	appendTediMemoryDocumentVersion,
	getCurrentTediMemoryDocument,
	listCurrentTediMemoryNotes,
	listTediMemoryDocumentVersions,
} from "./tedi-memory";

let close: (() => void | Promise<void>) | undefined;
afterEach(async () => {
	await close?.();
	close = undefined;
});
async function fixture(store: "d1" | "postgres") {
	let db: DbQueryClient;
	if (store === "d1") {
		const sqlite = createMigratedSqlite();
		db = createDbQueryClient(createD1Facade(sqlite));
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
		{ id: "other-org", name: "Other", slug: "other" },
	]);
	await db.insert(coreTable(db, tedis)).values([
		{ id: "tedi", organizationId: "org", name: "Example", slug: "example" },
		{
			id: "other-tedi",
			organizationId: "other-org",
			name: "Other",
			slug: "other",
		},
	]);
	let next = 0;
	const append = (
		over: Partial<Parameters<typeof appendTediMemoryDocumentVersion>[1]>,
	) =>
		appendTediMemoryDocumentVersion(db, {
			id: `row-${++next}`,
			organizationId: "org",
			tediId: "tedi",
			kind: "core",
			name: "core",
			baseVersion: 0,
			sections: { project: "one" },
			charCount: 3,
			authorType: "tedi",
			authorId: "tedi",
			changeSummary: "Replaced a section",
			createdAt: "2026-11-19T10:00:00.000Z",
			keepVersions: 3,
			...over,
		});
	return { db, append };
}

for (const store of ["d1", "postgres"] as const)
	describe(`tedi memory documents (${store})`, () => {
		it("stores one change per base version and keeps other tedis and organizations apart", async () => {
			const { db, append } = await fixture(store);
			expect(await append({})).toBe(true);
			// A second change made from the same base loses and stores nothing.
			expect(await append({ sections: { project: "late" } })).toBe(false);
			expect(await append({ tediId: "other-tedi" })).toBe(true);
			expect(await append({ organizationId: "other-org" })).toBe(true);

			const scope = {
				organizationId: "org",
				tediId: "tedi",
				kind: "core" as const,
				name: "core",
			};
			expect(await getCurrentTediMemoryDocument(db, scope)).toMatchObject({
				version: 1,
				sections: { project: "one" },
			});
			expect(
				await getCurrentTediMemoryDocument(db, { ...scope, tediId: "nobody" }),
			).toBeNull();
			expect(
				await listTediMemoryDocumentVersions(db, { ...scope, limit: 10 }),
			).toHaveLength(1);
		});

		it("drops versions older than the number it keeps", async () => {
			const { db, append } = await fixture(store);
			for (let base = 0; base < 5; base++)
				expect(await append({ baseVersion: base })).toBe(true);
			const versions = await listTediMemoryDocumentVersions(db, {
				organizationId: "org",
				tediId: "tedi",
				kind: "core",
				name: "core",
				limit: 10,
			});
			expect(versions.map((row) => row.version)).toEqual([5, 4, 3]);
		});

		it("lists each note once at its newest version and leaves removed notes out", async () => {
			const { db, append } = await fixture(store);
			const note = { kind: "note" as const, sections: null };
			await append({
				...note,
				name: "deploys",
				description: "old",
				content: "a",
			});
			await append({
				...note,
				name: "deploys",
				baseVersion: 1,
				description: "How deploys go",
				content: "ab",
				charCount: 2,
			});
			await append({ ...note, name: "gone", description: "x", content: "x" });
			await append({ ...note, name: "gone", baseVersion: 1, removed: true });
			await append({ ...note, name: "theirs", tediId: "other-tedi" });

			expect(
				await listCurrentTediMemoryNotes(db, {
					organizationId: "org",
					tediId: "tedi",
				}),
			).toEqual([
				{
					name: "deploys",
					description: "How deploys go",
					version: 2,
					charCount: 2,
					updatedAt: "2026-11-19T10:00:00.000Z",
				},
			]);
		});
	});
