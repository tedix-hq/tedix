import type {
	ActivityFeedConfig,
	ActivityFeedItem,
} from "../schemas/os-activity-feed";
import {
	DecisionLearningConfigSchema,
	type DecisionLearningModel,
} from "../schemas/decision-learning";
import type { LearningInteractionEvent } from "../schemas/learning-feedback";
import { safeSource, type FeedPreferences } from "./activity-feed";
import { calendarDay } from "./card-schedule";

export type FocusSignal =
	| "open"
	| "dwell"
	| "expand_receipt"
	| "pin"
	| "hide"
	| "not_important"
	| "tell_me_earlier"
	| "jump_then_decide"
	| "ignored_twice"
	| "impression";
export type FocusItem = ActivityFeedItem & {
	score: number;
	unseen: boolean;
	deadline: boolean;
	because?: string;
	factors: Record<string, number>;
};

export const FOCUS_HISTORY_SURFACES = [
	"focus_feed",
	"activity_feed",
	"decision_capture",
	"decision_deck",
	"work_outcome",
	"outbound_outcome",
	"decision_edit_preference",
];

/** Canonical identity deduplication only: Everything never drops similar outcomes or muted classes. */
export function everythingFeed(
	items: readonly ActivityFeedItem[],
	config: ActivityFeedConfig,
) {
	const allowed = new Set(config.projects.map((p) => p.id));
	const sorted = [...items]
		.filter(
			(i) =>
				safeSource(i.source) &&
				i.sentence &&
				Number.isFinite(Date.parse(i.at)) &&
				(config.scope === "organization" ||
					!i.projectId ||
					allowed.has(i.projectId)),
		)
		.sort(
			(a, b) =>
				b.at.localeCompare(a.at) ||
				a.id.localeCompare(b.id) ||
				Number(!a.projectId) - Number(!b.projectId) ||
				JSON.stringify(a).localeCompare(JSON.stringify(b)),
		);
	const seen = new Set<string>();
	return sorted.filter((item) => {
		if (seen.has(item.id)) return false;
		seen.add(item.id);
		return true;
	});
}
export function focusDay(at: string, timezone: string) {
	return calendarDay(new Date(at), timezone);
}
function latestSignal(events: readonly LearningInteractionEvent[], id: string) {
	return [...events]
		.filter(
			(e) =>
				e.targetId === id &&
				["pin", "hide", "not_important", "open"].includes(
					String(e.metadata?.reaction),
				),
		)
		.sort(
			(a, b) =>
				b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id),
		)[0]?.metadata?.reaction;
}
export function rankFocusFeed(
	items: readonly ActivityFeedItem[],
	config: ActivityFeedConfig,
	prefs: FeedPreferences,
	now: Date,
	model?: DecisionLearningModel,
	history: readonly LearningInteractionEvent[] = [],
) {
	const policy = (model?.config ?? DecisionLearningConfigSchema.parse({}))
		.focusFeed;
	const weights = model?.config.weights;
	const learned = (
		level:
			| "personal"
			| "priority"
			| "usefulness"
			| "urgency"
			| "organization"
			| "time",
		keys: string[],
	) =>
		model?.config.enabled
			? Math.exp(
					(model.weights[level]
						.filter((w) => keys.includes(w.key))
						.reduce((s, w) => s + w.value, 0) *
						(weights?.[level === "urgency" ? "urgencyLearning" : level] ?? 0)) /
						100,
				)
			: 1;
	return everythingFeed(items, config)
		.filter(
			(i) =>
				!["hide", "not_important"].includes(
					String(latestSignal(history, i.id)),
				) &&
				!prefs.hiddenIds?.includes(i.id) &&
				!prefs.mutedClasses.includes(i.classId) &&
				(!prefs.projectIds.length ||
					!i.projectId ||
					prefs.projectIds.includes(i.projectId)),
		)
		.map((item): FocusItem => {
			const ageHours = Math.max(
				0,
				(now.getTime() - Date.parse(item.at)) / 3600000,
			);
			const dueHours = item.dueAt
				? (Date.parse(item.dueAt) - now.getTime()) / 3600000
				: NaN;
			const urgency =
				(Number.isFinite(dueHours) && !item.done
					? dueHours < 0
						? Math.pow(0.5, -dueHours / policy.deadlineWindowHours)
						: 1 +
							Math.max(0, 1 - dueHours / policy.deadlineWindowHours) *
								policy.actionUrgency
					: 1 + Number(item.needsAction) * policy.actionUrgency) *
				learned("urgency", [`class:${item.classId}`]);
			const touch = [...history]
				.filter(
					(e) =>
						e.scopeKind === "personal" &&
						["accepted", "answered", "edited", "completed_elsewhere"].includes(
							e.eventKind,
						) &&
						e.surface !== "focus_feed_counterfactual" &&
						e.metadata?.reaction !== "impression" &&
						e.metadata?.reaction !== "dwell" &&
						((item.workItemId && e.metadata?.workItemId === item.workItemId) ||
							e.metadata?.source === item.source),
				)
				.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
			const ignores = history.filter(
				(e) =>
					e.surface === "focus_feed" &&
					e.metadata?.classId === item.classId &&
					e.metadata?.reaction === "ignored_twice",
			).length;
			const factors = {
				urgency,
				importance:
					policy.importance[item.importance] *
					Math.max(
						1,
						...(item.decision?.protectedEffects ?? []).map(
							(effect) => policy.stakes[effect] ?? 1,
						),
					) *
					learned("priority", [`project:${item.projectId}`]),
				value:
					(1 +
						Number(item.kind === "result" || !!item.attachment) *
							policy.receiptValue) *
					learned("usefulness", [`class:${item.classId}`]) *
					learned("organization", [`class:${item.classId}`]) *
					learned("time", [
						`hour:${new Intl.DateTimeFormat("en", { hour: "numeric", hourCycle: "h23", timeZone: model?.config.timezone ?? "UTC" }).format(now)}:class:${item.classId}`,
					]),
				continuity:
					(1 + Number(!!touch) * policy.continuityBoost) *
					learned("personal", [`class:${item.classId}`]),
				freshness: Math.pow(0.5, ageHours / policy.halfLifeHours),
				attentionCost:
					1 +
					item.sentence.split(/\s+/).length / policy.wordsPerMinute +
					ignores * policy.ignoredCost,
			};
			const score = Object.entries(factors).reduce(
				(s, [key, value]) =>
					key === "attentionCost"
						? s / Math.pow(value, policy.weights.attentionCost)
						: s *
							Math.pow(
								value,
								policy.weights[key as keyof typeof policy.weights],
							),
				1,
			);
			return {
				...item,
				score,
				factors,
				unseen: !prefs.lastSeenAt || item.at > prefs.lastSeenAt,
				deadline: Number.isFinite(dueHours),
				because: touch
					? `because you ${touch.eventKind === "edited" ? "changed" : touch.metadata?.reaction === "open" ? "opened" : "responded to"} this thread`
					: undefined,
			};
		})
		.sort(
			(a, b) =>
				Number(
					prefs.pinnedIds?.includes(b.id) ||
						latestSignal(history, b.id) === "pin",
				) -
					Number(
						prefs.pinnedIds?.includes(a.id) ||
							latestSignal(history, a.id) === "pin",
					) ||
				b.score - a.score ||
				b.at.localeCompare(a.at) ||
				a.id.localeCompare(b.id),
		);
}

