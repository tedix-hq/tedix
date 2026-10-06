/**
 * Blueprint upgrade application: the whole reconcile plus the re-pin ride one
 * D1 batch, fenced on the pin the plan was computed against.
 *
 * The assertions here are deliberately about ROWS, not return values: an apply
 * that lost the compare-and-swap must leave the database byte-identical, and a
 * return value alone cannot show that.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	osGadgetRevisions,
	osGadgets,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	applyOsBlueprintUpgrade,
	recordOsWorkspaceBlueprintDecision,
} from "./upgrade";

const NOW = "2026-08-17T12:00:00.000Z";
const SEEDED_AT = "2026-08-01T00:00:00.000Z";
const PINNED_REVISION = "bprev-1";
const CANDIDATE_REVISION = "bprev-2";

/** Stand-in preflight envelopes; this module stores them as opaque JSON text. */
const OLD_PREFLIGHT = '{"revision":1,"status":"ready"}';
const NEW_PREFLIGHT = '{"revision":2,"status":"ready"}';
const DECISION = '{"version":1,"decision":"applied"}';

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	// OS tables come from the Drizzle schema itself, so a column added later
	// cannot drift away from what this fixture creates. Only the `organizations`
	// parent is stubbed — no column of it is read here.
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
	`);
	sqlite.exec(schemaDdl(osWorkspaces, osGadgets, osGadgetRevisions));
	// One workspace pinned to bprev-1, carrying two gadgets: "Keep" (which the
	// candidate still declares) and "Drop" (which it no longer does).
	sqlite.exec(`
		INSERT INTO os_workspaces (
			id, organization_id, name, status,
			source_blueprint_id, source_blueprint_revision_id,
			source_blueprint_revision_number, instantiation_preflight,
			created_by_kind, created_by_id, created_at, updated_at
		) VALUES (
			'ws-1', 'org-1', 'Sales Pod', 'active',
			'bp-1', '${PINNED_REVISION}', 1, '${OLD_PREFLIGHT}',
			'user', 'u-0', '${SEEDED_AT}', '${SEEDED_AT}'
		);
		INSERT INTO os_gadgets (
			id, organization_id, workspace_id, name, status, current_revision_id,
			source_blueprint_revision_id, created_by_kind, created_by_id,
			created_at, updated_at
		) VALUES
			('gd-keep', 'org-1', 'ws-1', 'Keep', 'active', 'gdrev-keep-1',
				'${PINNED_REVISION}', 'user', 'u-0', '${SEEDED_AT}', '${SEEDED_AT}'),
			('gd-drop', 'org-1', 'ws-1', 'Drop', 'active', 'gdrev-drop-1',
				'${PINNED_REVISION}', 'user', 'u-0', '${SEEDED_AT}', '${SEEDED_AT}');
		INSERT INTO os_gadget_revisions (
			id, organization_id, gadget_id, revision, manifest,
			created_by_kind, created_by_id, created_at
		) VALUES
			('gdrev-keep-1', 'org-1', 'gd-keep', 1, '{"entry":"keep.ts"}',
				'user', 'u-0', '${SEEDED_AT}'),
			('gdrev-drop-1', 'org-1', 'gd-drop', 1, '{"entry":"drop.ts"}',
				'user', 'u-0', '${SEEDED_AT}');
	`);
	return { db: createDbQueryClient(createD1Facade(sqlite)), sqlite };
}

const ACCOUNTABILITY = {
	organizationId: "org-1",
	createdByKind: "user" as const,
	createdById: "u-1",
	createdAt: NOW,
};

/** The plan the router computes: add "New", re-pin "Keep" with a changed manifest, archive "Drop". */
function plan(overrides: Record<string, unknown> = {}) {
	return {
		organizationId: "org-1",
		workspaceId: "ws-1",
		expectedRevisionId: PINNED_REVISION,
		expectedRevisionNumber: 1,
		expectedInstantiationPreflight: OLD_PREFLIGHT,
		nextRevisionId: CANDIDATE_REVISION,
		nextRevisionNumber: 2,
		nextInstantiationPreflight: NEW_PREFLIGHT,
		blueprintDecision: DECISION,
		added: [
			{
				gadget: {
					...ACCOUNTABILITY,
					id: "gd-new",
					workspaceId: "ws-1",
					name: "New",
					description: null,
					status: "active" as const,
					currentRevisionId: "gdrev-new-1",
					sourceBlueprintRevisionId: CANDIDATE_REVISION,
					updatedAt: NOW,
				},
				revision: {
					...ACCOUNTABILITY,
					id: "gdrev-new-1",
					gadgetId: "gd-new",
					revision: 1,
					manifest: '{"entry":"new.ts"}',
					sourceArtifactRef: null,
				},
			},
		],
		synced: [
			{
				gadgetId: "gd-keep",
				append: {
					revisionId: "gdrev-keep-2",
					manifest: '{"entry":"keep-v2.ts"}',
					createdByKind: "user" as const,
					createdById: "u-1",
				},
			},
		],
		archivedGadgetIds: ["gd-drop"],
		now: NOW,
		...overrides,
	};
}

function rows(sqlite: DatabaseSync, sql: string): Record<string, unknown>[] {
	return sqlite.prepare(sql).all() as Record<string, unknown>[];
}

describe("os blueprint upgrade application", () => {
	it("re-pins, reconciles gadgets, and retains the rollback reference in one batch", async () => {
		const { db, sqlite } = fixture();

		const result = await applyOsBlueprintUpgrade(db, plan());
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// The workspace moved to the candidate and KEPT the pin it left, with the
		// envelope recorded there — that pair is the rollback reference.
		expect(result.workspace).toMatchObject({
			sourceBlueprintRevisionId: CANDIDATE_REVISION,
			sourceBlueprintRevisionNumber: 2,
			instantiationPreflight: NEW_PREFLIGHT,
			previousBlueprintRevisionId: PINNED_REVISION,
			previousBlueprintRevisionNumber: 1,
			previousInstantiationPreflight: OLD_PREFLIGHT,
			blueprintDecision: DECISION,
			updatedAt: NOW,
		});
		// Read back from the row, not only the RETURNING projection.
		expect(rows(sqlite, "SELECT * FROM os_workspaces")[0]).toMatchObject({
			source_blueprint_revision_id: CANDIDATE_REVISION,
			previous_blueprint_revision_id: PINNED_REVISION,
			previous_instantiation_preflight: OLD_PREFLIGHT,
			blueprint_decision: DECISION,
		});

		// Added gadget lands with its revision-1 row and the pointer preset.
		expect(result.addedGadgets.map((row) => row.id)).toEqual(["gd-new"]);
		expect(
			rows(sqlite, "SELECT * FROM os_gadgets WHERE id = 'gd-new'")[0],
		).toMatchObject({
			name: "New",
			current_revision_id: "gdrev-new-1",
			source_blueprint_revision_id: CANDIDATE_REVISION,
			status: "active",
		});

		// Changed manifest appends revision 2 and moves the pointer; nothing is
		// mutated in place, so revision 1 is still there.
		expect(result.appendedRevisions.map((row) => row.id)).toEqual([
			"gdrev-keep-2",
		]);
		expect(
			rows(
				sqlite,
				"SELECT revision, manifest FROM os_gadget_revisions WHERE gadget_id = 'gd-keep' ORDER BY revision",
			),
		).toEqual([
			{ revision: 1, manifest: '{"entry":"keep.ts"}' },
			{ revision: 2, manifest: '{"entry":"keep-v2.ts"}' },
		]);
		expect(
			rows(sqlite, "SELECT * FROM os_gadgets WHERE id = 'gd-keep'")[0],
		).toMatchObject({
			current_revision_id: "gdrev-keep-2",
			source_blueprint_revision_id: CANDIDATE_REVISION,
			status: "active",
		});

		// A dropped gadget is archived, never deleted: its revisions survive.
		expect(
			rows(sqlite, "SELECT * FROM os_gadgets WHERE id = 'gd-drop'")[0],
		).toMatchObject({
			status: "archived",
			// Its lineage still names the revision that declared it.
			source_blueprint_revision_id: PINNED_REVISION,
		});
		expect(
			rows(
				sqlite,
				"SELECT id FROM os_gadget_revisions WHERE gadget_id = 'gd-drop'",
			),
		).toHaveLength(1);
	});

	it("restamps a synced gadget without appending when the manifest is unchanged", async () => {
		const { db, sqlite } = fixture();

		const result = await applyOsBlueprintUpgrade(
			db,
			plan({
				added: [],
				archivedGadgetIds: [],
				synced: [{ gadgetId: "gd-keep", append: null }],
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.appendedRevisions).toEqual([]);
		expect(
			rows(
				sqlite,
				"SELECT id FROM os_gadget_revisions WHERE gadget_id = 'gd-keep'",
			),
		).toEqual([{ id: "gdrev-keep-1" }]);
		// The lineage stamp still moves: the candidate declares this gadget.
		expect(
			rows(sqlite, "SELECT * FROM os_gadgets WHERE id = 'gd-keep'")[0],
		).toMatchObject({
			source_blueprint_revision_id: CANDIDATE_REVISION,
			current_revision_id: "gdrev-keep-1",
		});
	});

	it("computes the appended revision number in-statement, so a concurrent revision cannot collide", async () => {
		const { db, sqlite } = fixture();
		// Someone appended revision 2 through the ordinary gadget path after the
		// upgrade plan was computed.
		sqlite.exec(`
			INSERT INTO os_gadget_revisions (
				id, organization_id, gadget_id, revision, manifest,
				created_by_kind, created_by_id, created_at
			) VALUES ('gdrev-keep-x', 'org-1', 'gd-keep', 2, '{"entry":"hand.ts"}',
				'user', 'u-9', '${SEEDED_AT}');
		`);

		const result = await applyOsBlueprintUpgrade(db, plan({ added: [] }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// max+1, not a number the caller precomputed.
		expect(result.appendedRevisions[0]).toMatchObject({
			id: "gdrev-keep-2",
			revision: 3,
		});
	});

	it("writes NOTHING when the pin moved: every statement is fenced on the old pin", async () => {
		const { db, sqlite } = fixture();
		const before = rows(sqlite, "SELECT * FROM os_workspaces");

		const result = await applyOsBlueprintUpgrade(
			db,
			plan({ expectedRevisionId: "bprev-someone-else-applied" }),
		);
		expect(result).toEqual({ ok: false, reason: "pin_moved" });

		// No gadget added, none archived, no revision appended, pin untouched.
		expect(rows(sqlite, "SELECT id FROM os_gadgets ORDER BY id")).toEqual([
			{ id: "gd-drop" },
			{ id: "gd-keep" },
		]);
		expect(
			rows(sqlite, "SELECT status FROM os_gadgets WHERE id = 'gd-drop'")[0],
		).toEqual({ status: "active" });
		expect(rows(sqlite, "SELECT id FROM os_gadget_revisions")).toHaveLength(2);
		expect(rows(sqlite, "SELECT * FROM os_workspaces")).toEqual(before);
	});

	it("binds the organization: another tenant cannot upgrade this workspace", async () => {
		const { db, sqlite } = fixture();

		const result = await applyOsBlueprintUpgrade(
			db,
			// Same workspace id and the CORRECT pin — only the organization differs.
			plan({ organizationId: "org-2" }),
		);
		expect(result).toEqual({ ok: false, reason: "pin_moved" });
		expect(rows(sqlite, "SELECT id FROM os_gadgets ORDER BY id")).toEqual([
			{ id: "gd-drop" },
			{ id: "gd-keep" },
		]);
		expect(
			rows(sqlite, "SELECT source_blueprint_revision_id FROM os_workspaces")[0],
		).toEqual({ source_blueprint_revision_id: PINNED_REVISION });
	});
});

describe("os workspace blueprint decision", () => {
	const STAY = '{"version":1,"decision":"stay_pinned"}';

	it("records a stay_pinned review without moving the pin or any gadget", async () => {
		const { db, sqlite } = fixture();

		const row = await recordOsWorkspaceBlueprintDecision(db, {
			organizationId: "org-1",
			workspaceId: "ws-1",
			expectedRevisionId: PINNED_REVISION,
			blueprintDecision: STAY,
			now: NOW,
		});
		expect(row).toMatchObject({
			blueprintDecision: STAY,
			sourceBlueprintRevisionId: PINNED_REVISION,
			sourceBlueprintRevisionNumber: 1,
			updatedAt: NOW,
		});
		expect(rows(sqlite, "SELECT * FROM os_workspaces")[0]).toMatchObject({
			blueprint_decision: STAY,
			source_blueprint_revision_id: PINNED_REVISION,
			// Reviewing is not upgrading: no rollback reference appears.
			previous_blueprint_revision_id: null,
			instantiation_preflight: OLD_PREFLIGHT,
		});
		expect(
			rows(sqlite, "SELECT source_blueprint_revision_id FROM os_gadgets")[0],
		).toEqual({ source_blueprint_revision_id: PINNED_REVISION });
	});

	it("refuses a decision about a pin the workspace has already left, and one from another tenant", async () => {
		const { db, sqlite } = fixture();

		await expect(
			recordOsWorkspaceBlueprintDecision(db, {
				organizationId: "org-1",
				workspaceId: "ws-1",
				expectedRevisionId: CANDIDATE_REVISION,
				blueprintDecision: STAY,
				now: NOW,
			}),
		).resolves.toBeUndefined();
		await expect(
			recordOsWorkspaceBlueprintDecision(db, {
				organizationId: "org-2",
				workspaceId: "ws-1",
				expectedRevisionId: PINNED_REVISION,
				blueprintDecision: STAY,
				now: NOW,
			}),
		).resolves.toBeUndefined();
		// Neither call touched the row: no decision, and the seeded timestamp.
		expect(rows(sqlite, "SELECT * FROM os_workspaces")[0]).toMatchObject({
			blueprint_decision: null,
			updated_at: SEEDED_AT,
		});
	});
});
