import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	claimAgentReviewRetry,
	listAgentReviewsForTriage,
	recordAgentReviewTriageNotice,
} from "./agent-review-triage";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE work_items (id TEXT PRIMARY KEY, org_id TEXT, project_id TEXT, metadata TEXT, created_at TEXT);
		CREATE TABLE work_item_comments (id TEXT PRIMARY KEY, org_id TEXT, work_item_id TEXT, author_type TEXT, author_id TEXT, body TEXT, metadata TEXT, created_at TEXT);
		CREATE TABLE work_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, org_id TEXT, work_item_id TEXT, attempt_id TEXT, event_type TEXT, actor_type TEXT, actor_id TEXT, actor_session_id TEXT, payload TEXT, occurred_at TEXT);
		INSERT INTO work_items VALUES ('review','org','reviews','{"agentReview":true}','2026-10-20T09:00:00.000Z'), ('other','other-org','reviews','{"agentReview":true}','2026-10-20T09:00:00.000Z'), ('proposal','org','reviews','{}','2026-10-20T09:00:00.000Z');
		INSERT INTO work_item_comments VALUES ('wake','org','review','system',NULL,'Review triage queued','{"agentReviewWake":true}','2026-10-20T09:00:00.000Z');
	`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}
const policy = {
	orgId: "org",
	projectId: "reviews",
	leadTediId: "triager",
	maxRetries: 2,
	retryBefore: "2026-10-20T11:30:00.000Z",
	lateBefore: "2026-10-20T10:00:00.000Z",
};
it("selects queued reviews with tenant scope, atomically bounds retry claims and deduplicates Feed notices", async () => {
	const { db, sqlite } = fixture();
	expect(
		(await listAgentReviewsForTriage(db, policy)).map((r) => r.id),
	).toEqual(["review"]);
	const retry = {
		orgId: "org",
		workItemId: "review",
		retry: 1,
		at: "2026-10-20T11:00:00.000Z",
	};
	expect(await claimAgentReviewRetry(db, retry)).toBe(true);
	expect(await claimAgentReviewRetry(db, retry)).toBe(false);
	await claimAgentReviewRetry(db, { ...retry, retry: 2 });
	const late = {
		orgId: "org",
		workItemId: "review",
		state: "late" as const,
		at: "2026-10-20T12:00:00.000Z",
	};
	await recordAgentReviewTriageNotice(db, late);
	await recordAgentReviewTriageNotice(db, late);
	expect(sqlite.prepare("SELECT count(*) AS n FROM work_events").get()).toEqual(
		{ n: 1 },
	);
	expect(await listAgentReviewsForTriage(db, policy)).toEqual([]);
	// A forged result from another worker cannot turn a failed retry into completion.
	sqlite.exec(
		`INSERT INTO work_item_comments VALUES ('result','org','review','tedi','other-worker','Saved suggestions','{"agentReviewTriageResult":true}','2026-10-20T12:01:00.000Z')`,
	);
	expect(await listAgentReviewsForTriage(db, policy)).toEqual([]);
	sqlite.exec(
		"UPDATE work_item_comments SET author_id = 'triager' WHERE id = 'result'",
	);
	expect(
		(await listAgentReviewsForTriage(db, policy))[0]?.complete,
	).toBeTruthy();
	await recordAgentReviewTriageNotice(db, { ...late, state: "completed" });
	expect(await listAgentReviewsForTriage(db, policy)).toEqual([]);
});
it("waits N minutes between retries while still surfacing late reviews", async () => {
	const { db } = fixture();
	await claimAgentReviewRetry(db, {
		orgId: "org",
		workItemId: "review",
		retry: 1,
		at: "2026-10-20T11:59:00.000Z",
	});
	await recordAgentReviewTriageNotice(db, {
		orgId: "org",
		workItemId: "review",
		state: "late",
		at: "2026-10-20T12:00:00.000Z",
	});
	expect(await listAgentReviewsForTriage(db, policy)).toEqual([]);
	expect(
		await listAgentReviewsForTriage(db, {
			...policy,
			retryBefore: "2026-10-20T12:00:00.000Z",
		}),
	).toHaveLength(1);
});
