import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	listUnlabelledDecisionApprovals,
	listUnlabelledDecisionResponses,
} from "./decision-learning";

const now = "2026-11-16T12:00:00.000Z";
const from = "2026-11-16T11:00:00.000Z";

/** One plan per statement that reads exposures, in the order they ran. */
function fixture(productionLikeStatistics: boolean) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	// Cardinalities of the size that selected the production nested scans
	// (see decision-approvals.test.ts), with receipt tables far larger than
	// the exposure table.
	if (productionLikeStatistics)
		sqlite.exec(`ANALYZE;
			INSERT OR REPLACE INTO sqlite_stat1(tbl,idx,stat) VALUES
				('decision_exposures','idx_decision_exposure_expiry','5000 1'),
				('decision_exposures','idx_decision_exposure_org_actor_card','5000 558 558 5'),
				('decision_exposures','uniq_decision_exposure_org_actor_event','5000 558 558 1'),
				('tedi_approval_requests','idx_approval_requests_status','18000 74 55'),
				('tedi_approval_requests','idx_approval_requests_resolved','18000 2'),
				('work_approval_decisions','idx_work_approval_decisions_time','6000 1'),
				('work_approval_decisions','uniq_work_approval_decision_proposal','6000 1'),
				('work_interaction_responses','idx_work_interaction_responses_time','40000 1'),
				('work_interaction_responses','idx_work_interaction_responses_cursor','40000 400 2 1 1');
			ANALYZE sqlite_schema;`);
	const plans: string[][] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes('"decision_exposures"'))
					plans.push(
						sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail)),
					);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}) as never,
	);
	return { db, plans };
}

const EXPOSURE_SEEK =
	"SEARCH decision_exposures USING INDEX idx_decision_exposure_org_actor_card (organization_id=? AND actor_id=? AND card_id=?)";

const LABEL_SEEK =
	"SEARCH l USING INDEX sqlite_autoindex_decision_outcome_labels_1 (id=?)";
/** Plan lines that read a table; a Bloom filter line only prunes the seek after it. */
const readsTable = (line: string) => /^(SEARCH|SCAN) /.test(line);

describe.each([
	{ statistics: "no statistics", productionLike: false },
	{ statistics: "production-like statistics", productionLike: true },
])("decision label receipt scans with $statistics", ({ productionLike }) => {
	it("reads only responses from the checkpoint on, then seeks their exposures", async () => {
		const { db, plans } = fixture(productionLike);
		await listUnlabelledDecisionResponses(db as never, now, 50, from);
		expect(plans).toHaveLength(1);
		const [plan] = plans as [string[]];
		expect(plan.filter(readsTable)).toEqual([
			"SEARCH work_interaction_responses USING INDEX idx_work_interaction_responses_time (responded_at>?)",
			EXPOSURE_SEEK,
			LABEL_SEEK,
		]);
		expect(plan.join("\n")).not.toMatch(/SCAN (?!CONSTANT)/);
		expect(plan.join("\n")).not.toContain("idx_decision_exposure_expiry");
	});

	it("reads only approval decisions from the checkpoint on, then seeks their exposures", async () => {
		const { db, plans } = fixture(productionLike);
		await listUnlabelledDecisionApprovals(db as never, now, 50, from);
		expect(plans).toHaveLength(2);
		const [work, tedi] = plans as [string[], string[]];
		expect(work.filter(readsTable)).toEqual([
			"SEARCH work_approval_decisions USING INDEX idx_work_approval_decisions_time (decided_at>?)",
			"SEARCH work_approval_proposals USING INDEX sqlite_autoindex_work_approval_proposals_1 (id=?)",
			EXPOSURE_SEEK,
			LABEL_SEEK,
		]);
		expect(tedi.filter(readsTable)).toEqual([
			"SEARCH tedi_approval_requests USING INDEX idx_approval_requests_resolved (resolved_at>?)",
			EXPOSURE_SEEK,
			LABEL_SEEK,
		]);
		for (const plan of [work, tedi]) {
			expect(plan.join("\n")).not.toMatch(/SCAN (?!CONSTANT)/);
			expect(plan.join("\n")).not.toContain("TEMP B-TREE");
		}
	});

	it("keeps the daily sweep's loop order: each receipt seeks its exposures", async () => {
		const { db, plans } = fixture(productionLike);
		await listUnlabelledDecisionApprovals(db as never, now);
		const [work, tedi] = plans as [string[], string[]];
		expect(work.filter(readsTable)).toEqual([
			"SCAN work_approval_decisions USING INDEX idx_work_approval_decisions_time",
			"SEARCH work_approval_proposals USING INDEX sqlite_autoindex_work_approval_proposals_1 (id=?)",
			EXPOSURE_SEEK,
			LABEL_SEEK,
		]);
		expect(tedi.filter(readsTable)).toEqual([
			"SCAN tedi_approval_requests USING INDEX idx_approval_requests_resolved",
			EXPOSURE_SEEK,
			LABEL_SEEK,
		]);
	});
});
