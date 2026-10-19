import { describe, expect, it } from "vite-plus/test";
import {
	ActivityFeedConfigSchema,
	ActivityFeedItemSchema,
} from "@tedix/api-contract/schemas/os-activity-feed";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import { LearningInteractionEventSchema } from "@tedix/api-contract/schemas/learning-feedback";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import { EMPTY_FEED_PREFERENCES } from "@tedix/api-contract/utils/activity-feed";
import {
	everythingFeed,
	focusSelection,
	rankFocusFeed,
	focusFeedMetrics,
} from "@tedix/api-contract/utils/focus-feed";
const now = new Date("2030-01-01T12:00:00Z");
const project = "11111111-1111-4111-8111-111111111111";
const config = ActivityFeedConfigSchema.parse({
	version: 1,
	scope: "organization",
	projects: [],
});
const row = (id: string, extra: Record<string, unknown> = {}) =>
	ActivityFeedItemSchema.parse({
		id,
		actor: "Cedar",
		sentence: "Cedar finished the fictional supplier review.",
		source: `/work/items/${project}`,
		projectId: project,
		workItemId: project,
		tediId: null,
		kind: "result",
		classId: "supplier",
		importance: "normal",
		at: now.toISOString(),
		dueAt: null,
		needsAction: false,
		stalled: false,
		done: true,
		explanation: "Saved receipt",
		reactions: [],
		...extra,
	});
const event = (reaction: string, extra: Record<string, unknown> = {}) =>
	LearningInteractionEventSchema.parse({
		id: crypto.randomUUID(),
		organizationId: "fictional-cedar",
		actorId: "morgan",
		actorType: "user",
		tediId: null,
		clientEventId: crypto.randomUUID(),
		signalClass: "quality",
		eventKind: "answered",
		scopeKind: "personal",
		scopeId: "morgan",
		issueKey: "feed:supplier",
		surface: "focus_feed",
		targetType: "feed_item",
		targetId: "a",
		threadId: null,
		runId: null,
		occurredAt: now.toISOString(),
		createdAt: now.toISOString(),
		metadata: { reaction, classId: "supplier", ...extra },
	});
const model = (events: ReturnType<typeof event>[] = []) =>
	learnDecisions({
		organizationId: "fictional-cedar",
		personId: "morgan",
		events,
		config: DecisionLearningConfigSchema.parse({ enabled: true }),
		now,
	});
