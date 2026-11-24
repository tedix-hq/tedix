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
	// Approval, exposure and label sqlite_stat1 from production on 24 Nov 2026.
	// These estimates selected a Bloom filter that read every exposure.
	if (productionLikeStatistics)
		sqlite.exec(`ANALYZE;
			INSERT OR REPLACE INTO sqlite_stat1(tbl,idx,stat) VALUES
				('decision_outcome_labels','idx_decision_label_expiry','199 4'),
				('decision_outcome_labels','idx_decision_label_due','199 64 1'),
				('decision_outcome_labels','idx_decision_label_org_class','199 128 128 16 6'),
				('decision_outcome_labels','uniq_decision_label_org_actor_receipt_window','199 128 128 4 2 1'),
				('decision_outcome_labels','sqlite_autoindex_decision_outcome_labels_1','199 1'),
				('decision_exposures','idx_decision_exposure_org_actor_time','13243 88 88 1 1'),
				('decision_exposures','idx_decision_exposure_expiry','13243 1'),
				('decision_exposures','idx_decision_exposure_org_actor_card','13243 88 88 88'),
				('decision_exposures','uniq_decision_exposure_org_actor_event','13243 88 88 1'),
				('decision_exposures','sqlite_autoindex_decision_exposures_1','13243 1'),
				('tedi_approval_requests','idx_approval_requests_org_status_created','204974 31 24 1'),
				('tedi_approval_requests','idx_approval_requests_org_created','204974 31 1'),
				('tedi_approval_requests','idx_approval_requests_delegated_owner','0 0 0 0'),
				('tedi_approval_requests','idx_approval_requests_org_action_work_status','204974 31 14 14 12'),
				('tedi_approval_requests','idx_approval_requests_open_execution','95 95 1'),
				('tedi_approval_requests','idx_approval_requests_unconsumed','204974 3 3 1'),
				('tedi_approval_requests','idx_approval_requests_execution_attention','204974 31 24 15 15 13 1'),
				('tedi_approval_requests','idx_approval_requests_pending_expiry','1 1'),
				('tedi_approval_requests','idx_approval_requests_resolved','204974 2'),
				('tedi_approval_requests','idx_approval_requests_tedi_status','204974 42 31'),
				('tedi_approval_requests','sqlite_autoindex_tedi_approval_requests_1','204974 1'),
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
			"SEARCH decision_exposures USING INTEGER PRIMARY KEY (rowid=?)",
			"SEARCH candidates USING COVERING INDEX idx_decision_exposure_org_actor_card (organization_id=? AND actor_id=? AND card_id=?)",
			LABEL_SEEK,
		]);
		for (const plan of [work, tedi]) {
			expect(plan.join("\n")).not.toMatch(/SCAN (?!CONSTANT)/);
			expect(plan.join("\n")).not.toContain("TEMP B-TREE");
			expect(plan.join("\n")).not.toContain("BLOOM FILTER");
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
			"SEARCH decision_exposures USING INTEGER PRIMARY KEY (rowid=?)",
			"SEARCH candidates USING COVERING INDEX idx_decision_exposure_org_actor_card (organization_id=? AND actor_id=? AND card_id=?)",
			LABEL_SEEK,
		]);
	});
});
