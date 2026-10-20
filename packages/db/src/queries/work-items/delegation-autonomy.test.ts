import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { listWorkActivity } from "./activity";
import { WorkFactoryProjectionCursorSchema } from "@tedix/api-contract/schemas/work-items";
import { workEvents } from "../../schema/work-items";
import {
	readDelegationAutonomyLessons,
	readDelegationFyi,
	recordDelegationAutonomyFeedback,
	recordDelegationFyi,
} from "./delegation-autonomy";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`CREATE TABLE work_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, disposition TEXT NOT NULL, project_id TEXT, objective_id TEXT, work_kind TEXT NOT NULL);
	CREATE TABLE work_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, attempt_id TEXT, event_type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, actor_session_id TEXT, payload TEXT NOT NULL, occurred_at TEXT NOT NULL);
	INSERT INTO work_items VALUES ('research','org','Research','accepted','project',NULL,'coding');`);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}
const input = {
	orgId: "org",
	workItemId: "research",
	at: "2026-10-19T12:00:00.000Z",
	fyi: {
		classId: "delegation:multi_hop_read",
		homeRunId: "home",
		childRunId: "child",
		tediId: "tedi",
		tediName: "Researcher",
		task: "Review the paper",
		outcome: "queued",
	},
};
describe("delegation FYI and correction lessons", () => {
	it("records one receipt per outcome on retries and projects task, tedi, and outcome into Feed", async () => {
		const { db, sqlite } = fixture();
		await Promise.all([
			recordDelegationFyi(db, input),
			recordDelegationFyi(db, input),
		]);
		await recordDelegationFyi(db, {
			...input,
			fyi: { ...input.fyi, outcome: "completed" },
		});
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_events").get()?.n,
		).toBe(2);
		const feed = await listWorkActivity(db, { orgId: "org" });
		expect(feed.events.map((row) => row.delegationFyi?.outcome).sort()).toEqual(
			["completed", "queued"],
		);
		expect(feed.events[0].body).toContain("Researcher");
		expect(feed.events[0].delegationFyi?.task).toBe("Review the paper");
		const page = await listWorkActivity(db, { orgId: "org", limit: 1 });
		expect(
			WorkFactoryProjectionCursorSchema.safeParse(page.nextCursor).success,
		).toBe(true);
		expect(
			(
				await listWorkActivity(db, {
					orgId: "org",
					cursor: page.nextCursor!,
					limit: 1,
				})
			).events,
		).toHaveLength(1);
		expect((await listWorkActivity(db, { orgId: "other" })).events).toEqual([]);
	});
	it("idempotently tightens the exact class from owner feedback and fences cross-tenant or fabricated receipts", async () => {
		const { db, sqlite } = fixture();
		await recordDelegationFyi(db, input);
		const feedback = {
			orgId: "org",
			workItemId: "research",
			eventId: (await listWorkActivity(db, { orgId: "org" })).events[0].id,
			userId: "owner",
			at: input.at,
		};
		await recordDelegationAutonomyFeedback(db, feedback);
		await recordDelegationAutonomyFeedback(db, feedback);
		expect(await readDelegationAutonomyLessons(db, "org")).toEqual([
			"delegation:multi_hop_read",
		]);
		expect(await readDelegationAutonomyLessons(db, "other")).toEqual([]);
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM work_events WHERE event_type='delegation.autonomy.corrected'",
				)
				.get()?.n,
		).toBe(1);
		await expect(
			recordDelegationAutonomyFeedback(db, { ...feedback, orgId: "other" }),
		).rejects.toThrow("not found");
		await expect(
			recordDelegationAutonomyFeedback(db, { ...feedback, eventId: "unknown" }),
		).rejects.toThrow("not found");
	});
	it("does not project or learn from forged FYI metadata on comments or other actors' events", async () => {
		const { db } = fixture();
		for (const [eventType, actorType, actorId] of [
			["comment", "system", "home"],
			["delegation.fyi", "external_agent", "harness"],
			["delegation.fyi", "system", "other"],
		]) {
			const id = crypto.randomUUID();
			await db.insert(workEvents).values({
				id,
				orgId: "org",
				workItemId: "research",
				eventType,
				actorType,
				actorId,
				payload: { summary: "Untrusted metadata", delegationFyi: input.fyi },
				occurredAt: input.at,
			});
			expect(
				await readDelegationFyi(db, {
					orgId: "org",
					workItemId: "research",
					eventId: id,
				}),
			).toBeNull();
			await expect(
				recordDelegationAutonomyFeedback(db, {
					orgId: "org",
					workItemId: "research",
					eventId: id,
					userId: "owner",
					at: input.at,
				}),
			).rejects.toThrow("not found");
		}
		expect(
			(await listWorkActivity(db, { orgId: "org" })).events.every(
				(event) => !event.delegationFyi,
			),
		).toBe(true);
		expect(await readDelegationAutonomyLessons(db, "org")).toEqual([]);
	});
});

it("retains exact policy provenance in the FYI receipt", async () => {
	const { db } = fixture();
	const policyPack = { id: "org-policy", version: 7 };
	await recordDelegationFyi(db, {
		...input,
		fyi: { ...input.fyi, policyPack },
	});
	const receipt = await readDelegationFyi(db, {
		orgId: input.orgId,
		workItemId: input.workItemId,
		childRunId: input.fyi.childRunId,
	});
	expect(receipt?.payload.delegationFyi).toMatchObject({ policyPack });
});
