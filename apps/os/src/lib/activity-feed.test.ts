import { describe, expect, it } from "vite-plus/test";
import {
	ActivityFeedConfigSchema,
	ActivityFeedItemSchema,
} from "@tedix/api-contract/schemas/os-activity-feed";
import {
	EMPTY_FEED_PREFERENCES,
	feedLearningInput,
	quietNow,
	rankFeed,
	safeSource,
	decisionFeedItems,
	sentence,
} from "./activity-feed";
import { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import { DECISION_DECK_EXAMPLES } from "../../dev/decision-deck-fixture";

const project = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const config = ActivityFeedConfigSchema.parse({
	version: 1,
	projects: [{ id: project, label: "Pine Studio" }],
	quietHours: { start: 22, end: 7 },
});
const now = new Date("2026-10-17T12:00:00.000Z");
function item(
	id: string,
	extra: Partial<ReturnType<typeof ActivityFeedItemSchema.parse>> = {},
) {
	return ActivityFeedItemSchema.parse({
		id,
		actor: "Cedar",
		sentence: "The review finished.",
		source: `/work/items/${project}`,
		projectId: project,
		tediId: null,
		workItemId: project,
		kind: "result",
		classId: "review",
		importance: "normal",
		at: now.toISOString(),
		dueAt: null,
		needsAction: false,
		stalled: false,
		done: false,
		explanation: "Source receipt",
		reactions: ["more", "why", "mute", "comment", "work"],
		...extra,
	});
}
describe("activity feed", () => {
	it("an organization feed includes new projects without copying project IDs into its manifest", () => {
		const organization = ActivityFeedConfigSchema.parse({
			version: 1,
			scope: "organization",
			projects: [],
		});
		const rows = [item("pine"), item("cedar", { projectId: other })];
		expect(
			rankFeed(rows, organization, EMPTY_FEED_PREFERENCES, now),
		).toHaveLength(2);
		expect(rankFeed(rows, config, EMPTY_FEED_PREFERENCES, now)).toHaveLength(1);
		expect(
			rankFeed(
				rows,
				organization,
				{ ...EMPTY_FEED_PREFERENCES, projectIds: [other] },
				now,
			),
		).toHaveLength(1);
		expect(
			ActivityFeedConfigSchema.safeParse({ version: 1, projects: [] }).success,
		).toBe(false);
	});

	it("keeps a multi-sentence receipt to one sentence on the card", () => {
		expect(
			sentence("The review finished.\n\nThe receipt includes more detail."),
		).toBe("The review finished.");
		expect(
			sentence(
				"Open https://supplier.example/receipt for the result. Next step.",
			),
		).toBe("Open https://supplier.example/receipt for the result.");
		expect(sentence("  A short\nupdate  ")).toBe("A short update");
		expect(sentence("2. The Office fix is live. More details follow.")).toBe(
			"The Office fix is live.",
		);
	});
	it("retains the deck's exact ADR envelope and class without adding feed approval actions", () => {
		const envelope = DECISION_DECK_EXAMPLES.find(
			(card) => card.kind === "adr",
		)!;
		const row = WorkInteractionInboxRowSchema.parse({
			request: {
				id: project,
				orgId: other,
				workItemId: project,
				caseId: null,
				projectId: project,
				kind: "question",
				subject: "Choose a plan",
				prompt: "Which plan?",
				requestedFromType: "user",
				requestedFromId: "pine",
				creatorType: "user",
				creatorId: "birch",
				creatorSessionId: null,
				state: "open",
				requestedAt: now.toISOString(),
				dueAt: null,
				expiresAt: null,
				resolvedAt: null,
				version: 1,
				metadata: { decisionDeck: envelope },
			},
			effectiveState: "open",
			canRespond: true,
			canCancel: false,
			workItem: { id: project, title: "Plan", projectId: project },
			responseCount: 0,
		});
		const card = decisionFeedItems([row])[0]!;
		expect(ActivityFeedItemSchema.parse(card).decision).toEqual(envelope);
		expect(card.classId).toBe(envelope.classId);
		expect(card.sentence).toBe(envelope.proposal);
		expect(card.reactions).not.toContain("approve");
		row.request.metadata = { ...row.request.metadata, remind_at: "2026-10-28" };
		expect(
			decisionFeedItems(
				[row],
				new Date("2026-10-18T12:00:00Z"),
				"Europe/Berlin",
			),
		).toHaveLength(0);
		expect(
			decisionFeedItems(
				[row],
				new Date("2026-10-27T23:00:00Z"),
				"Europe/Berlin",
			),
		).toHaveLength(1);
	});
	it("ranks an old approaching deadline ahead of a recent routine update", () => {
		const ranked = rankFeed(
			[
				item("new"),
				item("deadline", {
					at: "2026-10-10T10:00:00.000Z",
					dueAt: "2026-10-17T13:00:00.000Z",
					needsAction: true,
				}),
			],
			config,
			EMPTY_FEED_PREFERENCES,
			now,
		);
		expect(ranked.map((r) => r.id)).toEqual(["deadline", "new"]);
	});
	it("deduplicates receipts and excludes unconfigured projects and unsafe sources", () => {
		expect(
			rankFeed(
				[
					item("a"),
					item("a"),
					item("other", { projectId: other }),
					item("unsafe", { source: "javascript:alert(1)" }),
				],
				config,
				EMPTY_FEED_PREFERENCES,
				now,
			).map((r) => r.id),
		).toEqual(["a"]);
		expect(safeSource("//evil.example")).toBe(false);
	});
	it("keeps pending human decisions visible after a personal class mute", () => {
		const prefs = { ...EMPTY_FEED_PREFERENCES, mutedClasses: ["review"] };
		expect(
			rankFeed(
				[item("receipt"), item("ask", { needsAction: true })],
				config,
				prefs,
				now,
			).map((r) => r.id),
		).toEqual(["ask"]);
		expect(
			rankFeed([item("receipt")], config, EMPTY_FEED_PREFERENCES, now),
		).toHaveLength(1);
	});
	it("recomputes urgency as time passes and identifies changed-since-last-look", () => {
		const row = item("due", { dueAt: "2026-10-18T12:00:00.000Z" });
		const prefs = {
			...EMPTY_FEED_PREFERENCES,
			lastSeenAt: "2026-10-16T00:00:00.000Z",
		};
		const before = rankFeed([row], config, prefs, now)[0]!;
		const after = rankFeed(
			[row],
			config,
			prefs,
			new Date("2026-10-18T11:00:00.000Z"),
		)[0]!;
		expect(after.score).toBeGreaterThan(before.score);
		expect(before.unseen).toBe(true);
		expect(quietNow(config, 23)).toBe(true);
		expect(quietNow(config, 6)).toBe(true);
		expect(quietNow(config, 12)).toBe(false);
	});
	it("records a correction in the personal learning shape without granting an action", () => {
		const input = feedLearningInput(
			item("receipt"),
			"comment",
			"Keep supplier names out of public drafts.",
			"correction-1",
		);
		expect(input).toMatchObject({
			surface: "activity_feed",
			eventKind: "edited",
			scope: { kind: "personal" },
			metadata: {
				answer: "Keep supplier names out of public drafts.",
				draft: { body: "The review finished." },
				source: `/work/items/${project}`,
			},
		});
		expect(input).not.toHaveProperty("approverId");
	});
});

it("keeps lifecycle bookkeeping quiet and resolves human, tedi and coding authors", async () => {
	const { workFeedItems } = await import("./activity-feed");
	const events = [
		"work.accepted",
		"work.specification_updated",
		"work.cancelled",
		"work.completed",
		"evidence.submitted",
	].map((eventType, i) => ({
		id: String(i),
		workItemId: project,
		workItemTitle: "Deck spacing",
		workItemDisposition: "completed" as const,
		eventType,
		authorType: "user",
		authorId: "person",
		agentSession: null,
		agentHarness: null,
		settlement: null,
		body: eventType,
		createdAt: now.toISOString(),
	}));
	const names = new Map([
		["user:person", "Morgan Lee"],
		["tedi:cedar", "Cedar"],
	]);
	const rows = workFeedItems(events, project, names);
	expect(
		rows.every((row) => row.importance === "low" && row.actor === "Morgan Lee"),
	).toBe(true);
	expect(
		workFeedItems(
			[{ ...events[0]!, authorType: "tedi", authorId: "cedar" }],
			project,
			names,
		)[0],
	).toMatchObject({ actor: "Cedar", tediId: "cedar" });
	expect(
		workFeedItems(
			[{ ...events[0]!, authorType: "external_agent", agentHarness: "codex" }],
			project,
			names,
		)[0]?.actor,
	).toBe("Codex");
});

it("keeps opaque failure diagnostics out of previews and uses structured harness provenance", async () => {
	const { resultFeedItems } = await import("./activity-feed");
	const { WorkAttemptProjectionSchema } =
		await import("@tedix/api-contract/schemas/work-items");
	const row = WorkAttemptProjectionSchema.parse({
		attempt: {
			orgId: project,
			workItemId: other,
			executorSessionId: null,
			runtimeState: "failed",
			runId: null,
			admissionId: null,
			attemptNumber: 1,
			heartbeatAt: now.toISOString(),
			expiresAt: null,
			id: project,
			executorType: "external_agent",
			executorId: "pine-laptop",
			externalSessionKey: "claude-code:previous",
			metadata: { agentHarness: "codex" },
			outcome: "failed",
			summary:
				"Failed: Attempt failed without a reported reason; inspect its run history.",
			startedAt: now.toISOString(),
			finishedAt: now.toISOString(),
		},
		workItem: {
			id: other,
			title: "Supplier review",
			projectId: project,
			disposition: "accepted",
			workKind: "coding",
			riskLevel: "medium",
			priority: "medium",
			accountableOwnerType: null,
			accountableOwnerId: null,
		},
	});
	const result = resultFeedItems([row])[0]!;
	expect(result.sentence).toBe("Supplier review — Didn't finish.");
	expect(result.attachment?.summary).toBeUndefined();
	expect(result.actorIdentity).toMatchObject({
		type: "external_agent",
		id: "pine-laptop",
		harness: "codex",
	});
	const updated = resultFeedItems([
		{
			...row,
			attempt: {
				...row.attempt,
				summary: "The supplier report is ready. Follow-up is pending.",
			},
		},
	])[0]!;
	expect(updated.sentence).toBe("The supplier report is ready.");
	expect(updated.source).toBe(`/work/items/${other}`);
});

it("keeps a personal correction's recorded author for their photo lookup", async () => {
	const { correctionFeedItems } = await import("./activity-feed");
	const { LearningInteractionEventSchema } =
		await import("@tedix/api-contract/schemas/learning-feedback");
	const event = LearningInteractionEventSchema.parse({
		id: "pine-edit",
		organizationId: "fictional-pine",
		actorType: "user",
		actorId: "maple-owner",
		tediId: null,
		clientEventId: "pine-correction",
		signalClass: "quality",
		eventKind: "edited",
		scopeKind: "personal",
		scopeId: "maple-owner",
		issueKey: null,
		surface: "activity_feed",
		targetType: "work_interaction",
		targetId: project,
		threadId: null,
		runId: null,
		metadata: {
			answer: "Use the shorter subject.",
			source: `/work/items/${project}`,
		},
		occurredAt: now.toISOString(),
		createdAt: now.toISOString(),
	});
	expect(correctionFeedItems([event])[0]?.actorIdentity).toEqual({
		type: "user",
		id: "maple-owner",
	});
});