describe("Focus feed", () => {
	it("is deterministic under shuffled sources, duplicate identities and tied scores", () => {
		const items = [row("b"), row("a"), row("a")];
		expect(
			rankFocusFeed(items, config, EMPTY_FEED_PREFERENCES, now, model()).map(
				(i) => i.id,
			),
		).toEqual(["a", "b"]);
		expect(
			rankFocusFeed(
				items.reverse(),
				config,
				EMPTY_FEED_PREFERENCES,
				now,
				model(),
			).map((i) => i.id),
		).toEqual(["a", "b"]);
	});
	it("multiplies its six configured factors and decays urgency after expiry", () => {
		const rows = rankFocusFeed(
			[
				row("soon", {
					dueAt: "2030-01-01T13:00:00Z",
					done: false,
					needsAction: true,
				}),
				row("expired", {
					dueAt: "2029-12-30T12:00:00Z",
					done: false,
					needsAction: true,
				}),
			],
			config,
			EMPTY_FEED_PREFERENCES,
			now,
			model(),
		);
		expect(rows[0]!.id).toBe("soon");
		const f = rows[0]!.factors;
		expect(rows[0]!.score).toBeCloseTo(
			(f.urgency! * f.importance! * f.value! * f.continuity! * f.freshness!) /
				f.attentionCost!,
		);
	});
	it("Everything keeps hidden, muted, quiet and similar outcomes and pending decisions", () => {
		const items = [
			row("a"),
			row("b"),
			row("choice", { kind: "decision", needsAction: true, done: false }),
			row("quiet", { importance: "low" }),
		];
		const prefs = {
			...EMPTY_FEED_PREFERENCES,
			hiddenIds: ["a"],
			mutedClasses: ["supplier"],
		};
		expect(rankFocusFeed(items, config, prefs, now, model())).toHaveLength(0);
		expect(everythingFeed(items, config).map((i) => i.id)).toEqual([
			"a",
			"b",
			"choice",
			"quiet",
		]);
		expect(
			everythingFeed(
				[...items, row("unsafe", { source: "javascript:alert(1)" })],
				config,
			),
		).toHaveLength(4);
	});
	it("uses durable daily reservations, never adds a fourth item, and resets by configured day", () => {
		const ranked = rankFocusFeed(
			Array.from({ length: 12 }, (_, i) => row(String(i))),
			config,
			EMPTY_FEED_PREFERENCES,
			now,
			model(),
		);
		const first = focusSelection(ranked, [], now, model(), true);
		expect(first.selected).toHaveLength(3);
		const p = {
			...EMPTY_FEED_PREFERENCES,
			budgetDay: "2030-01-01",
			shownIds: ["old1", "old2", "old3"],
		};
		expect(
			focusSelection(ranked, [], now, model(), true, p).selected,
		).toHaveLength(0);
		expect(
			focusSelection(
				ranked,
				[],
				new Date("2030-01-02T12:00:00Z"),
				model(),
				true,
				p,
			).selected,
		).toHaveLength(3);
	});
	it("learns every named signal, excludes another person's and another org's events", () => {
		for (const signal of [
			"open",
			"dwell",
			"expand_receipt",
			"pin",
			"hide",
			"not_important",
			"tell_me_earlier",
			"jump_then_decide",
			"ignored_twice",
		]) {
			const e = event(signal);
			const m = model([e]);
			expect(
				m.weights.personal.find((w) => w.key === "class:supplier")?.value,
			).not.toBe(0);
		}
		const other = { ...event("pin"), organizationId: "fictional-maple" };
		const person = { ...event("pin"), scopeId: "someone-else" };
		expect(model([other, person]).eventCount).toBe(0);
	});
	it("raises a touched thread with a truthful continuity reason and increases ignored attention cost", () => {
		const history = [
			event("open", { source: `/work/items/${project}` }),
			event("ignored_twice"),
		];
		const ranked = rankFocusFeed(
			[row("a")],
			config,
			EMPTY_FEED_PREFERENCES,
			now,
			model(history),
			history,
		);
		expect(ranked[0]!.because).toBe("because you opened this thread");
		expect(ranked[0]!.factors.attentionCost).toBeGreaterThan(1.5);
	});
	it("reports null baselines for zero denominators, and separates fold cohorts", () => {
		expect(focusFeedMetrics([]).notImportant.rate).toBeNull();
		const metrics = focusFeedMetrics([
			event("impression", {
				aboveFold: true,
				sessionId: "visit",
				needsAction: true,
			}),
			event("open", {
				aboveFold: true,
				sessionId: "visit",
				needsAction: true,
				elapsedMs: 59000,
			}),
			event("not_important"),
		]);
		expect(metrics.decisionsWithinMinute.rate).toBe(1);
		expect(metrics.aboveFold).toEqual({ items: 1, opens: 1 });
		expect(metrics.belowFold).toEqual({ items: 0, opens: 0 });
	});
});

it("uses configured ranking exponents instead of fixed code weights", () => {
	const items = [
		row("old-important", {
			importance: "critical",
			at: "2029-12-31T12:00:00Z",
		}),
		row("new-quiet", { importance: "low" }),
	];
	const policy = model();
	expect(
		rankFocusFeed(items, config, EMPTY_FEED_PREFERENCES, now, policy)[0]!.id,
	).toBe("old-important");
	policy.config.focusFeed.weights.freshness = 10;
	expect(
		rankFocusFeed(items, config, EMPTY_FEED_PREFERENCES, now, policy)[0]!.id,
	).toBe("new-quiet");
});
