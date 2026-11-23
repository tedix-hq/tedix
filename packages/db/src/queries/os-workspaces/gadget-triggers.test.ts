import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	osGadgets,
	osGadgetRevisions,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { createOsGadgetRevision, listTriggeredRuntimeApps } from "./gadgets";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			{ foreignKeys: false },
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
		),
	);
	sqlite.exec(`INSERT INTO os_workspaces (id, organization_id, name, created_by_kind, created_by_id, created_at, updated_at)
		VALUES ('ws', 'org', 'Apps', 'user', 'ada', '2026-11-23', '2026-11-23'),
		('ws-other', 'other', 'Apps', 'user', 'grace', '2026-11-23', '2026-11-23'),
		('ws-archived', 'org', 'Old apps', 'user', 'ada', '2026-11-23', '2026-11-23');`);
	const queries: string[] = [];
	const db = createDbQueryClient(
		createD1Facade(sqlite, {
			onPrepare: (query) => {
				queries.push(query);
			},
		}),
	);
	return { sqlite, db, queries };
}

function seed(
	sqlite: DatabaseSync,
	id: string,
	manifest: string,
	flag: boolean,
	workspace = "ws",
	organization = "org",
) {
	sqlite
		.prepare(`INSERT INTO os_gadgets
		(id, organization_id, workspace_id, name, current_revision_id, has_runtime_triggers, created_by_kind, created_by_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, 'user', 'ada', '2026-11-23', '2026-11-23')`)
		.run(id, organization, workspace, id, `${id}-r1`, flag ? 1 : 0);
	sqlite
		.prepare(`INSERT INTO os_gadget_revisions
		(id, organization_id, gadget_id, revision, manifest, created_by_kind, created_by_id, created_at)
		VALUES (?, ?, ?, 1, ?, 'user', 'ada', '2026-11-23')`)
		.run(`${id}-r1`, organization, id, manifest);
}

const TRIGGERED = '{"entry":"tedix:runtime/v1","config":{"triggers":[]}}';

describe("runtime trigger candidates", () => {
	it.each([false, true])(
		"seeks trigger apps without scanning unrelated apps or revisions (analysed=%s)",
		async (analysed) => {
			const { sqlite, db, queries } = fixture();
			try {
				for (let i = 0; i < 6000; i++) seed(sqlite, `plain-${i}`, "{}", false);
				seed(sqlite, "trigger-a", TRIGGERED, true);
				seed(sqlite, "trigger-b", TRIGGERED, true, "ws-other", "other");
				seed(sqlite, "archived", TRIGGERED, true);
				seed(sqlite, "hidden", TRIGGERED, true, "ws-archived");
				sqlite.exec(`UPDATE os_gadgets SET status = 'archived' WHERE id = 'archived';
				UPDATE os_workspaces SET status = 'archived' WHERE id = 'ws-archived';`);
				if (analysed) sqlite.exec("ANALYZE");
				expect(
					(await listTriggeredRuntimeApps(db, { limit: 500 })).map(
						({ gadget }) => gadget.id,
					),
				).toEqual(["trigger-a", "trigger-b"]);
				const query = queries.at(-1)!;
				const plan = sqlite
					.prepare(`EXPLAIN QUERY PLAN ${query}`)
					.all("active", "active", 1, 500)
					.map((row) => row.detail)
					.join("\n");
				expect(plan).toContain(
					"SEARCH os_gadgets USING INDEX os_gadgets_triggers_status_created_idx (has_runtime_triggers=? AND status=?)",
				);
				expect(plan).toContain(
					"SEARCH os_gadget_revisions USING INDEX sqlite_autoindex_os_gadget_revisions_1 (id=?)",
				);
				expect(plan).toContain(
					"SEARCH os_workspaces USING INDEX os_workspaces_org_id_unique (organization_id=? AND id=?)",
				);
				expect(plan).not.toMatch(/SCAN |TEMP B-TREE/);
				expect(query).not.toMatch(/json_extract|json_type/);
			} finally {
				sqlite.close();
			}
		},
	);

	it("moves trigger membership with the current revision and leaves it intact on a stale save", async () => {
		const { sqlite, db } = fixture();
		try {
			seed(sqlite, "app", "{}", false);
			const revision = {
				organizationId: "org",
				gadgetId: "app",
				createdByKind: "user" as const,
				createdById: "ada",
			};
			expect(
				await createOsGadgetRevision(db, {
					...revision,
					id: "r2",
					expectedRevision: 1,
					manifest: TRIGGERED,
				}),
			).toMatchObject({ ok: true });
			expect(await listTriggeredRuntimeApps(db, { limit: 500 })).toHaveLength(
				1,
			);
			expect(
				await createOsGadgetRevision(db, {
					...revision,
					id: "stale",
					expectedRevision: 1,
					manifest: "{}",
				}),
			).toMatchObject({ ok: false });
			expect(await listTriggeredRuntimeApps(db, { limit: 500 })).toHaveLength(
				1,
			);
			expect(
				await createOsGadgetRevision(db, {
					...revision,
					id: "r3",
					expectedRevision: 2,
					manifest: "{}",
				}),
			).toMatchObject({ ok: true });
			expect(await listTriggeredRuntimeApps(db, { limit: 500 })).toHaveLength(
				0,
			);
		} finally {
			sqlite.close();
		}
	});

	it("backfills only current runtime trigger arrays in the same organization and app", () => {
		const { sqlite } = fixture();
		try {
			seed(sqlite, "trigger", TRIGGERED, false);
			seed(sqlite, "plain", "{}", false);
			seed(
				sqlite,
				"wrong-entry",
				'{"entry":"other","config":{"triggers":[]}}',
				false,
			);
			seed(
				sqlite,
				"wrong-type",
				'{"entry":"tedix:runtime/v1","config":{"triggers":{}}}',
				false,
			);
			seed(sqlite, "old", TRIGGERED, false);
			sqlite.exec(
				`UPDATE os_gadgets SET current_revision_id = 'plain-r1' WHERE id = 'old';`,
			);
			sqlite.exec(
				"DROP INDEX os_gadgets_triggers_status_created_idx; ALTER TABLE os_gadgets DROP COLUMN has_runtime_triggers;",
			);
			sqlite.exec(
				readFileSync(
					new URL(
						"../../../drizzle/20261123150711_app-trigger-seek/migration.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			expect(
				sqlite
					.prepare("SELECT id FROM os_gadgets WHERE has_runtime_triggers = 1")
					.all(),
			).toEqual([{ id: "trigger" }]);
		} finally {
			sqlite.close();
		}
	});
});
