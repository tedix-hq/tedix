import { DatabaseSync } from "node:sqlite";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	workInteractionCardRevisions,
	workInteractions,
} from "@tedix/db/schema/work-factory";
import { workItems } from "@tedix/db/schema/work-items";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { getDeckSweepReceipt } from "@tedix/db/queries/work-items/deck-sweep";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { sweepOrganizationDeck } from "./deck-pipeline-sweep";

const ORG = "org-sweep";
const USER = "user-1";
const AGENT = "agent-1";
const WORK_DONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORK_OPEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = new Date("2026-10-21T07:00:00.000Z");

async function fixture(decisionLearning: Record<string, unknown> = {}) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			workItems,
			workInteractions,
			workInteractionCardRevisions,
			learningInteractionEvents,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(organizations).values({
		id: ORG,
		name: "Sample Co",
		slug: "sample",
		descopeTenantId: "sample",
		metadata: { decisionLearning: decisionLearning as never },
	});
	await db.insert(organizationMembers).values({
		id: "member-1",
		organizationId: ORG,
		userId: USER,
		descopeUserId: USER,
		email: "reviewer@example.com",
		status: "active",
	});
	for (const [id, disposition] of [
		[WORK_DONE, "completed"],
		[WORK_OPEN, "accepted"],
	] as const)
		await db.insert(workItems).values({
			id,
			orgId: ORG,
			title: "Sample work",
			disposition,
			workKind: "task",
			createdAt: "2026-10-01T00:00:00.000Z",
			updatedAt: "2026-10-01T00:00:00.000Z",
		} as never);
	return { db, sqlite };
}

const expiredDecision = {
	decisionDeck: {
		version: 1,
		kind: "decision",
		classId: "ops.booth",
		proposal: "Staff the booth?",
		whyNow: "The event is on 20 October.",
		recommendation: "Staff it.",
		reversibility: "two_way",
		blastRadius: "One event",
		confidence: null,
		costOfWaiting: "The event passes.",
		expiresAt: "2026-10-20T18:00:00.000Z",
		reasoning: "Event day.",
		options: [
			{
				id: "yes",
				label: "Yes",
				intent: "approve",
				consequence: "Staffs it.",
				cost: "None",
			},
			{
				id: "no",
				label: "No",
				intent: "reject",
				consequence: "Skips it.",
				cost: "None",
			},
		],
	},
};

let seq = 0;
async function card(
	db: DbClient,
	overrides: Partial<typeof workInteractions.$inferInsert> = {},
) {
	seq += 1;
	const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
	await db.insert(workInteractions).values({
		id,
		orgId: ORG,
		workItemId: WORK_OPEN,
		kind: "question",
		subject: `Choose option ${seq}?`,
		prompt: "I recommend the first option.",
		creatorType: "external_agent",
		creatorId: AGENT,
		targetType: "user",
		targetId: USER,
		createdAt: `2026-10-20T0${seq % 10}:00:00.000Z`,
		metadata: {},
		...overrides,
	});
	return id;
}

async function status(db: DbClient, id: string) {
	const [row] = await db
		.select({
			status: workInteractions.status,
			metadata: workInteractions.metadata,
		})
		.from(workInteractions)
		.where(eq(workInteractions.id, id));
	return row!;
}

describe("deck pipeline sweep", () => {
	it("retires expired, finished-Work and duplicate cards and keeps actionable ones", async () => {
		const { db } = await fixture();
		const expired = await card(db, { metadata: expiredDecision });
		const finished = await card(db, { workItemId: WORK_DONE });
		const overdue = await card(db, { dueAt: "2026-10-01T00:00:00.000Z" });
		const older = await card(db, {
			subject: "Publish the reply to Omar?",
			createdAt: "2026-10-19T00:00:00.000Z",
		});
		const newer = await card(db, {
			subject: "Publish the reply to Omar",
			createdAt: "2026-10-20T09:00:00.000Z",
		});
		const human = await card(db, {
			creatorType: "user",
			creatorId: USER,
			metadata: expiredDecision,
		});
		const gone = await card(db, { expiresAt: "2026-10-20T00:00:00.000Z" });
		const receipt = await sweepOrganizationDeck(db, ORG, now);
		expect(receipt).toMatchObject({
			mode: "enforce",
			recipients: 1,
			retired: 2,
			merged: 1,
			errors: 0,
		});
		expect((await status(db, expired)).status).toBe("cancelled");
		expect((await status(db, finished)).status).toBe("cancelled");
		expect((await status(db, older)).status).toBe("cancelled");
		expect((await status(db, older)).metadata.curation).toMatchObject({
			status: "cancelled",
			successorId: newer,
			retirement: { reason: "duplicate" },
		});
		for (const id of [overdue, newer, human, gone])
			expect((await status(db, id)).status).toBe("open");
		expect(await getDeckSweepReceipt(db, ORG)).toMatchObject({
			at: now.toISOString(),
			metrics: [{ recipientId: USER, liveCards: 3, removals: 3 }],
		});
	});

	it("counts an undone removal as a wrong removal on the next tick", async () => {
		const { db } = await fixture();
		const expired = await card(db, { metadata: expiredDecision });
		await card(db);
		await sweepOrganizationDeck(db, ORG, now);
		await db
			.update(workInteractions)
			.set({ status: "open", metadata: {} })
			.where(eq(workInteractions.id, expired));
		const next = await sweepOrganizationDeck(
			db,
			ORG,
			new Date("2026-10-21T07:15:00.000Z"),
		);
		expect(next.metrics[0]).toMatchObject({
			wrongRemovals: 1,
			wrongProtectedRemovals: 0,
			liveCards: 2,
			morning: null,
		});
	});

	it("takes the 08:30 morning count in the organization's timezone", async () => {
		const { db } = await fixture({ timezone: "Europe/Berlin" });
		await card(db);
		const receipt = await sweepOrganizationDeck(
			db,
			ORG,
			new Date("2026-10-21T06:45:00.000Z"),
		);
		expect(receipt.metrics[0]?.morning).toEqual({
			date: "2026-10-21",
			liveCards: 1,
		});
	});

	it("only counts what it would retire in shadow mode", async () => {
		const { db } = await fixture({
			deckPipeline: { sweep: { mode: "shadow" } },
		});
		const expired = await card(db, { metadata: expiredDecision });
		const receipt = await sweepOrganizationDeck(db, ORG, now);
		expect(receipt).toMatchObject({ wouldRetire: 1, retired: 0 });
		expect((await status(db, expired)).status).toBe("open");
	});
});
