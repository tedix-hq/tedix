import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	osOutputRevisions,
	osOutputs,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	createOsOutput,
	createOsOutputRevision,
	deleteOsOutput,
	getOsOutput,
	getOsOutputRevision,
	getOsOutputRevisionByNumber,
	listOsOutputLibraryRows,
	listOsOutputRevisions,
	listOsOutputs,
	updateOsOutput,
} from "./outputs";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
	`);
	sqlite.exec(schemaDdl(osWorkspaces, osOutputs, osOutputRevisions));
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

const accountability = {
	organizationId: "org-1",
	createdByKind: "tedi" as const,
	createdById: "tedi-1",
	createdAt: "2026-08-13T18:00:00.000Z",
};

const priorEnvelope = JSON.stringify({
	version: 1,
	sources: [
		{
			workspaceResourceId: "11111111-1111-4111-8111-111111111111",
			workspaceId: "22222222-2222-4222-8222-222222222222",
			providerId: "google-drive",
			resourceType: "document",
			providerResourceId: "doc-1",
			connectionScope: "tenant",
			requiredScopes: ["documents.read"],
			operations: ["read"],
		},
	],
});

async function seedOutput(
	db: ReturnType<typeof fixture>["db"],
	id = "out-1",
	workspaceId = "ws-1",
) {
	return createOsOutput(
		db,
		{
			...accountability,
			id,
			workspaceId,
			kind: "document",
			title: "Launch brief",
			status: "active",
			currentRevisionId: `${id}-rev-1`,
			updatedAt: accountability.createdAt,
		},
		{
			...accountability,
			id: `${id}-rev-1`,
			outputId: id,
			revision: 1,
			content: '{"kind":"document","blocks":[]}',
			note: null,
		},
	);
}

describe("os outputs", () => {
	it("creates output + revision 1 atomically with the pointer preset", async () => {
		const { db } = fixture();
		const created = await seedOutput(db);
		expect(created.output).toMatchObject({
			kind: "document",
			currentRevisionId: "out-1-rev-1",
		});
		expect(created.revision.revision).toBe(1);
		expect(
			await getOsOutput(db, { organizationId: "org-2", outputId: "out-1" }),
		).toBeUndefined();
		expect(await listOsOutputs(db, "org-1", { kind: "document" })).toHaveLength(
			1,
		);
		expect(await listOsOutputs(db, "org-1", { kind: "sheet" })).toHaveLength(0);
		expect(
			(await listOsOutputLibraryRows(db, "org-1"))[0]?.workspace,
		).toBeNull();
	});

	it("appends revisions max+1 with CAS and advances the pointer", async () => {
		const { db } = fixture();
		await seedOutput(db);
		const second = await createOsOutputRevision(db, {
			id: "rev-2",
			organizationId: "org-1",
			outputId: "out-1",
			content:
				'{"kind":"document","blocks":[{"type":"paragraph","text":"v2"}]}',
			note: "second draft",
			createdByKind: "tedi",
			createdById: "tedi-1",
			expectedRevision: 1,
		});
		expect(second).toMatchObject({ ok: true });
		if (second.ok) expect(second.revision.revision).toBe(2);
		expect(
			await getOsOutput(db, { organizationId: "org-1", outputId: "out-1" }),
		).toMatchObject({ currentRevisionId: "rev-2" });

		const stale = await createOsOutputRevision(db, {
			id: "rev-3",
			organizationId: "org-1",
			outputId: "out-1",
			content: "{}",
			createdByKind: "tedi",
			createdById: "tedi-1",
			expectedRevision: 1,
		});
		expect(stale).toEqual({ ok: false, reason: "revision_conflict" });
		expect(
			await listOsOutputRevisions(db, {
				organizationId: "org-1",
				outputId: "out-1",
			}),
		).toHaveLength(2);
		expect(
			await getOsOutputRevision(db, {
				organizationId: "org-1",
				revisionId: "rev-2",
			}),
		).toMatchObject({ note: "second draft" });
	});

	it("resolves an exact revision number only inside its organization and output", async () => {
		const { db } = fixture();
		await seedOutput(db);
		expect(
			await getOsOutputRevisionByNumber(db, {
				organizationId: "org-1",
				outputId: "out-1",
				revision: 1,
			}),
		).toMatchObject({ id: "out-1-rev-1" });
		for (const params of [
			{ organizationId: "org-2", outputId: "out-1", revision: 1 },
			{ organizationId: "org-1", outputId: "other", revision: 1 },
			{ organizationId: "org-1", outputId: "out-1", revision: 2 },
		]) {
			expect(await getOsOutputRevisionByNumber(db, params)).toBeUndefined();
		}
	});

	it("preserves source lineage for a human revision and defaults omitted CAS to the captured base", async () => {
		const { db, sqlite } = fixture();
		await seedOutput(db);
		sqlite
			.prepare(
				"UPDATE os_output_revisions SET access_envelope = ? WHERE id = ?",
			)
			.run(priorEnvelope, "out-1-rev-1");
		const revised = await createOsOutputRevision(db, {
			id: "rev-human",
			organizationId: "org-1",
			outputId: "out-1",
			content: '{"kind":"document","blocks":[]}',
			createdByKind: "user",
			createdById: "u-1",
			accessEnvelope: '{"version":1,"sources":[]}',
		});
		expect(revised).toMatchObject({
			ok: true,
			revision: { accessEnvelope: priorEnvelope },
		});
	});

	it("allows only one omitted-CAS writer to append from a captured base", async () => {
		const { db } = fixture();
		await seedOutput(db);
		const params = {
			organizationId: "org-1",
			outputId: "out-1",
			content: '{"kind":"document","blocks":[]}',
			createdByKind: "user" as const,
			createdById: "u-1",
			accessEnvelope: '{"version":1,"sources":[]}',
		};
		const results = await Promise.all([
			createOsOutputRevision(db, { ...params, id: "racing-a" }),
			createOsOutputRevision(db, { ...params, id: "racing-b" }),
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toEqual([
			{ ok: false, reason: "revision_conflict" },
		]);
	});

	it("rejects a future expectedRevision before it can adopt another writer's revision", async () => {
		const { db, sqlite } = fixture();
		await seedOutput(db);
		const params = {
			organizationId: "org-1",
			outputId: "out-1",
			content: '{"kind":"document","blocks":[]}',
			createdByKind: "user" as const,
			createdById: "u-1",
			accessEnvelope: '{"version":1,"sources":[]}',
		};
		expect(
			await createOsOutputRevision(db, {
				...params,
				id: "future-only",
				expectedRevision: 2,
			}),
		).toEqual({ ok: false, reason: "revision_conflict" });
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM os_output_revisions").get(),
		).toEqual({ count: 1 });
		const [normal, future] = await Promise.all([
			createOsOutputRevision(db, { ...params, id: "normal-rev" }),
			createOsOutputRevision(db, {
				...params,
				id: "future-rev",
				expectedRevision: 2,
			}),
		]);
		expect(normal.ok).toBe(true);
		expect(future).toEqual({ ok: false, reason: "revision_conflict" });
		expect(
			sqlite
				.prepare("SELECT id FROM os_output_revisions ORDER BY revision")
				.all(),
		).toEqual([{ id: "out-1-rev-1" }, { id: "normal-rev" }]);
	});

	it("reports output_not_found for foreign orgs and archives in scope", async () => {
		const { db } = fixture();
		await seedOutput(db);
		expect(
			await createOsOutputRevision(db, {
				id: "rev-x",
				organizationId: "org-2",
				outputId: "out-1",
				content: "{}",
				createdByKind: "user",
				createdById: "u-2",
			}),
		).toEqual({ ok: false, reason: "output_not_found" });
		expect(
			await updateOsOutput(
				db,
				{ organizationId: "org-2", outputId: "out-1" },
				{ status: "archived" },
			),
		).toBeUndefined();
		expect(
			await updateOsOutput(
				db,
				{ organizationId: "org-1", outputId: "out-1" },
				{ status: "archived" },
			),
		).toMatchObject({ status: "archived" });
	});

	it("permanently deletes the output and revisions inside org scope", async () => {
		const { db } = fixture();
		await seedOutput(db);
		expect(
			await deleteOsOutput(db, {
				organizationId: "org-2",
				outputId: "out-1",
			}),
		).toBe(false);
		expect(
			await deleteOsOutput(db, {
				organizationId: "org-1",
				outputId: "out-1",
			}),
		).toBe(true);
		expect(
			await getOsOutput(db, { organizationId: "org-1", outputId: "out-1" }),
		).toBeUndefined();
		expect(
			await getOsOutputRevision(db, {
				organizationId: "org-1",
				revisionId: "out-1-rev-1",
			}),
		).toBeUndefined();
	});

	it("joins current previews to workspace provenance without hiding archived workspaces", async () => {
		const { db } = fixture();
		await db.insert(osWorkspaces).values({
			id: "ws-1",
			organizationId: "org-1",
			name: "Launch room",
			status: "archived",
			createdByKind: "user",
			createdById: "u-1",
		});
		await seedOutput(db);
		const rows = await listOsOutputLibraryRows(db, "org-1", {
			status: "active",
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			output: { id: "out-1" },
			revision: { id: "out-1-rev-1", revision: 1 },
			workspace: { id: "ws-1", name: "Launch room", status: "archived" },
		});
		expect(await listOsOutputLibraryRows(db, "org-2")).toHaveLength(0);
	});

	it("filters the output library to the requested workspace", async () => {
		const { db } = fixture();
		await db.insert(osWorkspaces).values([
			{
				id: "ws-1",
				organizationId: "org-1",
				name: "First workspace",
				createdByKind: "user",
				createdById: "u-1",
			},
			{
				id: "ws-2",
				organizationId: "org-1",
				name: "Second workspace",
				createdByKind: "user",
				createdById: "u-1",
			},
		]);
		await seedOutput(db, "out-1", "ws-1");
		await seedOutput(db, "out-2", "ws-2");

		const rows = await listOsOutputLibraryRows(db, "org-1", {
			workspaceId: "ws-2",
		});
		expect(rows.map((row) => row.output.id)).toEqual(["out-2"]);
	});
});
