import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "../../../../packages/db/src/test/d1-facade";
import { schemaDdl } from "../../../../packages/db/src/test/schema-ddl";
import { organizations } from "@tedix/db/schema/organizations";
import {
	workInteractions,
	workInteractionResponses,
	workApprovalProposals,
	workApprovalDecisions,
	workInteractionCardPresentations,
} from "@tedix/db/schema/work-factory";
import { workItems } from "@tedix/db/schema/work-items";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import {
	learningInteractionEvents,
	decisionExposures,
	decisionOutcomeLabels,
} from "@tedix/db/schema/learning-feedback";
import { DecisionExposureInputSchema } from "@tedix/api-contract/schemas/decision-learning";
import {
	recordDecisionExposure,
	labelDecisionOutcomes,
	readDecisionCalibration,
} from "./decision-instrumentation";
import { listDecisionInstrumentation } from "@tedix/db/queries/decision-learning";

const now = new Date("2030-01-01T12:00:00Z");
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			workItems,
			workInteractions,
			workInteractionResponses,
			workApprovalProposals,
			workApprovalDecisions,
			workInteractionCardPresentations,
			tediApprovalRequests,
			memoryFacts,
			learningInteractionEvents,
			decisionExposures,
			decisionOutcomeLabels,
		),
	);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	const db = createDbQueryClient(createD1Facade(sqlite));
	return { db, sqlite };
}
async function request(
	db: ReturnType<typeof fixture>["db"],
	id = "decision-a",
	orgId = "org-lighthouse",
	targetId = "person-lighthouse",
) {
	await db
		.insert(organizations)
		.values({ id: orgId, name: "Fictional Lighthouse", slug: orgId })
		.onConflictDoNothing();
	await db.insert(workInteractions).values({
		id,
		orgId,
		kind: "decision",
		subject: "Approve the fictional draft",
		prompt: "Draft on card",
		creatorType: "tedi",
		creatorId: "tedi-lighthouse",
		targetType: "user",
		targetId,
		createdAt: now.toISOString(),
		metadata: { decisionClass: "draft" },
	});
}
function input(cardId = "decision-a") {
	return DecisionExposureInputSchema.parse({
		clientEventId: crypto.randomUUID(),
		sessionId: crypto.randomUUID(),
		cardId,
		sourceVersion: 1,
		position: 0,
		aboveFold: ["title", "options"],
		railOpened: false,
		timezone: "UTC",
		ranking: { version: "decision-learning-v1", score: 0, features: [] },
		candidates: [{ cardId, score: 0, reason: "shown", position: 0 }],
		candidateCount: 1,
		candidateSetComplete: true,
	});
}
async function expose(db: ReturnType<typeof fixture>["db"], value = input()) {
	return recordDecisionExposure(
		db,
		{
			organizationId: "org-lighthouse",
			actorId: "person-lighthouse",
			mayReadApprovals: false,
			input: value,
		},
		now,
	);
}
async function respond(
	db: ReturnType<typeof fixture>["db"],
	metadata: Record<string, string>,
	id = "response-a",
	at = "2030-01-01T12:01:00Z",
) {
	await db.insert(workInteractionResponses).values({
		id,
		orgId: "org-lighthouse",
		interactionId: "decision-a",
		resolvedRequestVersion: 1,
		resolutionFence: id,
		responderType: "user",
		responderId: "person-lighthouse",
		body: "My decision",
		responseKind: "answer",
		metadata,
		respondedAt: at,
	});
}

