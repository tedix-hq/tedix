import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade, type D1FacadeOptions } from "../../test/d1-facade";
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

	it("records runtime app code with its revision and drops it with a lost CAS", async () => {
		const { db } = fixture();
		await createOsGadget(db, gadget);
		const files = JSON.stringify({ "server.js": "export {}", "client.js": "" });
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
		const { db, sqlite } = fixture();
		await createOsGadget(db, gadget);
		const files = JSON.stringify({ "server.js": "export {}", "client.js": "" });
		for (const [index, id] of ["rev-1", "rev-2", "rev-3"].entries())
			expect(
				await createOsGadgetRevision(db, {
					...revisionParams(id, index),
					code: { files, codeLength: 9 },
				}),
			).toMatchObject({ ok: true });
		expect(
			sqlite
				.prepare(
					"SELECT revision_id, files, length(files_sha256) AS hash_length FROM os_gadget_code ORDER BY revision_id",
				)
				.all(),
		).toEqual(
			["rev-1", "rev-2", "rev-3"].map((revision_id) => ({
				revision_id,
				files: "",
				hash_length: 64,
			})),
		);
		expect(
			sqlite
				.prepare(
					"SELECT organization_id, files, code_length FROM os_gadget_code_blobs",
				)
				.all(),
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
			sqlite.prepare("SELECT count(*) AS n FROM os_gadget_code_blobs").get(),
		).toEqual({ n: 2 });
		expect(
			(await getOsGadgetCode(db, {
				organizationId: "org-1",
				revisionId: "rev-4",
			}))!.files,
		).toBe(changed);
	});

	it("stores no blob when the guarded revision insert loses", async () => {
		const { db, sqlite } = fixture();
		await createOsGadget(db, gadget);
		await createOsGadgetRevision(db, revisionParams("rev-1"));
		const stale = await createOsGadgetRevision(db, {
			...revisionParams("rev-2", 0),
			code: { files: '{"server.js":"x"}', codeLength: 1 },
		});
		expect(stale).toEqual({ ok: false, reason: "revision_conflict" });
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM os_gadget_code_blobs").get(),
		).toEqual({ n: 0 });
	});

	it("reads a row written before the files were shared, and refuses a dangling pointer", async () => {
		const { db, sqlite } = fixture();
		await createOsGadget(db, gadget);
		await createOsGadgetRevision(db, revisionParams("rev-1"));
		await createOsGadgetRevision(db, revisionParams("rev-2"));
		const insert = sqlite.prepare(
			"INSERT INTO os_gadget_code (revision_id, organization_id, gadget_id, files, code_length, files_sha256) VALUES (?, 'org-1', 'gd-1', ?, 4, ?)",
		);
		insert.run("rev-1", '{"server.js":"old!"}', null);
		insert.run("rev-2", "", "0".repeat(64));
		expect(
			await getOsGadgetCode(db, {
				organizationId: "org-1",
				revisionId: "rev-1",
			}),
		).toMatchObject({
			files: '{"server.js":"old!"}',
			codeLength: 4,
			filesSha256: null,
		});
		await expect(
			getOsGadgetCode(db, { organizationId: "org-1", revisionId: "rev-2" }),
		).rejects.toThrow("Gadget code files are missing");
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
