import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade, type D1FacadeOptions } from "../../test/d1-facade";
import {
	createOsGadget,
	createOsGadgetRevision,
	getOsGadget,
	getOsGadgetRevision,
	listOsGadgetRevisions,
	listOsGadgets,
} from "./gadgets";

function fixture(options: D1FacadeOptions = {}) {
	const sqlite = new DatabaseSync(":memory:");
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
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
		INSERT INTO os_workspaces (id, organization_id, name, created_by_kind, created_by_id)
			VALUES ('ws-1', 'org-1', 'Operations', 'user', 'u-1');
	`);
	return { db: createDbQueryClient(createD1Facade(sqlite, options)), sqlite };
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

describe("os gadgets", () => {
	it("creates gadgets and lists them scoped by organization and workspace", async () => {
		const { db } = fixture();
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
		const { db } = fixture();
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

	it("returns a typed CAS failure on a stale expectedRevision without side effects", async () => {
		const { db } = fixture();
		await createOsGadget(db, gadget);
		await createOsGadgetRevision(db, revisionParams("rev-1"));
		const stale = await createOsGadgetRevision(db, revisionParams("rev-2", 0));
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
	});

	it("loses the CAS to a competing writer landing inside the write window", async () => {
		let injected = false;
		const { db } = fixture({
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
		const result = await createOsGadgetRevision(db, revisionParams("rev-1", 0));
		expect(result).toEqual({ ok: false, reason: "revision_conflict" });
	});

	it("reports gadget_not_found for a foreign organization or missing gadget", async () => {
		const { db } = fixture();
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