describe("decision instrumentation", () => {
	it("retains the first snapshot and counterfactual inventory, and fences other tenants and people", async () => {
		const { db } = fixture();
		await request(db);
		await request(db, "decision-b");
		await request(db, "decision-private", "org-harbor", "person-harbor");
		const value = input();
		value.candidates.push({
			cardId: "decision-b",
			score: -2,
			reason: "ranked_lower",
			position: 1,
		});
		value.candidateCount = 2;
		const receipt = await expose(db, value);
		await expose(db, value);
		await db.update(workInteractions).set({ subject: "Changed later" });
		const proof = await listDecisionInstrumentation(db, {
			organizationId: "org-lighthouse",
			actorId: "person-lighthouse",
			cardId: "decision-a",
			now: now.toISOString(),
			limit: 20,
		});
		expect(proof.exposures).toHaveLength(1);
		expect(proof.exposures[0]?.id).toBe(receipt.id);
		expect(proof.exposures[0]?.snapshot.title).toBe(
			"Approve the fictional draft",
		);
		expect(proof.exposures[0]?.context.candidates).toHaveLength(2);
		await expect(expose(db, { ...input("decision-private") })).rejects.toThrow(
			"unavailable",
		);
		await expect(
			recordDecisionExposure(
				db,
				{
					organizationId: "org-lighthouse",
					actorId: "person-other",
					mayReadApprovals: false,
					input: input(),
				},
				now,
			),
		).rejects.toThrow("unavailable");
		expect(
			(
				await listDecisionInstrumentation(db, {
					organizationId: "org-harbor",
					actorId: "person-lighthouse",
					now: now.toISOString(),
					limit: 20,
				})
			).exposures,
		).toEqual([]);
		await expect(expose(db, { ...value, railOpened: true })).rejects.toThrow(
			"already used",
		);
	});
	it.each([
		{ personId: "person-lighthouse", requestVersion: 1, displayed: true },
		{ personId: "person-other", requestVersion: 1, displayed: false },
		{ personId: "person-lighthouse", requestVersion: 2, displayed: false },
	])(
		"snapshots only the displayed person's current copy: $personId/$requestVersion",
		async ({ personId, requestVersion, displayed }) => {
			const { db } = fixture();
			await request(db);
			const original = {
				version: 2 as const,
				title: "Approve the original draft?",
				body: "Send the original fictional draft",
				recommendation: "Uses the original draft",
			};
			const revised = {
				version: 2 as const,
				title: "Approve the revised draft?",
				body: "Send the revised fictional draft",
				recommendation: "Uses the reviewed draft",
			};
			await db.update(workInteractions).set({
				metadata: { decisionClass: "draft", cardPresentation: original },
			});
			await db.insert(workInteractionCardPresentations).values({
				orgId: "org-lighthouse",
				interactionId: "decision-a",
				personId,
				requestVersion,
				presentation: revised,
				updatedAt: now.toISOString(),
			});
			await expose(db);
			const proof = await listDecisionInstrumentation(db, {
				organizationId: "org-lighthouse",
				actorId: "person-lighthouse",
				cardId: "decision-a",
				now: now.toISOString(),
				limit: 1,
			});
			const expected = displayed ? revised : original;
			expect(proof.exposures[0]?.snapshot).toMatchObject({
				title: expected.title,
				body: expected.body,
				recommendation: expected.recommendation,
			});
		},
	);
	it.each([
		[
			{ decisionChoice: "approve", feedbackSignal: "approve-as-is" },
			"unchanged_approval",
		],
		[
			{ decisionChoice: "change", feedbackSignal: "edited" },
			"edited_then_approved",
		],
		[
			{
				decisionChoice: "reject",
				feedbackSignal: "reason",
				feedbackReason: "wrong-time",
			},
			"not_this",
		],
		[{ decisionChoice: "later" }, "later"],
		[{ decisionChoice: "delegate" }, "decided_for_me"],
	] as const)(
		"labels canonical responses once: %s",
		async (metadata, label) => {
			const { db, sqlite } = fixture();
			await request(db);
			await expose(db);
			await respond(db, metadata);
			await labelDecisionOutcomes(db, new Date("2030-01-01T12:02:00Z"));
			await labelDecisionOutcomes(db, new Date("2030-01-01T12:03:00Z"));
			const rows = sqlite
				.prepare("SELECT outcome FROM decision_outcome_labels")
				.all();
			expect(rows).toHaveLength(1);
			expect(JSON.parse(String(rows[0]?.outcome)).label).toBe(label);
		},
	);
	it("keeps delayed labels pending, catches up both windows idempotently, and does not invent successful outcomes", async () => {
		const { db, sqlite } = fixture();
		await request(db);
		await expose(db);
		await respond(db, {
			decisionChoice: "approve",
			feedbackSignal: "approve-as-is",
		});
		await labelDecisionOutcomes(db, new Date("2030-01-01T12:02:00Z"));
		expect(
			sqlite.prepare("SELECT id FROM decision_outcome_labels").all(),
		).toHaveLength(1);
		await labelDecisionOutcomes(db, new Date("2030-01-02T12:02:00Z"));
		expect(
			sqlite.prepare("SELECT id FROM decision_outcome_labels").all(),
		).toHaveLength(2);
		await labelDecisionOutcomes(db, new Date("2030-01-09T12:02:00Z"));
		await labelDecisionOutcomes(db, new Date("2030-01-09T12:03:00Z"));
		const rows = sqlite
			.prepare(
				"SELECT delayed FROM decision_outcome_labels WHERE window='day_7'",
			)
			.all();
		expect(rows).toHaveLength(1);
		expect(JSON.parse(String(rows[0]?.delayed))).toMatchObject({
			workCompleted: null,
			revertedOrCorrected: null,
			lessonMined: false,
			followUpRaised: null,
		});
		const calibration = await readDecisionCalibration(
			db,
			{
				organizationId: "org-lighthouse",
				actorId: "person-lighthouse",
				classId: "draft",
			},
			new Date("2030-01-09T12:03:00Z"),
		);
		expect(calibration).toMatchObject({
			decisions: 1,
			unchanged: 1,
			predictedMean: null,
			predictedCount: 0,
			observedRate: 1,
			statement: "Cards like this: you approved 1 of 1 unchanged",
		});
		await labelDecisionOutcomes(db, new Date("2031-01-01T00:00:00Z"));
		expect(sqlite.prepare("SELECT id FROM decision_exposures").all()).toEqual(
			[],
		);
		expect(
			sqlite.prepare("SELECT id FROM decision_outcome_labels").all(),
		).toEqual([]);
	});
});

