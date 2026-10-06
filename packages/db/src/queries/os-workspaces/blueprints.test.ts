import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { osBlueprintRevisions, osBlueprints } from "../../schema/os-workspaces";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	createOsBlueprint,
	createOsBlueprintRevision,
	deleteOsBlueprint,
	getCatalogOsBlueprint,
	getOsBlueprint,
	listCatalogOsBlueprints,
	listOsBlueprintRevisions,
	listOsBlueprints,
	publishOsBlueprintRevision,
	setOsBlueprintVisibility,
} from "./blueprints";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
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
	return createDbQueryClient(createD1Facade(sqlite));
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

describe("os blueprints", () => {
	it("creates draft blueprints scoped by organization", async () => {
		const db = fixture();
		expect(await createOsBlueprint(db, blueprint)).toMatchObject({
			status: "draft",
		});
		expect(
			await listOsBlueprints(db, "org-1", { status: "draft" }),
		).toHaveLength(1);
		expect(await listOsBlueprints(db, "org-2")).toHaveLength(0);
	});

	it("permanently deletes the blueprint and revisions inside org scope", async () => {
		const db = fixture();
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

	it("appends revisions with max+1, honours the CAS, and moves the pointer", async () => {
		const db = fixture();
		await createOsBlueprint(db, blueprint);
		const first = await createOsBlueprintRevision(db, revisionParams("rev-1"));
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
	});

	it("publishes one revision and stamps it, atomically", async () => {
		const db = fixture();
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
async function publishBlueprintFixture(db: ReturnType<typeof fixture>) {
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

describe("os blueprint gallery", () => {
	it("defaults visibility to org and updates it tenant-scoped", async () => {
		const db = fixture();
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
		const db = fixture();
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
			publishedAt: expect.any(String),
		});
		// The limit is bounded, not trusted.
		expect(await listCatalogOsBlueprints(db, { limit: 1 })).toHaveLength(1);
	});

	it("resolves a catalog blueprint across orgs and hides private ones identically to missing ids", async () => {
		const db = fixture();
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
});
