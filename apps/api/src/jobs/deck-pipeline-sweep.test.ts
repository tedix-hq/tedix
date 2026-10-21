import { DatabaseSync } from "node:sqlite";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	workInteractionCardRevisions,
	workInteractions,
} from "@tedix/db/schema/work-factory";
import {
	workItems,
	workAttempts,
	workItemRelations,
} from "@tedix/db/schema/work-items";
import { decisionEdges } from "@tedix/db/schema/decision-graph";
import { upsertDecisionEdges } from "@tedix/db/queries/decision-graph";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { getDeckSweepReceipt } from "@tedix/db/queries/work-items/deck-sweep";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const models = vi.hoisted(() => ({ qwen: vi.fn(), clef: vi.fn() }));
vi.mock("../services/decision-card-copy-model", () => ({
	runDecisionCardCopyModel: models.qwen,
}));
vi.mock("../lib/clef", () => ({ runClef: models.clef }));

import { sweepOrganizationDeck } from "./deck-pipeline-sweep";

beforeEach(() => {
	models.qwen.mockReset().mockResolvedValue('{"label":"NOISE"}');
	models.clef.mockReset().mockResolvedValue({
		ok: true,
		latencyMs: 5,
		answers: {
			value: {
				type: "choice",
				choice: "NOISE",
				probabilities: { NOISE: 0.97, VALUABLE: 0.03 },
				confidence: 0.97,
			},
		},
	});
});

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
			workAttempts,
			workItemRelations,
			decisionEdges,
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
		metadata: { decisionClass: "relationship" },
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
		await upsertDecisionEdges(db, ORG, [
			{
				kind: "same_as",
				from: { kind: "deck_card", id: older },
				to: { kind: "deck_card", id: newer },
				source: "fictional-test",
			},
		]);
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
			metrics: [{ recipientId: USER, liveCards: 2, removals: 3 }],
		});
	});

	it("counts an undone removal as a wrong removal on the next tick", async () => {
		const { db } = await fixture();
		const expired = await card(db, { metadata: expiredDecision });
		await card(db);
		await sweepOrganizationDeck(db, ORG, now);
		await db
			.update(workInteractions)
			.set({ status: "open", metadata: { decisionClass: "relationship" } })
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

	it("logs Qwen's label and the second key in shadow without hiding anything", async () => {
		const examples = Array.from({ length: 8 }, (_, index) => ({
			id: `example-${index}`,
			cardId: `old-${index}`,
			title: `Routine status ${index}`,
			summary: "A status digest with no owner decision.",
			label: index % 2 ? "VALUABLE" : "NOISE",
			evidenceRef: `audit:${index}`,
			decidedAt: "2026-10-01T00:00:00.000Z",
		}));
		const { db } = await fixture({
			deckCuratorRanker: { enabled: true },
			deckCurators: [
				{
					tediId: "33333333-3333-4333-8333-333333333333",
					recipientId: USER,
					gadgetId: "44444444-4444-4444-8444-444444444444",
					enabled: true,
					examples,
				},
			],
		});
		const id = await card(db, { subject: "Acknowledge the weekly status?" });
		const receipt = await sweepOrganizationDeck(
			db,
			ORG,
			now,
			{} as CloudflareEnv,
		);
		expect(receipt).toMatchObject({ ranked: 1, hidden: 0 });
		const row = await status(db, id);
		expect(row.status).toBe("open");
		expect(row.metadata.curation).toMatchObject({
			status: "open",
			penalty: -10,
			shadow: { label: "NOISE", secondKeyNoise: 0.97, wouldHide: true },
		});
		expect(models.qwen).toHaveBeenCalledTimes(1);
		await sweepOrganizationDeck(db, ORG, now, {} as CloudflareEnv);
		expect(models.qwen).toHaveBeenCalledTimes(1);
	});

	it("reports the rule-baseline comparison without reordering the Deck", async () => {
		const examples = Array.from({ length: 8 }, (_, index) => ({
			id: `example-${index}`,
			cardId: `old-${index}`,
			title: `Routine status ${index}`,
			summary: "A status digest with no owner decision.",
			label: index % 2 ? "VALUABLE" : "NOISE",
			evidenceRef: `audit:${index}`,
			decidedAt: "2026-10-01T00:00:00.000Z",
		}));
		const { db } = await fixture({
			deckCuratorRanker: { enabled: true },
			deckCurators: [
				{
					tediId: "33333333-3333-4333-8333-333333333333",
					recipientId: USER,
					gadgetId: "44444444-4444-4444-8444-444444444444",
					enabled: true,
					examples,
				},
			],
		});
		await card(db, { subject: "Acknowledge the weekly status?" });
		await card(db, { subject: "Confirm the venue for Friday?" });
		const receipt = await sweepOrganizationDeck(
			db,
			ORG,
			now,
			{} as CloudflareEnv,
		);
		expect(receipt.rankNotes).toMatchObject({
			ruleCompared: 1,
			rulePairs: 1,
			ruleTopSize: 2,
			ruleTopOverlap: 2,
		});
		expect(receipt).toMatchObject({ hidden: 0, retired: 0 });
	});

	it("hides a would-hide card only in a class that earned hiding, and counts its undo", async () => {
		const classKey = "answer|external_agent:agent-1";
		const { db } = await fixture({
			deckPipeline: {
				hidingClasses: [
					{
						recipientId: USER,
						classKey,
						state: "hiding",
						changedAt: "2026-11-04T00:00:00.000Z",
						reason: "earned",
					},
				],
			},
		});
		const shadow = (wouldHide: boolean) => ({
			curation: {
				schema: "tedix.deck-curation.v1",
				revision: null,
				status: "open",
				successorId: null,
				penalty: -10,
				reason: "ranked_lower",
				evidenceRefs: [],
				model: "qwen",
				exampleIds: [],
				shadow: {
					label: "NOISE",
					secondKeyNoise: wouldHide ? 0.99 : 0.5,
					wouldHide,
					classKey,
					at: "2026-10-21T06:00:00.000Z",
				},
			},
		});
		const hidden = await card(db, { metadata: shadow(true) });
		const kept = await card(db, { metadata: shadow(false) });
		const receipt = await sweepOrganizationDeck(db, ORG, now);
		expect(receipt.hidden).toBe(1);
		expect((await status(db, hidden)).status).toBe("cancelled");
		expect((await status(db, kept)).status).toBe("open");
	});
});