it("links a later choice to the eventual decision without counting later as an approval", async () => {
	const { db, sqlite } = fixture();
	await request(db);
	await expose(db);
	await respond(
		db,
		{ decisionChoice: "later" },
		"response-later",
		"2030-01-01T12:01:00Z",
	);
	await respond(
		db,
		{ decisionChoice: "approve", feedbackSignal: "approve-as-is" },
		"response-final",
		"2030-01-01T13:01:00Z",
	);
	await labelDecisionOutcomes(db, new Date("2030-01-01T13:02:00Z"));
	const labels = sqlite
		.prepare("SELECT outcome FROM decision_outcome_labels")
		.all()
		.map((r) => JSON.parse(String(r.outcome)));
	expect(labels.find((l) => l.receiptId === "response-final")).toMatchObject({
		label: "unchanged_approval",
		laterToDecisionMs: 3600000,
	});
	expect(
		await readDecisionCalibration(
			db,
			{
				organizationId: "org-lighthouse",
				actorId: "person-lighthouse",
				classId: "draft",
			},
			new Date("2030-01-01T13:02:00Z"),
		),
	).toMatchObject({ decisions: 1, unchanged: 1 });
});

it("observes linked Work, corrections, mined lessons and follow-up cards inside the delayed window", async () => {
	const { db, sqlite } = fixture();
	await request(db);
	await db.insert(workItems).values({
		id: "work-lighthouse",
		orgId: "org-lighthouse",
		title: "Fictional draft task",
		createdAt: now.toISOString(),
		disposition: "completed",
		completedAt: "2030-01-01T13:00:00Z",
	});
	await db.update(workInteractions).set({ workItemId: "work-lighthouse" });
	await expose(db);
	await respond(db, {
		decisionChoice: "approve",
		feedbackSignal: "approve-as-is",
	});
	await db.insert(learningInteractionEvents).values({
		id: "event-lighthouse",
		organizationId: "org-lighthouse",
		actorType: "user",
		actorId: "person-lighthouse",
		clientEventId: "correction-lighthouse",
		eventKind: "undone",
		scopeKind: "personal",
		scopeId: "person-lighthouse",
		surface: "work_outcome",
		targetId: "decision-a",
		metadata: { serverObserved: true },
		occurredAt: "2030-01-01T14:00:00Z",
	});
	await db.insert(memoryFacts).values({
		id: "lesson-lighthouse",
		organizationId: "org-lighthouse",
		factType: "lesson",
		content: "Fictional evidence-linked lesson",
		metadata: { learningFeed: { evidenceEventIds: ["event-lighthouse"] } },
		createdAt: "2030-01-01 15:00:00",
	});
	await request(db, "follow-up");
	await db
		.update(workInteractions)
		.set({ workItemId: "work-lighthouse", createdAt: "2030-01-01T16:00:00Z" })
		.where((await import("drizzle-orm")).eq(workInteractions.id, "follow-up"));
	await labelDecisionOutcomes(db, new Date("2030-01-02T12:02:00Z"));
	const label = sqlite
		.prepare("SELECT delayed FROM decision_outcome_labels WHERE window='day_1'")
		.get();
	expect(JSON.parse(String(label?.delayed))).toMatchObject({
		revertedOrCorrected: true,
		lessonMined: true,
		workCompleted: true,
		followUpRaised: true,
	});
});