/** The budget counts distinct items across today's saved impressions, including previous visits. */
export function focusSelection(
	ranked: FocusItem[],
	events: readonly LearningInteractionEvent[],
	now: Date,
	model?: DecisionLearningModel,
	hasToday = false,
	prefs?: FeedPreferences,
) {
	const config = model?.config ?? DecisionLearningConfigSchema.parse({});
	const day = focusDay(now.toISOString(), config.timezone);
	const critical = ranked.filter((item) => item.importance === "critical");
	const ordinary = ranked.filter((item) => item.importance !== "critical");
	const used = new Set(
		events
			.filter(
				(e) =>
					e.surface === "focus_feed" &&
					e.metadata?.reaction === "impression" &&
					e.metadata?.budgeted === true &&
					focusDay(e.occurredAt, config.timezone) === day,
			)
			.map((e) => e.targetId),
	);
	for (const id of prefs?.budgetDay === day ? (prefs.shownIds ?? []) : [])
		used.add(id);
	for (const item of critical) used.delete(item.id);
	let remaining = Math.max(0, config.focusFeed.dailyBudget - used.size);
	const selected: FocusItem[] = [];
	const priority = [
		...ordinary
			.filter((item) => item.needsAction)
			.slice(0, config.focusFeed.needsYouLimit),
		...ordinary,
	];
	for (const item of priority) {
		if (selected.some((row) => row.id === item.id)) continue;
		if (
			selected.length >=
			Math.min(5 - Number(hasToday), config.focusFeed.dailyBudget)
		)
			break;
		if (!used.has(item.id) && remaining <= 0) continue;
		if (item.needsAction && selected.filter((i) => i.needsAction).length >= 3)
			continue;
		selected.push(item);
		if (!used.has(item.id)) remaining--;
	}
	selected.unshift(...critical);
	const ids = new Set(selected.map((i) => i.id));
	return {
		selected,
		needs: selected.filter((i) => i.needsAction),
		updates: selected.filter((i) => !i.needsAction),
		held: ranked.filter((i) => !ids.has(i.id)),
		used: used.size,
		day,
	};
}
export function focusSignalInput(
	item: ActivityFeedItem,
	signal: FocusSignal,
	metadata: Record<string, string | number | boolean | null> = {},
) {
	return {
		clientEventId: crypto.randomUUID(),
		scope: { kind: "personal" as const },
		surface: "focus_feed",
		eventKind:
			signal === "impression"
				? ("delivered" as const)
				: signal === "ignored_twice"
					? ("ignored" as const)
					: ["hide", "not_important"].includes(signal)
						? ("rejected" as const)
						: ("answered" as const),
		issueKey: `feed:${item.classId}`,
		targetType: "feed_item",
		targetId: item.id,
		metadata: {
			reaction: signal,
			needsAction: item.needsAction,
			...(signal === "tell_me_earlier" ? { urgency: "now" } : {}),
			classId: item.classId,
			projectId: item.projectId,
			workItemId: item.workItemId,
			source: item.source,
			...metadata,
		},
	};
}

