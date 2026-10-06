import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	osBlueprintRevisions,
	osBlueprints,
	osGadgetRevisions,
	osGadgets,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { instantiateOsBlueprint } from "./instantiate";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	// Every OS table is emitted from the Drizzle schema itself, so a column added
	// to any of them cannot drift away from what this fixture creates — which
	// matters most here, where the whole point is an all-or-nothing batch across
	// five tables. Only the `organizations` parent is stubbed.
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		INSERT INTO organizations (id) VALUES ('org-1');
	`);
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osBlueprints,
			osBlueprintRevisions,
		),
	);
	return { db: createDbQueryClient(createD1Facade(sqlite)), sqlite };
}

function params(gadgetCount: number) {
	const now = "2026-08-13T17:00:00.000Z";
	const base = {
		organizationId: "org-1",
		createdByKind: "user" as const,
		createdById: "u-1",
		createdAt: now,
	};
	const gadgets = [];
	const revisions = [];
	for (let index = 0; index < gadgetCount; index++) {
		const gadgetId = `gd-${index}`;
		const revisionId = `rev-${index}`;
		gadgets.push({
			...base,
			id: gadgetId,
			workspaceId: "ws-1",
			name: `Gadget ${index}`,
			currentRevisionId: revisionId,
			sourceBlueprintRevisionId: "bprev-1",
			updatedAt: now,
		});
		revisions.push({
			...base,
			id: revisionId,
			gadgetId,
			revision: 1,
			manifest: '{"entry":"main.ts","capabilities":[]}',
		});
	}
	return {
		workspace: {
			...base,
			id: "ws-1",
			name: "Sales Pod",
			sourceBlueprintId: "bp-1",
			sourceBlueprintRevisionId: "bprev-1",
			sourceBlueprintRevisionNumber: 4,
			instantiationPreflight: '{"status":"ready"}',
			updatedAt: now,
		},
		gadgets,
		revisions,
	};
}

/** The gallery-import copy rows, written in the same batch as the workspace. */
function blueprintCopy(name = "Imported Pod") {
	const now = "2026-08-13T17:00:00.000Z";
	return {
		blueprint: {
			id: "bp-copy",
			organizationId: "org-1",
			name,
			description: "Imported from the gallery",
			status: "published" as const,
			visibility: "org" as const,
			currentRevisionId: "bprev-copy",
			createdByKind: "user" as const,
			createdById: "u-1",
			createdAt: now,
			updatedAt: now,
		},
		revision: {
			id: "bprev-copy",
			organizationId: "org-1",
			blueprintId: "bp-copy",
			revision: 1,
			definition: '{"gadgets":[],"requirements":null}',
			createdByKind: "user" as const,
			createdById: "u-1",
			createdAt: now,
			publishedAt: now,
		},
	};
}

describe("os blueprint instantiation", () => {
	it("materializes workspace, gadgets, and revision-1 rows atomically with provenance", async () => {
		const { db } = fixture();
		// 15 gadgets forces multiple chunked statements inside the batch.
		const result = await instantiateOsBlueprint(db, params(15));
		expect(result.workspace).toMatchObject({
			name: "Sales Pod",
			sourceBlueprintId: "bp-1",
			sourceBlueprintRevisionId: "bprev-1",
			sourceBlueprintRevisionNumber: 4,
			instantiationPreflight: '{"status":"ready"}',
		});
		expect(result.gadgets[3]?.sourceBlueprintRevisionId).toBe("bprev-1");
		expect(result.gadgets).toHaveLength(15);
		expect(result.revisions).toHaveLength(15);
		expect(result.gadgets[3]).toMatchObject({
			name: "Gadget 3",
			currentRevisionId: "rev-3",
		});
		expect(result.revisions[3]).toMatchObject({
			gadgetId: "gd-3",
			revision: 1,
		});
	});

	it("supports a gadgetless blueprint", async () => {
		const { db } = fixture();
		const result = await instantiateOsBlueprint(db, params(0));
		expect(result.workspace.name).toBe("Sales Pod");
		expect(result.gadgets).toHaveLength(0);
		expect(result.revisions).toHaveLength(0);
	});

	it("writes a gallery blueprint copy in the same batch as the workspace", async () => {
		const { db, sqlite } = fixture();
		const result = await instantiateOsBlueprint(db, {
			...params(3),
			blueprintCopy: blueprintCopy(),
		});
		expect(result.blueprintCopy?.blueprint).toMatchObject({
			id: "bp-copy",
			status: "published",
			currentRevisionId: "bprev-copy",
		});
		expect(result.blueprintCopy?.revision).toMatchObject({ revision: 1 });
		expect(result.workspace.name).toBe("Sales Pod");
		expect(result.gadgets).toHaveLength(3);
		expect(
			(
				sqlite.prepare("SELECT count(*) AS n FROM os_blueprints").get() as {
					n: number;
				}
			).n,
		).toBe(1);
	});

	it("rolls the blueprint copy back with a lost workspace-name race", async () => {
		const { db, sqlite } = fixture();
		sqlite
			.prepare(
				// Timestamps are named explicitly: the schema's `datetime('now')`
				// default is a SQL default the DDL emitter deliberately does not
				// render, so a fixture row must supply its own.
				`INSERT INTO os_workspaces (id, organization_id, name, created_by_kind, created_by_id, created_at, updated_at)
					VALUES ('ws-existing', 'org-1', 'Sales Pod', 'user', 'u-0', '2026-08-13T16:00:00.000Z', '2026-08-13T16:00:00.000Z')`,
			)
			.run();
		await expect(
			instantiateOsBlueprint(db, {
				...params(3),
				blueprintCopy: blueprintCopy(),
			}),
		).rejects.toThrow(/unique/i);
		// The copy is the first statement in the batch; D1 rolls the batch back as
		// a unit, so it cannot survive the workspace insert that failed after it.
		for (const table of [
			"os_blueprints",
			"os_blueprint_revisions",
			"os_gadgets",
		]) {
			expect(
				(
					sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
						n: number;
					}
				).n,
			).toBe(0);
		}
	});

	it("rolls the whole batch back when the workspace name is taken", async () => {
		const { db, sqlite } = fixture();
		sqlite
			.prepare(
				// Timestamps are named explicitly: the schema's `datetime('now')`
				// default is a SQL default the DDL emitter deliberately does not
				// render, so a fixture row must supply its own.
				`INSERT INTO os_workspaces (id, organization_id, name, created_by_kind, created_by_id, created_at, updated_at)
					VALUES ('ws-existing', 'org-1', 'Sales Pod', 'user', 'u-0', '2026-08-13T16:00:00.000Z', '2026-08-13T16:00:00.000Z')`,
			)
			.run();
		await expect(instantiateOsBlueprint(db, params(3))).rejects.toThrow(
			/unique/i,
		);
		const gadgetCount = sqlite
			.prepare("SELECT count(*) AS n FROM os_gadgets")
			.get() as { n: number };
		expect(gadgetCount.n).toBe(0);
	});
});