it("accepts the maximum bounded candidate inventory through D1 without exceeding its parameter limit", async () => {
	const { db } = fixture();
	for (let i = 0; i < 100; i++) await request(db, `decision-${i}`);
	const value = input("decision-0");
	value.candidates = Array.from({ length: 100 }, (_, i) => ({
		cardId: `decision-${i}`,
		score: 100 - i,
		reason: i === 0 ? ("shown" as const) : ("ranked_lower" as const),
		position: i,
	}));
	value.candidateCount = 100;
	await expect(expose(db, value)).resolves.toHaveProperty("id");
});

it("enforces immutable database observations while allowing retention deletion", async () => {
	const { db, sqlite } = fixture();
	await request(db);
	await expose(db);
	const { readFileSync } = await import("node:fs");
	sqlite.exec(
		readFileSync(
			new URL(
				"../../../../packages/db/drizzle/20261018175624_decision_instrumentation_immutable/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	expect(() =>
		sqlite.exec("UPDATE decision_exposures SET class_id='changed'"),
	).toThrow("append-only");
	await respond(db, {
		decisionChoice: "approve",
		feedbackSignal: "approve-as-is",
	});
	await labelDecisionOutcomes(db, new Date("2030-01-01T12:02:00Z"));
	expect(() =>
		sqlite.exec("UPDATE decision_outcome_labels SET class_id='changed'"),
	).toThrow("append-only");
	await labelDecisionOutcomes(db, new Date("2031-01-01T00:00:00Z"));
	expect(sqlite.prepare("SELECT id FROM decision_exposures").all()).toEqual([]);
});

it("replays the original exposure receipt after the card changes and rejects a new stale exposure", async () => {
	const { db } = fixture();
	await request(db);
	const value = input();
	const receipt = await expose(db, value);
	await db
		.update(workInteractions)
		.set({ version: 2, subject: "A revised fictional card" });
	await expect(expose(db, value)).resolves.toEqual(receipt);
	await expect(
		expose(db, { ...value, clientEventId: crypto.randomUUID() }),
	).rejects.toThrow("Card changed");
});
