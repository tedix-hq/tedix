import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { getWorkspaceOutputIndexRevision } from "./read";

it("finds one output revision by seeking its organization and revision id", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const insert = sqlite.prepare(`INSERT INTO workspace_output_index
		(id, organization_id, workspace_id, output_id, revision, revision_id, is_current, output_kind, title, status,
		 output_created_by_kind, output_created_by_id, output_created_at,
		 revision_created_by_kind, revision_created_by_id, revision_created_at, updated_at)
		VALUES (?, ?, 'workspace-example', ?, ?, ?, ?, 'document', 'Example', 'active',
		 'user', 'ada', '2026-11-01T00:00:00.000Z', 'user', 'ada', ?, ?)`);
	// One organization's revision history dwarfs the single row asked for.
	for (let i = 0; i < 400; i++) {
		const at = `2026-11-02T00:${String(i % 60).padStart(2, "0")}:00.000Z`;
		insert.run(
			`output-a:${i}`,
			"org-example",
			"output-a",
			i,
			`revision-${i}`,
			i === 399 ? 1 : 0,
			at,
			at,
		);
	}
	insert.run(
		"output-b:1",
		"org-other",
		"output-b",
		1,
		"revision-foreign",
		1,
		"2026-11-03T00:00:00.000Z",
		"2026-11-03T00:00:00.000Z",
	);
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes('"workspace_output_index"'))
					plans.push(
						...sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail)),
					);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);

	const found = await getWorkspaceOutputIndexRevision(db, {
		organizationId: "org-example",
		revisionId: "revision-7",
	});
	expect(found).toMatchObject({
		id: "output-a:7",
		outputId: "output-a",
		revision: 7,
	});
	// Another organization's revision id is not readable from this one.
	expect(
		await getWorkspaceOutputIndexRevision(db, {
			organizationId: "org-example",
			revisionId: "revision-foreign",
		}),
	).toBeUndefined();
	expect(plans).toEqual([
		"SEARCH workspace_output_index USING INDEX workspace_output_index_org_revision_idx (organization_id=? AND revision_id=?)",
		"SEARCH workspace_output_index USING INDEX workspace_output_index_org_revision_idx (organization_id=? AND revision_id=?)",
	]);
});
