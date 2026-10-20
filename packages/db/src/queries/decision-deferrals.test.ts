import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	decisionExposures,
	decisionOutcomeLabels,
	learningInteractionEvents,
} from "../schema/learning-feedback";
import { schemaDdl } from "../test/schema-ddl";
import { createD1Facade } from "../test/d1-facade";
import {
	insertDecisionOutcomeLabel,
	listUnlabelledDecisionDeferrals,
} from "./decision-learning";

it("matches deferrals by tenant, recipient, time and unlabelled receipt without multiplying feedback scans", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			decisionExposures,
			decisionOutcomeLabels,
			learningInteractionEvents,
		),
	);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	const now = "2026-10-20T12:00:00.000Z";
	const earlier = "2026-10-20T10:00:00.000Z";
	const expiry = "2026-11-20T12:00:00.000Z";
	const exposure = sqlite.prepare(`INSERT INTO decision_exposures
		(id, organization_id, actor_id, card_id, session_id, class_id, snapshot, context, occurred_at, expires_at)
		VALUES (?, ?, ?, ?, 'session', 'review', '{}', '{}', ?, ?)`);
	const event = sqlite.prepare(`INSERT INTO learning_interaction_events
		(id, organization_id, actor_type, actor_id, client_event_id, event_kind, scope_kind, scope_id, surface, target_id, metadata, occurred_at, created_at)
		VALUES (?, ?, 'user', ?, ?, 'rejected', ?, ?, ?, ?, ?, ?, ?)`);
	for (let i = 0; i < 400; i++)
		exposure.run(
			`noise-exposure-${i}`,
			"org-lighthouse",
			"river",
			`noise-card-${i}`,
			earlier,
			expiry,
		);
	for (let i = 0; i < 4000; i++)
		event.run(
			`noise-${i}`,
			"org-lighthouse",
			"river",
			`noise-${i}`,
			"personal",
			"river",
			"other_surface",
			"card",
			'{"decisionChoice":"later"}',
			now,
			now,
		);
	exposure.run("old", "org-lighthouse", "river", "card", earlier, expiry);
	exposure.run(
		"latest",
		"org-lighthouse",
		"river",
		"card",
		"2026-10-20T11:00:00.000Z",
		expiry,
	);
	exposure.run("other-tenant", "org-harbor", "river", "card", earlier, expiry);
	exposure.run(
		"other-person",
		"org-lighthouse",
		"lake",
		"card",
		earlier,
		expiry,
	);
	exposure.run("future", "org-lighthouse", "river", "card", expiry, expiry);
	exposure.run(
		"expired",
		"org-lighthouse",
		"river",
		"expired",
		earlier,
		earlier,
	);
	event.run(
		"later",
		"org-lighthouse",
		"river",
		"later",
		"personal",
		"river",
		"decision_deck",
		"card",
		'{"decisionChoice":"later"}',
		now,
		now,
	);
	event.run(
		"expired",
		"org-lighthouse",
		"river",
		"expired",
		"personal",
		"river",
		"decision_deck",
		"expired",
		'{"decisionChoice":"later"}',
		now,
		now,
	);
	event.run(
		"wrong-scope",
		"org-lighthouse",
		"river",
		"wrong-scope",
		"personal",
		"lake",
		"decision_deck",
		"card",
		'{"decisionChoice":"later"}',
		now,
		now,
	);
	event.run(
		"approve",
		"org-lighthouse",
		"river",
		"approve",
		"personal",
		"river",
		"decision_deck",
		"card",
		'{"decisionChoice":"approve"}',
		now,
		now,
	);

	let query = "";
	const db = createDbClient(
		createD1Facade(sqlite, {
			onPrepare: (sql) => {
				query = sql;
			},
		}),
	);
	const rows = await listUnlabelledDecisionDeferrals(db, now);
	expect(rows.map((row) => [row.eventId, row.exposureId])).toEqual([
		["later", "latest"],
		["later", "old"],
	]);
	const plan = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all("personal", "decision_deck", now, 50)
		.map((row) => String(row.detail));
	// An exposure-first plan scans the same personal feedback once per exposure.
	expect(plan[0]).toContain("SCAN learning_interaction_events");
	expect(
		plan.some((line) =>
			line.includes(
				"SEARCH decision_exposures USING INDEX idx_decision_exposure_org_actor_card",
			),
		),
	).toBe(true);
	expect(plan.some((line) => line.includes("idx_learning_event_scope"))).toBe(
		false,
	);
	expect(
		(await listUnlabelledDecisionDeferrals(db, now, 1)).map(
			(row) => row.exposureId,
		),
	).toEqual(["latest"]);

	await insertDecisionOutcomeLabel(db, {
		id: "org-lighthouse:later:immediate",
		organizationId: "org-lighthouse",
		actorId: "river",
		cardId: "card",
		classId: "review",
		window: "immediate",
		outcome: {
			label: "later",
			evidenceSource: "browser_report",
			exposureId: "latest",
			receiptId: "later",
			decidedAt: now,
			reason: null,
			laterToDecisionMs: null,
		},
		observedAt: now,
		dueAt: now,
		expiresAt: expiry,
	});
	expect(await listUnlabelledDecisionDeferrals(db, now)).toEqual([]);
	sqlite.close();
});
