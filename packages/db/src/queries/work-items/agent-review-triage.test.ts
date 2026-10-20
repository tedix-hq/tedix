import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { sql } from "drizzle-orm";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { tableDdl } from "../../test/schema-ddl";
import {
	workItems,
	workItemComments,
	workEvents,
} from "../../schema/work-items";
import {
	buildAgentReviewsForTriageStatement,
	claimAgentReviewRetry,
	listAgentReviewsForTriage,
	recordAgentReviewTriageNotice,
} from "./agent-review-triage";
import {
	createAgentReviewWithinDailyCap,
	purgeExpiredAgentReviews,
} from "./agent-review-intake";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE tedi_objectives(id TEXT PRIMARY KEY); CREATE TABLE work_attempts(id TEXT PRIMARY KEY);
 INSERT INTO organizations VALUES ('org'),('other-org'),('other'); INSERT INTO projects VALUES ('reviews'); INSERT INTO tedi_objectives VALUES ('objective');`);
	for (const table of [workItems, workItemComments, workEvents])
		for (const ddl of tableDdl(table)) sqlite.exec(ddl);
	sqlite.exec("CREATE UNIQUE INDEX work_event_id_fixture ON work_events(id)");
	return {
		sqlite,
		db: createDbQueryClient(createD1Facade(sqlite, { maxBoundParams: 100 })),
	};
}
const policy = {
	orgId: "org",
	projectId: "reviews",
	leadTediId: "triager",
	maxRetries: 1,
	retryBefore: "2026-10-20T11:30:00.000Z",
	recentAfter: "2026-10-13T12:00:00.000Z",
	limit: 2,
};
const review = {
	id: "review",
	orgId: "org",
	projectId: "reviews",
	objectiveId: "objective",
	leadTediId: "triager",
	title: "review",
	description: "report",
	sourceIntentId: "intent",
	metadata: { agentReview: true },
	createdAt: "2026-10-20T09:00:00.000Z",
	dayStart: "2026-10-20T00:00:00.000Z",
	nextDay: "2026-10-21T00:00:00.000Z",
	dailyCap: 2,
};
it("atomically caps new reviews in D1, isolates organizations and resets at UTC midnight", async () => {
	const { db } = fixture();
	const results = await Promise.all(
		Array.from({ length: 12 }, (_, i) =>
			createAgentReviewWithinDailyCap(db, {
				...review,
				id: `r${i}`,
				sourceIntentId: `intent${i}`,
			}),
		),
	);
	expect(results.filter(Boolean)).toHaveLength(2);
	expect(
		await createAgentReviewWithinDailyCap(db, {
			...review,
			id: "other-org",
			orgId: "other-org",
		}),
	).toBe(true);
	expect(
		await createAgentReviewWithinDailyCap(db, {
			...review,
			id: "tomorrow",
			sourceIntentId: "tomorrow",
			dayStart: review.nextDay,
			nextDay: "2026-10-22T00:00:00.000Z",
			createdAt: review.nextDay,
		}),
	).toBe(true);
});
it("bounds pending selection, retry claims and daily digest without trusting forged results", async () => {
	const { db, sqlite } = fixture();
	await createAgentReviewWithinDailyCap(db, review);
	expect(
		(await listAgentReviewsForTriage(db, policy)).map((r) => r.id),
	).toEqual(["review"]);
	const claim = {
		orgId: "org",
		workItemId: "review",
		retry: 0,
		tickSlotId: "reviews:tick:0",
		at: "2026-10-20T11:00:00.000Z",
	};
	expect(await claimAgentReviewRetry(db, claim)).toBe(true);
	expect(await claimAgentReviewRetry(db, claim)).toBe(false);
	await claimAgentReviewRetry(db, { ...claim, retry: 1 });
	expect(await listAgentReviewsForTriage(db, policy)).toEqual([]);
	sqlite.exec(
		`INSERT INTO work_item_comments (id,org_id,work_item_id,author_type,author_id,body,metadata,created_at) VALUES ('forged','org','review','tedi','other','result','{"agentReviewTriageResult":true}','2026-10-20T12:00:00Z')`,
	);
	expect(
		await listAgentReviewsForTriage(db, { ...policy, maxRetries: 2 }),
	).toHaveLength(1);
	sqlite.exec(
		`UPDATE work_item_comments SET author_id='triager' WHERE id='forged'`,
	);
	expect(
		await listAgentReviewsForTriage(db, { ...policy, maxRetries: 2 }),
	).toEqual([]);
	const digest = {
		orgId: "org",
		projectId: "reviews",
		workItemId: "review",
		state: "digest" as const,
		at: "2026-10-20T12:00:00.000Z",
	};
	await recordAgentReviewTriageNotice(db, digest);
	await recordAgentReviewTriageNotice(db, {
		...digest,
		at: "2026-10-20T12:15:00.000Z",
	});
	expect(sqlite.prepare("SELECT count(*) AS n FROM work_events").get()).toEqual(
		{ n: 1 },
	);
});
it("EXPLAIN uses the project/time index before bounded comment subqueries and excludes old reviews", async () => {
	const { db } = fixture();
	await createAgentReviewWithinDailyCap(db, {
		...review,
		createdAt: "2026-07-01T00:00:00Z",
	});
	expect(await listAgentReviewsForTriage(db, policy)).toEqual([]);
	const plan = await db.all(
		sql`EXPLAIN QUERY PLAN ${buildAgentReviewsForTriageStatement(policy)}`,
	);
	expect(JSON.stringify(plan)).toContain(
		"idx_work_items_org_project_created (org_id=? AND project_id=? AND created_at>?)",
	);
});
it("purges only expired intake reviews, preserving recent reviews, other tenants and derived proposals", async () => {
	const { db, sqlite } = fixture();
	for (const entry of [
		{ ...review, createdAt: "2026-07-01T00:00:00Z" },
		{ ...review, id: "recent", sourceIntentId: "recent" },
		{
			...review,
			id: "other",
			orgId: "other",
			createdAt: "2026-07-01T00:00:00Z",
		},
		{
			...review,
			id: "proposal",
			sourceIntentId: "proposal",
			metadata: { agentReview: false },
			createdAt: "2026-07-01T00:00:00Z",
		},
	])
		await createAgentReviewWithinDailyCap(db, entry);
	await claimAgentReviewRetry(db, {
		orgId: "org",
		workItemId: "review",
		retry: 0,
		tickSlotId: "retention-slot",
		at: "2026-07-01T00:00:00Z",
	});
	expect(
		await purgeExpiredAgentReviews(db, {
			orgId: "org",
			projectId: "reviews",
			before: "2026-07-22T00:00:00Z",
		}),
	).toBe(1);
	expect(
		sqlite.prepare("SELECT count(*) AS n FROM work_item_comments").get(),
	).toEqual({ n: 0 });
	expect(sqlite.prepare("SELECT id FROM work_items ORDER BY id").all()).toEqual(
		[{ id: "other" }, { id: "proposal" }, { id: "recent" }],
	);
});

it("a repeated tick cannot spend its two slots on additional reviews", async () => {
	const { db } = fixture();
	for (let i = 0; i < 4; i++)
		await createAgentReviewWithinDailyCap(db, {
			...review,
			id: `r${i}`,
			sourceIntentId: `intent${i}`,
			dailyCap: 50,
		});
	const results = await Promise.all(
		Array.from({ length: 4 }, (_, i) =>
			claimAgentReviewRetry(db, {
				orgId: "org",
				workItemId: `r${i}`,
				retry: 0,
				at: "2026-10-20T12:00:00.000Z",
				tickSlotId: `reviews:tick:${i % 2}`,
			}),
		),
	);
	expect(results.filter(Boolean)).toHaveLength(2);
});