export function focusFeedMetrics(events: readonly LearningInteractionEvent[]) {
	const feed = events.filter(
		(e) =>
			e.surface === "focus_feed" &&
			(!e.metadata?.feedView || e.metadata.feedView === "for_you"),
	);
	const impressions = feed.filter((e) => e.metadata?.reaction === "impression");
	const jumps = feed.filter(
		(e) => e.metadata?.reaction === "open" && e.metadata?.needsAction === true,
	);
	const fast = jumps.filter(
		(e) =>
			typeof e.metadata?.elapsedMs === "number" && e.metadata.elapsedMs < 60000,
	);
	const decisionItems = new Set(
		impressions
			.filter((e) => e.metadata?.needsAction === true)
			.map((e) => `${e.metadata?.sessionId}:${e.targetId}`),
	);
	const reachedItems = new Set(
		fast
			.map((e) => `${e.metadata?.sessionId}:${e.targetId}`)
			.filter((key) => decisionItems.has(key)),
	);
	const opens = feed.filter((e) => e.metadata?.reaction === "open");
	const count = (above: boolean) => ({
		items: new Set(
			impressions
				.filter((e) => e.metadata?.aboveFold === above)
				.map((e) => `${e.metadata?.sessionId}:${e.targetId}`),
		).size,
		opens: opens.filter((e) => e.metadata?.aboveFold === above).length,
	});
	const important = feed.filter(
		(e) => e.metadata?.reaction === "not_important",
	);
	return {
		decisionsWithinMinute: {
			reached: reachedItems.size,
			total: decisionItems.size,
			rate: decisionItems.size ? reachedItems.size / decisionItems.size : null,
		},
		aboveFold: count(true),
		belowFold: count(false),
		notImportant: {
			count: important.length,
			impressions: impressions.length,
			rate: impressions.length ? important.length / impressions.length : null,
		},
	};
}
