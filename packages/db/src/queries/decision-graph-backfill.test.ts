import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { planDecisionGraphBackfillPage } from "./decision-graph-backfill";

it("pages evidence against current indexed output identities without multiplying revisions", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
	CREATE TABLE work_items(id TEXT, org_id TEXT);
	CREATE TABLE work_evidence(id TEXT, org_id TEXT, work_item_id TEXT, uri TEXT, submitted_at TEXT);
	CREATE TABLE workspace_output_index(output_id TEXT, organization_id TEXT, is_current INTEGER);
	INSERT INTO work_items VALUES ('work','org'),('target','org');
	INSERT INTO workspace_output_index VALUES ('output','org',0),('output','org',1),('foreign','other',1);
	INSERT INTO work_evidence VALUES
	('a','org','work','output://output/revision','2026-10-10T10:00:00.000Z'),
	('b','org','work','output://output','2026-10-10T10:00:00.000Z'),
	('c','org','work','output://foreign','2026-10-10T10:00:00.000Z'),
	('d','org','work','work://target','2026-10-10T10:00:00.000Z'),
	('e','other','work','output://output','2026-10-10T10:00:00.000Z');
	`);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const first = await planDecisionGraphBackfillPage(db, "org", {
		cursor: { organizationId: "org", phase: "evidence", afterId: "" },
		limit: 1,
	});
	expect(first.scanned).toBe(1);
	expect(first.edges).toMatchObject([
		{
			from: { id: "work" },
			to: { kind: "output", id: "output" },
			evidenceRef: "evidence:a",
		},
	]);
	expect(first.nextCursor).toEqual({
		organizationId: "org",
		phase: "evidence",
		afterId: "a",
	});
	const rest = await planDecisionGraphBackfillPage(db, "org", {
		cursor: first.nextCursor,
	});
	expect(rest.scanned).toBe(2);
	expect(
		rest.edges.map((edge) => [edge.evidenceRef, edge.to.kind, edge.to.id]),
	).toEqual([
		["evidence:b", "output", "output"],
		["evidence:d", "work_item", "target"],
	]);
	expect(rest.nextCursor).toBeNull();
	sqlite.close();
});
