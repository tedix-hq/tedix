import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade, type D1FacadeOptions } from "../../test/d1-facade";
import { createPGliteFacade } from "../../test/pglite-facade";
import { pgTableDdl } from "../../test/pg-schema-ddl";
import { osGadgetCode, osGadgetCodeBlobs } from "../../schema/os-workspaces";
import {
	osWorkspaces as pgOsWorkspaces,
	osGadgets as pgOsGadgets,
	osGadgetRevisions as pgOsGadgetRevisions,
	osGadgetCode as pgOsGadgetCode,
	osGadgetCodeBlobs as pgOsGadgetCodeBlobs,
} from "../../schema-pg/core";
import {
	createOsGadget,
	createOsGadgetRevision,
	getOsGadget,
	getOsGadgetCode,
	getOsGadgetCodeHash,
	getOsGadgetRevision,
	listOsGadgetRevisions,
	listOsGadgets,
} from "./gadgets";
import { osGadgetCodeSha256 } from "./gadget-code";

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});
async function fixture(
	store: "d1" | "postgres",
	options: D1FacadeOptions = {},
) {
	if (store === "postgres") {
		const fixture = await createPGliteFacade();
		closers.push(fixture.close);
		await fixture.engine.exec(
			"CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-1'),('org-2')",
		);
		for (const table of [
			pgOsWorkspaces,
			pgOsGadgets,
			pgOsGadgetRevisions,
			pgOsGadgetCodeBlobs,
			pgOsGadgetCode,
		])
			for (const ddl of pgTableDdl(table)) await fixture.engine.exec(ddl);
		await fixture.engine.exec(
			"INSERT INTO os_workspaces(id,organization_id,name,created_by_kind,created_by_id) VALUES ('ws-1','org-1','Operations','user','u-1')",
		);
		return { db: fixture.db };
	}
	const sqlite = new DatabaseSync(":memory:");
	closers.push(() => sqlite.close());
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		CREATE TABLE os_workspaces (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			description TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			created_by_kind TEXT NOT NULL,
			created_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE os_gadgets (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			workspace_id TEXT NOT NULL REFERENCES os_workspaces(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			description TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			current_revision_id TEXT,
			has_runtime_triggers INTEGER NOT NULL DEFAULT 0,
			has_work_navigation INTEGER NOT NULL DEFAULT 0,
			trigger_enabled TEXT NOT NULL DEFAULT '{}',
			source_blueprint_revision_id TEXT,
			created_by_kind TEXT NOT NULL,
			created_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE UNIQUE INDEX os_gadgets_workspace_name_unique
			ON os_gadgets (workspace_id, name);
		CREATE TABLE os_gadget_revisions (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			gadget_id TEXT NOT NULL REFERENCES os_gadgets(id) ON DELETE CASCADE,
			revision INTEGER NOT NULL,
			manifest TEXT NOT NULL,
			source_artifact_ref TEXT,
			created_by_kind TEXT NOT NULL,
			created_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE UNIQUE INDEX os_gadget_revisions_gadget_revision_unique
			ON os_gadget_revisions (gadget_id, revision);
		CREATE TABLE os_gadget_code (
			revision_id TEXT PRIMARY KEY NOT NULL REFERENCES os_gadget_revisions(id) ON DELETE CASCADE,
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			gadget_id TEXT NOT NULL REFERENCES os_gadgets(id) ON DELETE CASCADE,
			files TEXT NOT NULL,
			code_length INTEGER NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			files_sha256 TEXT
		);
		CREATE TABLE os_gadget_code_blobs (
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			sha256 TEXT NOT NULL,
			files TEXT NOT NULL,
			code_length INTEGER NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (organization_id, sha256)
		);
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
		INSERT INTO os_workspaces (id, organization_id, name, created_by_kind, created_by_id)
			VALUES ('ws-1', 'org-1', 'Operations', 'user', 'u-1');
	`);
	return {
		db: createDbQueryClient(
			createD1Facade(sqlite, { maxBoundParams: 100, ...options }),
		),
	};
}

const gadget = {
	id: "gd-1",
	organizationId: "org-1",
	workspaceId: "ws-1",
	name: "Inbox Triage",
	createdByKind: "tedi" as const,
	createdById: "tedi-1",
};

function revisionParams(id: string, expectedRevision?: number) {
	return {
		id,
		organizationId: "org-1",
		gadgetId: "gd-1",
		manifest: '{"entry":"main.tsx","capabilities":[]}',
		createdByKind: "tedi" as const,
		createdById: "tedi-1",
		expectedRevision,
	};
}

for (const store of ["d1", "postgres"] as const) {
	describe(`os gadgets: ${store}`, () => {
		it("creates gadgets and lists them scoped by organization and workspace", async () => {
			const { db } = await fixture(store);
			await createOsGadget(db, gadget);
			expect(
				await listOsGadgets(db, "org-1", { workspaceId: "ws-1" }),
			).toHaveLength(1);
			expect(await listOsGadgets(db, "org-2")).toHaveLength(0);
			expect(
				await getOsGadget(db, { organizationId: "org-2", gadgetId: "gd-1" }),
			).toBeUndefined();
		});

		it("appends revisions with max+1 and advances the current pointer in one batch", async () => {
			const { db } = await fixture(store);
			await createOsGadget(db, gadget);
			const first = await createOsGadgetRevision(db, revisionParams("rev-1"));
			expect(first).toMatchObject({ ok: true });
			if (first.ok) expect(first.revision.revision).toBe(1);
			const second = await createOsGadgetRevision(db, revisionParams("rev-2"));
			if (second.ok) expect(second.revision.revision).toBe(2);
			expect(
				await getOsGadget(db, { organizationId: "org-1", gadgetId: "gd-1" }),
			).toMatchObject({ currentRevisionId: "rev-2" });
			const revisions = await listOsGadgetRevisions(db, {
				organizationId: "org-1",
				gadgetId: "gd-1",
			});
			expect(revisions.map((row) => row.revision)).toEqual([2, 1]);
			expect(
				await getOsGadgetRevision(db, {
					organizationId: "org-1",
					revisionId: "rev-1",
				}),
			).toMatchObject({ revision: 1 });
		});

		it("records runtime app code with its revision and drops it with a lost CAS", async () => {
			const { db } = await fixture(store);
			await createOsGadget(db, gadget);
			const files = JSON.stringify({
				"server.js": "export {}",
				"client.js": "",
			});
			const first = await createOsGadgetRevision(db, {
				...revisionParams("rev-1", 0),
				sourceBlueprintRevisionId: "template-1",
				code: { files, codeLength: 9 },
			});
			expect(first.ok).toBe(true);
			expect(
				await getOsGadgetCode(db, {
					organizationId: "org-1",
					revisionId: "rev-1",
				}),
			).toMatchObject({ gadgetId: "gd-1", files, codeLength: 9 });
			expect(
				await getOsGadgetCode(db, {
					organizationId: "org-2",
					revisionId: "rev-1",
				}),
			).toBeUndefined();
			// The hash is readable on its own, and only inside the organization.
			expect(
				await getOsGadgetCodeHash(db, {
					organizationId: "org-1",
					revisionId: "rev-1",
				}),
			).toMatchObject({
				filesSha256: await osGadgetCodeSha256(files),
				codeLength: 9,
			});
			expect(
				await getOsGadgetCodeHash(db, {
					organizationId: "org-2",
					revisionId: "rev-1",
				}),
			).toBeUndefined();
			const stale = await createOsGadgetRevision(db, {
				...revisionParams("rev-2", 0),
				sourceBlueprintRevisionId: "template-2",
				code: { files, codeLength: 9 },
			});
			expect(stale).toEqual({ ok: false, reason: "revision_conflict" });
			expect(
				await getOsGadget(db, { organizationId: "org-1", gadgetId: "gd-1" }),
			).toMatchObject({
				currentRevisionId: "rev-1",
				sourceBlueprintRevisionId: "template-1",
			});
			expect(
				await getOsGadgetCode(db, {
					organizationId: "org-1",
					revisionId: "rev-2",
				}),
			).toBeUndefined();
		});

		it("stores identical app files once however many revisions carry them", async () => {
			const { db } = await fixture(store);
			await createOsGadget(db, gadget);
			const files = JSON.stringify({
				"server.js": "export {}",
				"client.js": "",
			});
			for (const [index, id] of ["rev-1", "rev-2", "rev-3"].entries())
				expect(
					await createOsGadgetRevision(db, {
						...revisionParams(id, index),
						code: { files, codeLength: 9 },
					}),
				).toMatchObject({ ok: true });
			expect(
				await db.all(
					sql`SELECT revision_id, files, length(files_sha256) AS hash_length FROM os_gadget_code ORDER BY revision_id`,
				),
			).toEqual(
				["rev-1", "rev-2", "rev-3"].map((revision_id) => ({
					revision_id,
					files: "",
					hash_length: 64,
				})),
			);
			expect(
				await db
					.select({
						organization_id: coreTable(db, osGadgetCodeBlobs).organizationId,
						files: coreTable(db, osGadgetCodeBlobs).files,
						code_length: coreTable(db, osGadgetCodeBlobs).codeLength,
					})
					.from(coreTable(db, osGadgetCodeBlobs)),
			).toEqual([{ organization_id: "org-1", files, code_length: 9 }]);
			expect(
				await getOsGadgetCode(db, {
					organizationId: "org-1",
					revisionId: "rev-3",
				}),
			).toMatchObject({ gadgetId: "gd-1", files, codeLength: 9 });
			// Different files are a different blob.
			const changed = JSON.stringify({ "server.js": "export default 1" });
			await createOsGadgetRevision(db, {
				...revisionParams("rev-4", 3),
				code: { files: changed, codeLength: 16 },
			});
			expect(
				(
					await db
						.select({ n: sql<number>`count(*)`.mapWith(Number) })
						.from(coreTable(db, osGadgetCodeBlobs))
				)[0],
			).toEqual({ n: 2 });
			expect(
				(await getOsGadgetCode(db, {
					organizationId: "org-1",
					revisionId: "rev-4",
				}))!.files,
			).toBe(changed);
		});

		it("stores no blob when the guarded revision insert loses", async () => {
			const { db } = await fixture(store);
			await createOsGadget(db, gadget);
			await createOsGadgetRevision(db, revisionParams("rev-1"));
			const stale = await createOsGadgetRevision(db, {
				...revisionParams("rev-2", 0),
				code: { files: '{"server.js":"x"}', codeLength: 1 },
			});
			expect(stale).toEqual({ ok: false, reason: "revision_conflict" });
			expect(
				(
					await db
						.select({ n: sql<number>`count(*)`.mapWith(Number) })
						.from(coreTable(db, osGadgetCodeBlobs))
				)[0],
			).toEqual({ n: 0 });
		});

		it("refuses missing and dangling blob pointers", async () => {
			const { db } = await fixture(store);
			await createOsGadget(db, gadget);
			await createOsGadgetRevision(db, revisionParams("rev-1"));
			await createOsGadgetRevision(db, revisionParams("rev-2"));
			for (const [revisionId, files, filesSha256] of [
				["rev-1", '{"server.js":"old!"}', null],
				["rev-2", "", "0".repeat(64)],
			] as const)
				await db.insert(coreTable(db, osGadgetCode)).values({
					revisionId,
					organizationId: "org-1",
					gadgetId: "gd-1",
					files,
					codeLength: 4,
					filesSha256,
				});
			await expect(
				getOsGadgetCode(db, { organizationId: "org-1", revisionId: "rev-1" }),
			).rejects.toThrow("Gadget code files are missing");
			await expect(
				getOsGadgetCode(db, { organizationId: "org-1", revisionId: "rev-2" }),
			).rejects.toThrow("Gadget code files are missing");
		});

		it("returns a typed CAS failure on a stale expectedRevision without side effects", async () => {
			const { db } = await fixture(store);
			await createOsGadget(db, gadget);
			await createOsGadgetRevision(db, revisionParams("rev-1"));
			const stale = await createOsGadgetRevision(
				db,
				revisionParams("rev-2", 0),
			);
			expect(stale).toEqual({ ok: false, reason: "revision_conflict" });
			expect(
				await getOsGadget(db, { organizationId: "org-1", gadgetId: "gd-1" }),
			).toMatchObject({ currentRevisionId: "rev-1" });
			expect(
				await listOsGadgetRevisions(db, {
					organizationId: "org-1",
					gadgetId: "gd-1",
				}),
			).toHaveLength(1);
			const matched = await createOsGadgetRevision(
				db,
				revisionParams("rev-2", 1),
			);
			expect(matched).toMatchObject({ ok: true });
			expect(
				await createOsGadgetRevision(db, {
					...revisionParams("rev-1", 0),
					sourceBlueprintRevisionId: "stale-template",
					code: { files: '{"server.js":"stale"}', codeLength: 5 },
				}),
			).toEqual({ ok: false, reason: "revision_conflict" });
			expect(
				await getOsGadget(db, { organizationId: "org-1", gadgetId: "gd-1" }),
			).toMatchObject({
				currentRevisionId: "rev-2",
				sourceBlueprintRevisionId: null,
			});
			expect(
				await getOsGadgetCode(db, {
					organizationId: "org-1",
					revisionId: "rev-1",
				}),
			).toBeUndefined();
		});

		it("admits one of two competing revision CAS batches", async () => {
			const { db } = await fixture(store);
			await createOsGadget(db, gadget);
			const results = await Promise.all([
				createOsGadgetRevision(db, revisionParams("first", 0)),
				createOsGadgetRevision(db, revisionParams("second", 0)),
			]);
			expect(results.filter((result) => result.ok)).toHaveLength(1);
			expect(
				await listOsGadgetRevisions(db, {
					organizationId: "org-1",
					gadgetId: "gd-1",
				}),
			).toHaveLength(1);
		});

		it("rolls back revision and code writes if advancing the pointer fails", async () => {
			const { db } = await fixture(store);
			await createOsGadget(db, gadget);
			if (store === "postgres") {
				await db.run(
					sql`CREATE FUNCTION refuse_pointer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pointer refused'; END $$`,
				);
				await db.run(
					sql`CREATE TRIGGER refuse_pointer BEFORE UPDATE ON os_gadgets FOR EACH ROW EXECUTE FUNCTION refuse_pointer()`,
				);
			} else {
				await db.run(
					sql`CREATE TRIGGER refuse_pointer BEFORE UPDATE ON os_gadgets BEGIN SELECT RAISE(ABORT, 'pointer refused'); END`,
				);
			}
			await expect(
				createOsGadgetRevision(db, {
					...revisionParams("rollback", 0),
					code: { files: '{"server.js":"rollback"}', codeLength: 8 },
				}),
			).rejects.toThrow();
			expect(
				await listOsGadgetRevisions(db, {
					organizationId: "org-1",
					gadgetId: "gd-1",
				}),
			).toEqual([]);
			expect(await db.select().from(coreTable(db, osGadgetCodeBlobs))).toEqual(
				[],
			);
		});

		it.skipIf(store === "postgres")(
			"loses the CAS to a competing writer landing inside the write window",
			async () => {
				let injected = false;
				const { db } = await fixture(store, {
					onPrepare: (query, raw) => {
						if (!injected && /insert into "os_gadget_revisions"/i.test(query)) {
							injected = true;
							raw
								.prepare(
									`INSERT INTO os_gadget_revisions
								(id, organization_id, gadget_id, revision, manifest, created_by_kind, created_by_id)
								VALUES ('rev-race', 'org-1', 'gd-1', 1, '{}', 'user', 'u-2')`,
								)
								.run();
						}
					},
				});
				await createOsGadget(db, gadget);
				const result = await createOsGadgetRevision(
					db,
					revisionParams("rev-1", 0),
				);
				expect(result).toEqual({ ok: false, reason: "revision_conflict" });
			},
		);

		it("reports gadget_not_found for a foreign organization or missing gadget", async () => {
			const { db } = await fixture(store);
			await createOsGadget(db, gadget);
			expect(
				await createOsGadgetRevision(db, {
					...revisionParams("rev-x"),
					organizationId: "org-2",
				}),
			).toEqual({ ok: false, reason: "gadget_not_found" });
			expect(
				await createOsGadgetRevision(db, {
					...revisionParams("rev-y"),
					gadgetId: "gd-missing",
				}),
			).toEqual({ ok: false, reason: "gadget_not_found" });
		});
	});
}