it("retires graph-linked prior decisions with their evidence; keeps a remaining owner task", async () => {
	const { db } = await fixture();
	const decided = await card(db, {
		subject: "Should Maple renew?",
		metadata: { riskLevel: "high" },
	});
	const task = await card(db, {
		subject: "Maple login (about 3 min)",
		prompt: "1. Sign in with MFA.\n2. Remove the old key.",
		metadata: {
			ownerTask: {
				presence: "mfa",
				steps: ["Sign in with MFA.", "Remove the old key."],
				estimatedMinutes: 3,
			},
		},
	});
	await upsertDecisionEdges(
		db,
		ORG,
		[decided, task].map((id) => ({
			kind: "decided_by" as const,
			from: { kind: "deck_card" as const, id },
			to: { kind: "owner_instruction" as const, id: "fictional-maple-lesson" },
			source: "fictional-owner",
			evidenceRef: "/lessons/fictional-maple-lesson",
		})),
	);
	const result = await sweepOrganizationDeck(db, ORG, now);
	expect(result.retired).toBe(1);
	expect((await status(db, decided)).metadata.curation).toMatchObject({
		retirement: { reason: "already_decided" },
		reason: "Already decided.",
		evidenceRefs: ["/lessons/fictional-maple-lesson"],
	});
	expect((await status(db, task)).status).toBe("open");
});

it("uses the recorded answer of a linked resolved duplicate", async () => {
	const { db } = await fixture();
	const answered = await card(db, {
		subject: "Maple renewal",
		status: "resolved",
	});
	const repeated = await card(db, { subject: "Continue the orchard plan?" });
	await upsertDecisionEdges(db, ORG, [
		{
			kind: "same_as",
			from: { kind: "deck_card", id: repeated },
			to: { kind: "deck_card", id: answered },
			source: "fictional-curator",
		},
		{
			kind: "card_answers",
			from: { kind: "deck_card", id: answered },
			to: { kind: "decision", id: "maple-answer" },
			source: "fictional-owner",
			evidenceRef: "/work/interactions/maple-answer",
		},
	]);
	const result = await sweepOrganizationDeck(db, ORG, now);
	expect(result.retired).toBe(1);
	expect((await status(db, repeated)).metadata.curation).toMatchObject({
		retirement: { reason: "already_decided" },
		evidenceRefs: ["/work/interactions/maple-answer"],
	});
});
