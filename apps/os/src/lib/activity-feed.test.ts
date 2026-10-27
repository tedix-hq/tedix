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
	resultFeedItems,
	safeSource,
	decisionFeedItems,
	feedHeadlineIssues,
	sentence,
} from "@tedix/api-contract/utils/activity-feed";
import { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import { WorkAttemptProjectionSchema } from "@tedix/api-contract/schemas/work-items";
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
		row.request.dueAt = "2026-10-29";
		expect(decisionFeedItems([row], now, "Europe/Berlin")[0]?.dueAt).toBe(
			"2026-10-29",
		);
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

it("surfaces open incidents loudly while keeping closed incident bookkeeping quiet", async () => {
	const { workFeedItems } =
		await import("@tedix/api-contract/utils/activity-feed");
	const { WorkActivityEventSchema } =
		await import("@tedix/api-contract/schemas/work-items");
	const event = WorkActivityEventSchema.parse({
		id: "lag-alert",
		workItemId: project,
		workItemTitle: "Production is behind main",
		workItemKind: "incident",
		workItemDisposition: "proposed",
		eventType: "work.created",
		authorType: "system",
		authorId: null,
		agentSession: null,
		agentHarness: null,
		settlement: null,
		body: "Production is behind main",
		createdAt: now.toISOString(),
	});
	expect(workFeedItems([event], project)[0]?.importance).toBe("critical");
	for (const workItemDisposition of ["completed", "cancelled"] as const)
		expect(
			workFeedItems([{ ...event, workItemDisposition }], project)[0]
				?.importance,
		).toBe("low");
});

it("keeps lifecycle bookkeeping quiet and resolves human, tedi and coding authors", async () => {
	const { workFeedItems } =
		await import("@tedix/api-contract/utils/activity-feed");
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
	const fyi = workFeedItems(
		[
			{
				...events[0]!,
				eventType: "delegation.fyi",
				delegationFyi: {
					classId: "delegation:multi_hop_read",
					homeRunId: "home",
					childRunId: "child",
					tediId: project,
					tediName: "Cedar",
					task: "Review the paper",
					outcome: "completed",
				},
			},
		],
		project,
	)[0];
	expect(fyi).toMatchObject({
		sentence: "Delegated “Review the paper” to Cedar: finished.",
		needsAction: false,
		autonomyFeedback: {
			eventId: events[0]!.id,
			classId: "delegation:multi_hop_read",
		},
	});
	expect(fyi?.decision).toBeUndefined();
});

describe("attempt result projections", () => {
	const startedAt = "2026-10-17T11:00:00.000Z";
	const diagnostic =
		"Failed: Attempt failed without a reported reason; inspect its run history.";
	function attemptRow(
		extra: Partial<
			ReturnType<typeof WorkAttemptProjectionSchema.parse>["attempt"]
		> = {},
	) {
		return WorkAttemptProjectionSchema.parse({
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
				summary: null,
				startedAt,
				finishedAt: now.toISOString(),
				...extra,
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
	}

	it.each([
		["succeeded", true, false, "normal", "the work finished"],
		["failed", false, true, "high", "Didn't finish"],
		["expired", false, true, "low", "paused before finishing"],
		["cancelled", false, true, "low", "was stopped"],
	] as const)(
		"projects %s without changing the accepted Work disposition",
		(outcome, done, stalled, importance, fallback) => {
			for (const finishedAt of [now.toISOString(), null]) {
				const row = attemptRow({
					outcome,
					runtimeState: outcome === "succeeded" ? "finished" : outcome,
					finishedAt,
				});
				const result = ActivityFeedItemSchema.parse(resultFeedItems([row])[0]);
				expect(result).toMatchObject({
					id: `attempt:${row.attempt.id}`,
					kind: "result",
					classId: `external_agent:result:${outcome}`,
					done,
					stalled,
					importance,
					needsAction: false,
					source: `/work/items/${other}`,
					workItemId: other,
					projectId: project,
					at: finishedAt ?? startedAt,
					sentence: `Supplier review — ${fallback}.`,
					attachment: { title: "Supplier review" },
				});
				expect(row.workItem.disposition).toBe("accepted");
				expect(result.decision).toBeUndefined();
			}
		},
	);

	it("excludes unfinished Attempts even when they have a summary and feed sentence", () => {
		const unfinished = attemptRow({
			outcome: null,
			runtimeState: "running",
			finishedAt: null,
			summary: "The review is in progress.",
			metadata: { feedSentence: "The report is ready." },
		});
		const succeeded = attemptRow({
			outcome: "succeeded",
			runtimeState: "finished",
		});
		expect(resultFeedItems([unfinished])).toEqual([]);
		expect(resultFeedItems([unfinished, succeeded])).toEqual(
			resultFeedItems([succeeded]),
		);
	});

	it.each([
		[
			"The report is ready. Next steps follow.",
			diagnostic,
			"The report is ready.",
			undefined,
		],
		[
			"The report is ready. Next steps follow.",
			"The review finished. More detail.",
			"The report is ready.",
			"The review finished.",
		],
		[
			diagnostic,
			"Failed: The supplier is unavailable. Retry tomorrow.",
			"The supplier is unavailable.",
			"The supplier is unavailable.",
		],
		[
			"   ",
			"The supplier report is ready. Follow-up is pending.",
			"The supplier report is ready.",
			"The supplier report is ready.",
		],
		[
			42,
			"The supplier report is ready. Follow-up is pending.",
			"The supplier report is ready.",
			"The supplier report is ready.",
		],
		[diagnostic, diagnostic, "Supplier review — Didn't finish.", undefined],
		[null, null, "Supplier review — Didn't finish.", undefined],
	] as const)(
		"selects readable copy from feedSentence %j and summary %j",
		(feedSentence, summary, preview, attachmentSummary) => {
			const row = attemptRow({ metadata: { feedSentence }, summary });
			const result = ActivityFeedItemSchema.parse(resultFeedItems([row])[0]);
			expect(result.sentence).toBe(preview);
			expect(result.attachment?.summary).toBe(attachmentSummary);
			expect(result.sentence).not.toContain("inspect its run history");
		},
	);

	// Real Activity rows from before 2026-10-27: codes, ids and a red chip.
	it.each([
		[
			"Failed: partial_result\n\nDelegated tedi returned a partial result (reported_partial; The tedi reported a partial result). The Work Item remains incomplete. Recovery: continue or re-dispatch the same work order, then attach fresh terminal proof.",
			{ failureReason: "partial_result" },
			"Run the certification for draft",
			"Finished part of “Run the certification for draft” and needs you to check the rest.",
		],
		[
			"Failed: partial_result\n\nDelegated tedi reported Outcome: needs_follow_up. The Work Item remains incomplete. Outcome: needs_follow_up",
			{},
			"Copy skill 4f1c2a90-3b7d-4e21-9a55-0c8e7d6b1f42 (Reddit Operator) into the workspace",
			"Finished part of “Copy skill Reddit Operator into the workspace” and needs you to check the rest.",
		],
		[
			"Failed: partial_result\n\nCedar finished part of “Update the schedule” and needs you to check the rest. It stays open so it can be continued or sent again.",
			{
				failureReason: "partial_result",
				feedSentence:
					"Cedar finished part of “Update the schedule” and needs you to check the rest.",
			},
			"Update skill 7d2e9b14-6a03-4c8f-b1d2-5e9f0a3c8b67 with the new schedule",
			"Cedar finished part of “Update the schedule” and needs you to check the rest.",
		],
	] as const)(
		"turns a partial delegation into plain words and an amber outcome (%#)",
		(summary, metadata, title, headline) => {
			const row = attemptRow({ summary, metadata });
			row.workItem.title = title;
			const result = ActivityFeedItemSchema.parse(resultFeedItems([row])[0]);
			expect(result.sentence).toBe(headline);
			expect(result.resultOutcome).toBe("partial");
			const shown = [
				result.sentence,
				result.attachment?.title ?? "",
				result.attachment?.summary ?? "",
				result.explanation,
			].join("\n");
			expect(shown).not.toMatch(/[a-z]+_[a-z_]+|[0-9a-f]{8}-[0-9a-f]{4}/);
			expect(shown).not.toMatch(/Failed:|Delegated tedi/);
			expect(feedHeadlineIssues(result.sentence)).toEqual([]);
		},
	);

	it("keeps a real failure red and names it in words", () => {
		const row = attemptRow({
			summary:
				"Failed: delegation_failed\n\nDelegated tedi reported failure (provider_error; provider error sealed the turn).",
			metadata: { failureReason: "delegation_failed" },
		});
		const result = ActivityFeedItemSchema.parse(resultFeedItems([row])[0]);
		expect(result.resultOutcome).toBe("failed");
		expect(result.sentence).toBe("Supplier review — Didn't finish.");
	});

	it("bounds long first sentences in both the card and attachment", () => {
		const first = `The review ${"remains ready ".repeat(100)}`;
		for (const feedSentence of [null, `${first}. Hidden second sentence.`]) {
			const row = attemptRow({
				metadata: { feedSentence },
				summary: `${first}. Hidden second sentence.`,
			});
			const result = ActivityFeedItemSchema.parse(resultFeedItems([row])[0]);
			expect(result.sentence).toBe(first.slice(0, 1000));
			expect(result.attachment?.summary).toBe(first.slice(0, 300));
		}
	});

	it.each([
		["codex", "claude-code:previous", "Codex", "codex"],
		["claude-code", "codex:previous", "Claude", "claude-code"],
		["devin", "codex:previous", "Devin", "devin"],
		[null, "codex:current", "Codex", "codex"],
		[null, "claude-code:current", "Claude", "claude-code"],
		[null, null, "Project team", null],
	] as const)(
		"resolves harness %j ahead of session %j",
		(agentHarness, externalSessionKey, actor, harness) => {
			const row = attemptRow({
				metadata: agentHarness ? { agentHarness } : {},
				externalSessionKey,
				summary: diagnostic,
			});
			const result = resultFeedItems([row])[0]!;
			expect(result.actor).toBe(actor);
			expect(result.actorIdentity).toEqual({
				type: "external_agent",
				id: "pine-laptop",
				harness,
			});
			expect(result.tediId).toBeNull();
			expect(result.attachment?.summary).toBeUndefined();
		},
	);

	it("retains a tedi's identity for the result instead of assigning a coding agent", () => {
		const row = attemptRow({
			executorType: "tedi",
			executorId: project,
			externalSessionKey: null,
			metadata: {},
			outcome: "succeeded",
			runtimeState: "finished",
		});
		expect(resultFeedItems([row])[0]).toMatchObject({
			actor: "Tedi",
			actorIdentity: { type: "tedi", id: project, harness: null },
			tediId: project,
			classId: "tedi:result:succeeded",
			source: `/work/items/${other}`,
		});
	});
});

it("keeps a personal correction's recorded author for their photo lookup", async () => {
	const { correctionFeedItems } =
		await import("@tedix/api-contract/utils/activity-feed");
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
