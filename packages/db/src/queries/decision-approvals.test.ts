import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { tediApprovalRequests } from "../schema/approvals";
import {
	decisionExposures,
	decisionOutcomeLabels,
} from "../schema/learning-feedback";
import {
	workApprovalProposals,
	workApprovalDecisions,
} from "../schema/work-factory";
import { schemaDdl } from "../test/schema-ddl";
import { createD1Facade } from "../test/d1-facade";
import {
	listUnlabelledDecisionApprovals,
	insertDecisionOutcomeLabel,
} from "./decision-learning";

it("looks up exposures by tenant, actor and card for each resolved approval", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			tediApprovalRequests,
			decisionExposures,
			decisionOutcomeLabels,
			workApprovalProposals,
			workApprovalDecisions,
		),
	);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	const now = "2026-10-21T12:00:00.000Z";
	const earlier = "2026-10-21T10:00:00.000Z";
	const expiry = "2026-11-21T12:00:00.000Z";
	const approval = sqlite.prepare(`INSERT INTO tedi_approval_requests
 (id,tedi_id,org_id,action_type,description,payload,status,created_at,expires_at,resolved_at,resolved_by)
 VALUES (?, 'tedi', 'org-lighthouse','review','Review','{}',?, ?, ?, ?, 'river')`);
	const exposure = sqlite.prepare(`INSERT INTO decision_exposures
 (id,organization_id,actor_id,card_id,session_id,class_id,snapshot,context,occurred_at,expires_at)
 VALUES (?, ?, ?, ?, 'session','review','{}','{}',?,?)`);
	for (let i = 0; i < 300; i++) {
		approval.run(`noise-${i}`, "approved", earlier, expiry, now);
		exposure.run(
			`noise-${i}`,
			"org-lighthouse",
			"river",
			`other:${i}`,
			earlier,
			expiry,
		);
	}
	approval.run("target", "approved", earlier, expiry, now);
	approval.run("pending", "pending", earlier, expiry, now);
	exposure.run(
		"match",
		"org-lighthouse",
		"river",
		"approval:target",
		earlier,
		expiry,
	);
	exposure.run(
		"other-tenant",
		"org-harbor",
		"river",
		"approval:target",
		earlier,
		expiry,
	);
	exposure.run(
		"other-actor",
		"org-lighthouse",
		"lake",
		"approval:target",
		earlier,
		expiry,
	);
	exposure.run(
		"future",
		"org-lighthouse",
		"river",
		"approval:target",
		expiry,
		expiry,
	);
	exposure.run(
		"expired",
		"org-lighthouse",
		"river",
		"approval:target",
		earlier,
		earlier,
	);
	exposure.run(
		"pending",
		"org-lighthouse",
		"river",
		"approval:pending",
		earlier,
		expiry,
	);
	// Reproduce the cardinality estimates that selected the production nested scan.
	sqlite.exec(`ANALYZE;
 UPDATE sqlite_stat1 SET stat='928 1' WHERE idx='idx_decision_exposure_expiry';
 UPDATE sqlite_stat1 SET stat='928 558 558 140' WHERE idx='idx_decision_exposure_org_actor_card';
 UPDATE sqlite_stat1 SET stat='1043 74 55' WHERE idx='idx_approval_requests_status';
 UPDATE sqlite_stat1 SET stat='1043 2' WHERE idx='idx_approval_requests_resolved';
 ANALYZE sqlite_schema;`);
	let query = "";
	const db = createDbClient(
		createD1Facade(sqlite, {
			onPrepare: (sql) => {
				query = sql;
			},
		}),
	);
	expect(
		(await listUnlabelledDecisionApprovals(db, now)).map((r) => r.exposureId),
	).toEqual(["match"]);
	const plan = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all("approved", "rejected", now, 50)
		.map((r) => String(r.detail));
	expect(
		plan.some((line) =>
			line.includes(
				"SEARCH decision_exposures USING INDEX idx_decision_exposure_org_actor_card (organization_id=? AND actor_id=? AND card_id=?)",
			),
		),
	).toBe(true);
	expect(
		plan.some((line) => line.includes("idx_decision_exposure_expiry")),
	).toBe(false);
	await insertDecisionOutcomeLabel(db, {
		id: "org-lighthouse:target:immediate",
		organizationId: "org-lighthouse",
		actorId: "river",
		cardId: "approval:target",
		classId: "review",
		window: "immediate",
		outcome: {
			label: "unchanged_approval",
			evidenceSource: "canonical_receipt",
			reason: null,
			exposureId: "match",
			receiptId: "target",
		},
		observedAt: now,
		dueAt: now,
		expiresAt: expiry,
	});
	expect(await listUnlabelledDecisionApprovals(db, now)).toEqual([]);
	sqlite.close();
});
