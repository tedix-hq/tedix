import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { supportConfiguration, supportTickets } from "../schema/support";
import { projects } from "../schema/projects";
import { workItems, workEvents, workItemComments } from "../schema/work-items";
import * as support from "./support";
import { hasActivePurposeContext } from "./work-items/purpose";

const now = "2026-10-17T10:00:00.000Z";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			supportConfiguration,
			supportTickets,
			projects,
			workItems,
			workEvents,
			workItemComments,
		),
	);
	const guards = readFileSync(
		new URL(
			"../../drizzle/20260821020828_work_factory_external_session_fences/migration.sql",
			import.meta.url,
		),
		"utf8",
	)
		.split("--> statement-breakpoint")
		.filter((statement) =>
			/CREATE TRIGGER `work_items_admission_revision_/.test(statement),
		);
	for (const guard of guards) sqlite.exec(guard);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}
function ticket() {
	return {
		id: "ticket-a",
		orgId: "tenant-a",
		platformOrgId: "platform",
		reporterKey: "user:alice",
		idempotencyKey: "first-report",
		workItemId: "source-a",
		mirrorWorkItemId: "mirror-a",
		projectId: "project-a",
		report: {
			title: "Cannot connect",
			expected: "Connect",
			actual: "Error",
			steps: "",
			impact: "Blocked",
			page: "/apps",
			lastError: "E_TEST",
			observedAt: now,
			origin: "agent" as const,
			language: "en" as const,
			diagnosticRefs: [],
		},
		consentReference: "user-approved-preview",
		payloadDigest: "digest",
		nextUpdateDue: now,
		createdAt: now,
		updatedAt: now,
	};
}
describe("Support bridge D1 persistence", () => {
	it("preserves one durable source before mirror delivery, scopes reporters, and retries the mirror once", async () => {
		const { db, sqlite } = fixture(),
			input = ticket();
		await support.createSupportTicket(db, input);
		await support.createSupportTicket(db, input);
		expect(await support.getSupportTicket(db, "tenant-b", input.id)).toBeNull();
		expect(
			await support.getSupportTicket(db, input.orgId, input.id, "user:bob"),
		).toBeNull();
		const source = (await support.getSupportTicket(db, input.orgId, input.id))!;
		expect(source.mirrorDelivery).toBe("pending");
		expect(sqlite.prepare("select count(*) n from work_items").get()).toEqual({
			n: 1,
		});
		for (let i = 0; i < 2; i++)
			await support.deliverSupportMirror(db, source, {
				projectId: "platform-project",
				tediId: "support-tedi",
				eventId: "wake-1",
				now,
			});
		expect(sqlite.prepare("select count(*) n from work_items").get()).toEqual({
			n: 2,
		});
		expect(sqlite.prepare("select count(*) n from work_events").get()).toEqual({
			n: 1,
		});
		expect(
			(await support.getStaffSupportTicket(db, "platform", input.id))
				?.mirrorDelivery,
		).toBe("delivered");
		expect(
			await support.getStaffSupportTicket(db, "tenant-b", input.id),
		).toBeNull();
		for (const work of await db.select().from(workItems))
			expect(hasActivePurposeContext(work, now)).toBe(true);
	});
	it("inherits project objectives and atomically repairs the original missing purpose once", async () => {
		const { db, sqlite } = fixture(),
			input = ticket();
		await db.insert(projects).values([
			{
				id: input.projectId,
				orgId: input.orgId,
				key: "SUPPORT",
				name: "Support",
				objectiveId: "tenant-objective",
				createdAt: now,
			},
			{
				id: "platform-project",
				orgId: input.platformOrgId,
				key: "SUPPORT",
				name: "Support",
				objectiveId: "platform-objective",
				createdAt: now,
			},
		]);
		await support.createSupportTicket(db, input);
		const row = (await support.getSupportTicket(db, input.orgId, input.id))!;
		await support.deliverSupportMirror(db, row, {
			projectId: "platform-project",
			tediId: "support-tedi",
			eventId: "wake-1",
			now,
		});
		const expected = [
			{
				id: input.workItemId,
				workClass: "objective",
				objectiveId: "tenant-objective",
				purposeExceptionExpiresAt: null,
			},
			{
				id: input.mirrorWorkItemId,
				workClass: "objective",
				objectiveId: "platform-objective",
				purposeExceptionExpiresAt: null,
			},
		];
		const works = () =>
			db
				.select({
					id: workItems.id,
					workClass: workItems.workClass,
					objectiveId: workItems.objectiveId,
					purposeExceptionExpiresAt: workItems.purposeExceptionExpiresAt,
				})
				.from(workItems);
		expect(await works()).toEqual(expected);
		sqlite.exec(
			"UPDATE work_items SET work_class='maintenance', objective_id=NULL, purpose_exception_expires_at=NULL",
		);
		const repair = {
			sourceEventId: "repair-source",
			mirrorEventId: "repair-mirror",
			now,
		};
		sqlite.exec(
			"CREATE TRIGGER reject_purpose_event BEFORE INSERT ON work_events BEGIN SELECT RAISE(ABORT,'test failure'); END",
		);
		await expect(
			support.repairSupportWorkPurpose(db, row, repair),
		).rejects.toThrow();
		expect(
			(await works()).every((work) => !hasActivePurposeContext(work, now)),
		).toBe(true);
		sqlite.exec("DROP TRIGGER reject_purpose_event");
		await support.repairSupportWorkPurpose(db, row, repair);
		await support.repairSupportWorkPurpose(db, row, repair);
		expect(await works()).toEqual(expected);
		expect(sqlite.prepare("SELECT count(*) n FROM work_events").get()).toEqual({
			n: 3,
		});
		expect(sqlite.prepare("SELECT version FROM work_items").all()).toEqual([
			{ version: 2 },
			{ version: 2 },
		]);
	});
	it("rolls back source creation if ticket persistence fails", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(
			"CREATE TRIGGER reject_ticket BEFORE INSERT ON support_tickets BEGIN SELECT RAISE(ABORT,'test failure'); END;",
		);
		await expect(support.createSupportTicket(db, ticket())).rejects.toThrow();
		expect(sqlite.prepare("select count(*) n from work_items").get()).toEqual({
			n: 0,
		});
	});
	it("CAS rejects a stale answer without stray comments/events, and keeps private drafts out of public history", async () => {
		const { db, sqlite } = fixture();
		await support.createSupportTicket(db, ticket());
		await support.deliverSupportMirror(
			db,
			(await support.getSupportTicket(db, "tenant-a", "ticket-a"))!,
			{
				projectId: "platform-project",
				tediId: "support-tedi",
				eventId: "wake-1",
				now,
			},
		);
		const row = (await support.getSupportTicket(db, "tenant-a", "ticket-a"))!;
		const p = {
			key: "draft-1",
			actorId: "support-tedi",
			actorType: "tedi" as const,
			now,
			patch: {
				draft: {
					body: "Try reconnecting",
					evidence: ["docs:connect"],
					nextStep: "Retest",
				},
				status: "answered" as const,
			},
			commentId: "comment-1",
			commentBody: "Private draft",
			eventId: "event-1",
		};
		const updated = await support.updateSupportTicket(db, row, p);
		expect(updated?.publicUpdates).toEqual([]);
		expect(
			await support.updateSupportTicket(db, row, {
				...p,
				key: "competing",
				commentId: "comment-2",
				eventId: "event-2",
			}),
		).toBeNull();
		expect(
			sqlite.prepare("select work_item_id,body from work_item_comments").all(),
		).toEqual([{ work_item_id: "mirror-a", body: "Private draft" }]);
		expect(sqlite.prepare("select count(*) n from work_events").get()).toEqual({
			n: 2,
		});
		expect(await support.updateSupportTicket(db, updated!, p)).toEqual(updated);
	});
});
