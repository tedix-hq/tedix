import { DatabaseSync } from "node:sqlite";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import { createDbQueryClient, type DbQueryClient } from "../../query-client";
import { osBlueprintRevisions, osBlueprints } from "../../schema/os-workspaces";
import {
	osBlueprints as pgOsBlueprints,
	osBlueprintRevisions as pgOsBlueprintRevisions,
} from "../../schema-pg/core";
import { createD1Facade } from "../../test/d1-facade";
import { createPGliteFacade } from "../../test/pglite-facade";
import { pgTableDdl } from "../../test/pg-schema-ddl";
import { schemaDdl } from "../../test/schema-ddl";
import {
	createOsBlueprint,
	createOsBlueprintRevision,
	CATALOG_PREVIEW_APP_LIMIT,
	deleteOsBlueprint,
	getCatalogOsBlueprint,
	getOsBlueprint,
	listCatalogOsBlueprints,
	listOsBlueprintRevisions,
	listOsBlueprints,
	publishOsBlueprintRevision,
	setCatalogOsBlueprintFeatured,
	setOsBlueprintVisibility,
	updateOsBlueprint,
	restoreOsBlueprint,
	importOsBlueprint,
} from "./blueprints";

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});
async function fixture(store: "d1" | "postgres") {
	if (store === "postgres") {
		const fixture = await createPGliteFacade();
		closers.push(fixture.close);
		await fixture.engine.exec(
			"CREATE TABLE organizations(id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO organizations VALUES ('org-1','First Org'),('org-2','Second Org')",
		);
		for (const table of [pgOsBlueprints, pgOsBlueprintRevisions])
			for (const ddl of pgTableDdl(table)) await fixture.engine.exec(ddl);
		return fixture.db;
	}
	const sqlite = new DatabaseSync(":memory:");
	closers.push(() => sqlite.close());
	// Blueprint tables come from the Drizzle schema itself, so a column added to
	// `os_blueprints` cannot drift away from what this fixture creates. Only the
	// `organizations` parent is stubbed: the gallery join reads its id and name,
	// and nothing else.
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT NOT NULL
		);
		INSERT INTO organizations (id, name)
			VALUES ('org-1', 'First Org'), ('org-2', 'Second Org');
	`);
	sqlite.exec(schemaDdl(osBlueprints, osBlueprintRevisions));
	return createDbQueryClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
}

const blueprint = {
	id: "bp-1",
	organizationId: "org-1",
	name: "Support Desk",
	createdByKind: "user" as const,
	createdById: "u-1",
};

function revisionParams(id: string, expectedRevision?: number) {
	return {
		id,
		organizationId: "org-1",
		blueprintId: "bp-1",
		definition: '{"gadgets":[],"layout":{},"skills":[]}',
		createdByKind: "user" as const,
		createdById: "u-1",
		expectedRevision,
	};
}

for (const store of ["d1", "postgres"] as const) {
	describe(`os blueprints: ${store}`, () => {
		it("creates draft blueprints scoped by organization", async () => {
			const db = await fixture(store);
			expect(await createOsBlueprint(db, blueprint)).toMatchObject({
				status: "draft",
			});
			expect(
				await listOsBlueprints(db, "org-1", { status: "draft" }),
			).toHaveLength(1);
			expect(await listOsBlueprints(db, "org-2")).toHaveLength(0);
		});

		it("permanently deletes the blueprint and revisions inside org scope", async () => {
			const db = await fixture(store);
			await createOsBlueprint(db, blueprint);
			await createOsBlueprintRevision(db, revisionParams("rev-1"));
			expect(
				await deleteOsBlueprint(db, {
					organizationId: "org-2",
					blueprintId: "bp-1",
				}),
			).toBe(false);
			expect(
				await deleteOsBlueprint(db, {
					organizationId: "org-1",
					blueprintId: "bp-1",
				}),
			).toBe(true);
			expect(
				await getOsBlueprint(db, {
					organizationId: "org-1",
					blueprintId: "bp-1",
				}),
			).toBeUndefined();
			expect(
				await listOsBlueprintRevisions(db, {
					organizationId: "org-1",
					blueprintId: "bp-1",
				}),
			).toHaveLength(0);
		});

		it.each([null, "missing-revision"])(
			"treats an unselected base %s as revision zero without reusing history numbers",
			async (currentRevisionId) => {
				const db = await fixture(store);
				await createOsBlueprint(db, { ...blueprint, currentRevisionId });
				await db.insert(coreTable(db, osBlueprintRevisions)).values({
					id: "historical",
					organizationId: "org-1",
					blueprintId: "bp-1",
					revision: 7,
					definition: "{}",
					createdByKind: "user",
					createdById: "u-1",
				});
				const created = await createOsBlueprintRevision(
					db,
					revisionParams("selected", 0),
				);
				expect(created).toMatchObject({ ok: true, revision: { revision: 8 } });
				expect(
					await getOsBlueprint(db, {
						organizationId: "org-1",
						blueprintId: "bp-1",
					}),
				).toMatchObject({ currentRevisionId: "selected" });
				expect(
					await createOsBlueprintRevision(db, revisionParams("stale-zero", 0)),
				).toEqual({ ok: false, reason: "revision_conflict" });
				expect(
					await getOsBlueprint(db, {
						organizationId: "org-1",
						blueprintId: "bp-1",
					}),
				).toMatchObject({ currentRevisionId: "selected" });
				expect(
					await listOsBlueprintRevisions(db, {
						organizationId: "org-1",
						blueprintId: "bp-1",
					}),
				).toHaveLength(2);
			},
		);
		it("allows one concurrent author to replace the selected base and keeps the losing draft uncommitted", async () => {
			const db = await fixture(store);
			await createOsBlueprint(db, blueprint);
			await createOsBlueprintRevision(db, revisionParams("base", 0));
			const results = await Promise.all([
				createOsBlueprintRevision(db, revisionParams("writer-a", 1)),
				createOsBlueprintRevision(db, revisionParams("writer-b", 1)),
			]);
			const winners = results.filter((result) => result.ok);
			expect(winners).toHaveLength(1);
			expect(results.filter((result) => !result.ok)).toEqual([
				{ ok: false, reason: "revision_conflict" },
			]);
			const winner = winners[0];
			if (!winner?.ok) throw new Error("Expected one committed revision");
			expect(winner.revision.revision).toBe(2);
			expect(
				await getOsBlueprint(db, {
					organizationId: "org-1",
					blueprintId: "bp-1",
				}),
			).toMatchObject({ currentRevisionId: winner.revision.id });
			expect(
				await listOsBlueprintRevisions(db, {
					organizationId: "org-1",
					blueprintId: "bp-1",
				}),
			).toHaveLength(2);
		});

		it("appends revisions with max+1, honours the CAS, and moves the pointer", async () => {
			const db = await fixture(store);
			await createOsBlueprint(db, blueprint);
			const first = await createOsBlueprintRevision(
				db,
				revisionParams("rev-1"),
			);
			expect(first).toMatchObject({ ok: true });
			if (first.ok) expect(first.revision.revision).toBe(1);
			const stale = await createOsBlueprintRevision(
				db,
				revisionParams("rev-2", 0),
			);
			expect(stale).toEqual({ ok: false, reason: "revision_conflict" });
			const second = await createOsBlueprintRevision(
				db,
				revisionParams("rev-2", 1),
			);
			expect(second).toMatchObject({ ok: true });
			expect(
				await getOsBlueprint(db, {
					organizationId: "org-1",
					blueprintId: "bp-1",
				}),
			).toMatchObject({ currentRevisionId: "rev-2" });
			expect(
				await createOsBlueprintRevision(db, {
					...revisionParams("rev-x"),
					organizationId: "org-2",
				}),
			).toEqual({ ok: false, reason: "blueprint_not_found" });
			expect(
				await createOsBlueprintRevision(db, revisionParams("rev-1", 0)),
			).toEqual({
				ok: false,
				reason: "revision_conflict",
			});
			expect(
				await getOsBlueprint(db, {
					organizationId: "org-1",
					blueprintId: "bp-1",
				}),
			).toMatchObject({
				currentRevisionId: "rev-2",
			});
		});

		it("restores archive metadata and rolls back an import whose revision fails", async () => {
			const db = await fixture(store);
			const revision = {
				...revisionParams("imported-r1"),
				revision: 1,
				blueprintId: "imported",
			};
			await importOsBlueprint(db, {
				blueprint: {
					...blueprint,
					id: "imported",
					status: "published",
					visibility: "catalog",
					currentRevisionId: revision.id,
				},
				revision,
			});
			const scope = { organizationId: "org-1", blueprintId: "imported" };
			expect(
				await updateOsBlueprint(db, scope, {
					status: "archived",
					visibility: "org",
				}),
			).toMatchObject({
				archivedFrom: { status: "published", visibility: "catalog" },
			});
			await updateOsBlueprint(db, scope, { status: "archived" });
			expect(
				await restoreOsBlueprint(db, { ...scope, organizationId: "org-2" }),
			).toBeUndefined();
			expect(await restoreOsBlueprint(db, scope)).toMatchObject({
				status: "published",
				visibility: "catalog",
				archivedFrom: null,
			});
			await expect(
				importOsBlueprint(db, {
					blueprint: {
						...blueprint,
						id: "failed-import",
						name: "Failed import",
						currentRevisionId: revision.id,
					},
					revision: { ...revision, blueprintId: "failed-import" },
				}),
			).rejects.toThrow();
			expect(
				await getOsBlueprint(db, {
					organizationId: "org-1",
					blueprintId: "failed-import",
				}),
			).toBeUndefined();
		});

		it("rolls back the publication stamp when the blueprint update fails", async () => {
			const db = await fixture(store);
			await createOsBlueprint(db, blueprint);
			await createOsBlueprintRevision(db, revisionParams("rev-1"));
			if (store === "postgres") {
				await db.run(
					sql`CREATE FUNCTION refuse_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publication refused'; END $$`,
				);
				await db.run(
					sql`CREATE TRIGGER refuse_publish BEFORE UPDATE ON os_blueprints FOR EACH ROW EXECUTE FUNCTION refuse_publish()`,
				);
			} else {
				await db.run(
					sql`CREATE TRIGGER refuse_publish BEFORE UPDATE ON os_blueprints BEGIN SELECT RAISE(ABORT, 'publication refused'); END`,
				);
			}
			await expect(
				publishOsBlueprintRevision(db, {
					organizationId: "org-1",
					blueprintId: "bp-1",
					revisionId: "rev-1",
				}),
			).rejects.toThrow();
			const [revision] = await listOsBlueprintRevisions(db, {
				organizationId: "org-1",
				blueprintId: "bp-1",
			});
			expect(revision?.publishedAt).toBeNull();
			expect(
				await getOsBlueprint(db, {
					organizationId: "org-1",
					blueprintId: "bp-1",
				}),
			).toMatchObject({ status: "draft" });
		});

		it("publishes one revision and stamps it, atomically", async () => {
			const db = await fixture(store);
			await createOsBlueprint(db, blueprint);
			await createOsBlueprintRevision(db, revisionParams("rev-1"));
			const miss = await publishOsBlueprintRevision(db, {
				organizationId: "org-1",
				blueprintId: "bp-1",
				revisionId: "rev-missing",
			});
			expect(miss).toEqual({ ok: false, reason: "revision_not_found" });
			expect(
				await getOsBlueprint(db, {
					organizationId: "org-1",
					blueprintId: "bp-1",
				}),
			).toMatchObject({ status: "draft" });

			const published = await publishOsBlueprintRevision(db, {
				organizationId: "org-1",
				blueprintId: "bp-1",
				revisionId: "rev-1",
			});
			expect(published).toMatchObject({
				ok: true,
				blueprint: { status: "published", currentRevisionId: "rev-1" },
			});
			const [revision] = await listOsBlueprintRevisions(db, {
				organizationId: "org-1",
				blueprintId: "bp-1",
			});
			expect(revision?.publishedAt).toBeTruthy();
		});
	});

	/** Publish `bp-1` with a two-gadget revision so it is gallery-eligible. */
	async function publishBlueprintFixture(db: DbQueryClient) {
		await createOsBlueprint(db, blueprint);
		await createOsBlueprintRevision(db, {
			...revisionParams("rev-1"),
			definition:
				'{"gadgets":[{"name":"CRM"},{"name":"Pipeline"}],"layout":null,"skills":[]}',
		});
		await publishOsBlueprintRevision(db, {
			organizationId: "org-1",
			blueprintId: "bp-1",
			revisionId: "rev-1",
		});
	}

	describe(`os blueprint gallery: ${store}`, () => {
		it("defaults visibility to org and updates it tenant-scoped", async () => {
			const db = await fixture(store);
			await createOsBlueprint(db, blueprint);
			expect(
				await getOsBlueprint(db, {
					organizationId: "org-1",
					blueprintId: "bp-1",
				}),
			).toMatchObject({ visibility: "org" });
			// Another tenant cannot flip the flag.
			expect(
				await setOsBlueprintVisibility(
					db,
					{ organizationId: "org-2", blueprintId: "bp-1" },
					"catalog",
				),
			).toBeUndefined();
			expect(
				await setOsBlueprintVisibility(
					db,
					{ organizationId: "org-1", blueprintId: "bp-1" },
					"catalog",
				),
			).toMatchObject({ visibility: "catalog" });
		});

		it("lists only catalog-visible published blueprints, joined with the org name and gadget count", async () => {
			const db = await fixture(store);
			await publishBlueprintFixture(db);
			// Published but org-private: invisible.
			expect(await listCatalogOsBlueprints(db)).toHaveLength(0);

			await setOsBlueprintVisibility(
				db,
				{ organizationId: "org-1", blueprintId: "bp-1" },
				"catalog",
			);
			// A catalog-visible DRAFT in another org must stay invisible too.
			await createOsBlueprint(db, {
				...blueprint,
				id: "bp-2",
				organizationId: "org-2",
				visibility: "catalog",
			});

			const listed = await listCatalogOsBlueprints(db);
			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({
				blueprint: { id: "bp-1", name: "Support Desk", visibility: "catalog" },
				organizationName: "First Org",
				gadgetCount: 2,
				previewAppNames: ["CRM", "Pipeline"],
				publishedAt: expect.any(String),
			});
			// The limit is bounded, not trusted.
			expect(await listCatalogOsBlueprints(db, { limit: 1 })).toHaveLength(1);
			const blueprints = coreTable(db, osBlueprints);
			await db
				.update(blueprints)
				.set({ status: "published", currentRevisionId: "rev-1" })
				.where(eq(blueprints.id, "bp-2"));
			expect(
				(await listCatalogOsBlueprints(db)).map((row) => row.blueprint.id),
			).toEqual(["bp-1"]);
		});

		it("keeps non-string app names out of the preview without coercion", async () => {
			const db = await fixture(store);
			await createOsBlueprint(db, { ...blueprint, visibility: "catalog" });
			await createOsBlueprintRevision(db, {
				...revisionParams("rev-1"),
				definition: JSON.stringify({
					gadgets: [{ name: 7 }, { name: "雪' quoted" }],
				}),
			});
			await publishOsBlueprintRevision(db, {
				organizationId: "org-1",
				blueprintId: "bp-1",
				revisionId: "rev-1",
			});
			expect((await listCatalogOsBlueprints(db))[0]).toMatchObject({
				gadgetCount: 2,
				previewAppNames: ["雪' quoted"],
			});
		});

		it("names only the first apps, in declared order, for the card preview", async () => {
			const db = await fixture(store);
			const names = [
				"Inbox",
				"Board",
				"Notes",
				"Reports",
				"Plan",
				"Files",
				"Log",
			];
			await createOsBlueprint(db, { ...blueprint, visibility: "catalog" });
			await createOsBlueprintRevision(db, {
				...revisionParams("rev-1"),
				definition: JSON.stringify({
					gadgets: names.map((name) => ({ name })),
					layout: null,
					skills: [],
				}),
			});
			await publishOsBlueprintRevision(db, {
				organizationId: "org-1",
				blueprintId: "bp-1",
				revisionId: "rev-1",
			});
			// A template with no apps lists none instead of failing the whole page.
			await createOsBlueprint(db, {
				...blueprint,
				id: "bp-2",
				name: "Empty Pod",
				visibility: "catalog",
			});
			await createOsBlueprintRevision(db, {
				...revisionParams("rev-2"),
				blueprintId: "bp-2",
				definition: '{"gadgets":[],"layout":null,"skills":[]}',
			});
			await publishOsBlueprintRevision(db, {
				organizationId: "org-1",
				blueprintId: "bp-2",
				revisionId: "rev-2",
			});

			const listed = await listCatalogOsBlueprints(db);
			const byId = new Map(listed.map((row) => [row.blueprint.id, row]));
			expect(byId.get("bp-1")).toMatchObject({
				gadgetCount: 7,
				previewAppNames: names.slice(0, CATALOG_PREVIEW_APP_LIMIT),
			});
			expect(byId.get("bp-2")).toMatchObject({
				gadgetCount: 0,
				previewAppNames: [],
			});
		});

		it("resolves a catalog blueprint across orgs and hides private ones identically to missing ids", async () => {
			const db = await fixture(store);
			await publishBlueprintFixture(db);
			// Published but private: unresolvable, exactly like a missing id.
			expect(await getCatalogOsBlueprint(db, "bp-1")).toBeUndefined();
			expect(await getCatalogOsBlueprint(db, "bp-missing")).toBeUndefined();

			await setOsBlueprintVisibility(
				db,
				{ organizationId: "org-1", blueprintId: "bp-1" },
				"catalog",
			);
			expect(await getCatalogOsBlueprint(db, "bp-1")).toMatchObject({
				blueprint: { id: "bp-1", organizationId: "org-1" },
				organizationName: "First Org",
			});
		});

		it("features only catalog-visible published blueprints and keeps the first stamp", async () => {
			const db = await fixture(store);
			await publishBlueprintFixture(db);
			// Published but private: curation cannot reach it.
			expect(
				await setCatalogOsBlueprintFeatured(db, "bp-1", true),
			).toBeUndefined();
			expect(
				await setCatalogOsBlueprintFeatured(db, "bp-missing", true),
			).toBeUndefined();

			await setOsBlueprintVisibility(
				db,
				{ organizationId: "org-1", blueprintId: "bp-1" },
				"catalog",
			);
			const featured = await setCatalogOsBlueprintFeatured(db, "bp-1", true);
			expect(featured?.featuredAt).toEqual(expect.any(String));
			const again = await setCatalogOsBlueprintFeatured(db, "bp-1", true);
			expect(again?.featuredAt).toBe(featured?.featuredAt);
			expect((await listCatalogOsBlueprints(db))[0]?.blueprint.featuredAt).toBe(
				featured?.featuredAt,
			);

			expect(
				(await setCatalogOsBlueprintFeatured(db, "bp-1", false))?.featuredAt,
			).toBeNull();
		});
	});
}
