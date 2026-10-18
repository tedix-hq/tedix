import type { DecisionLearningModel } from "@tedix/api-contract/schemas/decision-learning";
import { scoreLearning } from "@tedix/api-contract/utils/decision-learning";
import type {
	ActivityFeedConfig,
	ActivityFeedItem,
} from "@tedix/api-contract/schemas/os-activity-feed";
import type {
	WorkActivityEvent,
	WorkAttemptProjectionSchema,
} from "@tedix/api-contract/schemas/work-items";
import type { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import type { WorkApprovalInboxRowSchema } from "@tedix/api-contract/schemas/work-approvals";
import type { LearningInteractionEvent } from "@tedix/api-contract/schemas/learning-feedback";
import type { OsUserPreferences } from "@tedix/api-contract/schemas/user-settings";
import type * as z from "zod";
import { OS_COPY } from "@/shared/os-copy";
import { decisionEnvelope } from "@/lib/decision-deck";

const actors: Record<string, string> = OS_COPY.feed.actors;
const workEvents: Record<string, string> = OS_COPY.feed.workEvents;

export type FeedPreferences = NonNullable<OsUserPreferences["activityFeed"]>;
export const EMPTY_FEED_PREFERENCES: FeedPreferences = {
	projectIds: [],
	mutedClasses: [],
	preferredClasses: [],
	lastSeenAt: null,
};
const reactions: ActivityFeedItem["reactions"] = [
	"more",
	"why",
	"mute",
	"comment",
	"work",
];
export function sentence(text: string) {
	const plain = text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\d+[.)]\s+/, "");
	const first = new Intl.Segmenter(undefined, { granularity: "sentence" })
		.segment(plain)
		[Symbol.iterator]()
		.next().value?.segment;
	return (first ?? plain).trim().slice(0, 1000);
}
export function workSource(id: string) {
	return `/work/items/${id}`;
}

function base(
	id: string,
	at: string,
	projectId: string | null,
	workItemId: string | null,
): ActivityFeedItem {
	return {
		id,
		at,
		projectId,
		workItemId,
		tediId: null,
		actor: "Tedix",
		sentence: "",
		source: workItemId ? workSource(workItemId) : "",
		kind: "work",
		classId: "work",
		importance: "normal",
		dueAt: null,
		needsAction: false,
		stalled: false,
		done: false,
		explanation: "",
		reactions,
	};
}

export function workFeedItems(
	events: WorkActivityEvent[],
	projectId: string,
): ActivityFeedItem[] {
	return events
		.filter(
			(e) =>
				!/heartbeat|lease.renewed|^attempt\.(settled|finished)$/.test(
					e.eventType,
				),
		)
		.map((e) => ({
			...base(`work:${e.id}`, e.createdAt, projectId, e.workItemId),
			actor:
				actors[e.agentHarness ?? e.authorType] ?? OS_COPY.feed.actors.system,
			sentence: sentence(
				e.body !== e.eventType &&
					e.body.length <= 180 &&
					/\p{L}/u.test(sentence(e.body)) &&
					!/[`\n]|https?:|[a-f\d]{8,}|(?:session|codex|claude-code)\s*(?:·|waiting:)|\b(?:SHA|D1|Attempt)\b/i.test(
						e.body,
					)
					? e.body
					: `${e.workItemTitle} ${workEvents[e.eventType] ?? OS_COPY.feed.workUpdated}.`,
			),
			classId: `work:${e.eventType}`.slice(0, 100),
			done: ["completed", "cancelled"].includes(e.workItemDisposition),
			stalled: /blocked|expired|failed/.test(e.eventType),
			importance: /blocked|failed/.test(e.eventType)
				? "high"
				: /comment|created/.test(e.eventType)
					? "low"
					: "normal",
			explanation: [
				e.body === e.eventType ? null : e.body,
				OS_COPY.feed.workExplanation,
			]
				.filter(Boolean)
				.join("\n\n"),
		}));
}

export function resultFeedItems(
	rows: z.infer<typeof WorkAttemptProjectionSchema>[],
): ActivityFeedItem[] {
	return rows
		.filter((r) => r.attempt.outcome !== null)
		.map(({ attempt: a, workItem: w }) => ({
			...base(
				`attempt:${a.id}`,
				a.finishedAt ?? a.startedAt,
				w.projectId,
				w.id,
			),
			kind: "result",
			classId: `${a.executorType}:result`,
			actor:
				a.executorType === "tedi"
					? "Tedi"
					: a.externalSessionKey?.startsWith("claude")
						? "Claude"
						: a.externalSessionKey?.startsWith("codex")
							? "Codex"
							: OS_COPY.feed.actors.external_agent,
			tediId: a.executorType === "tedi" ? a.executorId : null,
			sentence: sentence(
				typeof a.metadata.feedSentence === "string" &&
					/\p{L}/u.test(sentence(a.metadata.feedSentence))
					? a.metadata.feedSentence
					: `${w.title} — ${OS_COPY.feed.outcomes[a.outcome as keyof typeof OS_COPY.feed.outcomes] ?? OS_COPY.feed.workUpdated}.`,
			),
			importance:
				a.outcome === "failed"
					? "high"
					: a.outcome === "succeeded"
						? "normal"
						: "low",
			stalled: a.outcome !== "succeeded",
			done: a.outcome === "succeeded",
			explanation: [a.summary, OS_COPY.feed.resultExplanation]
				.filter(Boolean)
				.join("\n\n"),
		}));
}

export function decisionFeedItems(
	rows: z.infer<typeof WorkInteractionInboxRowSchema>[],
): ActivityFeedItem[] {
	return rows.map(({ request: r, effectiveState, workItem, askedBy }) => {
		const decision = decisionEnvelope(r.metadata);
		return {
			...base(
				`decision:${r.id}`,
				r.resolvedAt ?? r.requestedAt,
				r.projectId ?? workItem?.projectId ?? null,
				r.workItemId,
			),
			kind: "decision",
			classId:
				decision?.classId ??
				(typeof r.metadata?.decisionClass === "string"
					? r.metadata.decisionClass
					: r.kind),
			actor: askedBy ?? "Tedi",
			tediId:
				typeof r.metadata?.proposerTediId === "string"
					? r.metadata.proposerTediId
					: null,
			sentence: sentence(decision?.proposal ?? r.subject),
			source: `/work/interactions/${r.id}`,
			needsAction: effectiveState === "open",
			done: effectiveState !== "open",
			dueAt: r.dueAt,
			importance: effectiveState === "open" ? "high" : "normal",
			explanation: decision?.reasoning ?? r.prompt,
			decision: decision ?? undefined,
		};
	});
}

export function approvalFeedItems(
	rows: z.infer<typeof WorkApprovalInboxRowSchema>[],
): ActivityFeedItem[] {
	return rows.map(({ proposal: p, effectiveStatus, workItem: w }) => ({
		...base(
			`approval:${p.id}`,
			p.resolvedAt ?? p.requestedAt,
			w.projectId,
			w.id,
		),
		kind: "approval",
		classId: `approval:${p.action}`,
		actor: "Approval",
		sentence: sentence(
			`${w.title}: ${effectiveStatus === "pending" ? p.requestRationale : effectiveStatus}`,
		),
		needsAction: effectiveStatus === "pending",
		done: effectiveStatus !== "pending",
		dueAt: p.expiresAt,
		importance: effectiveStatus === "pending" ? "high" : "normal",
		explanation: p.requestRationale,
	}));
}

export function correctionFeedItems(
	events: LearningInteractionEvent[],
): ActivityFeedItem[] {
	return events
		.filter(
			(e) =>
				e.eventKind === "edited" &&
				typeof e.metadata?.answer === "string" &&
				(typeof e.metadata?.source === "string" ||
					e.targetType === "work_interaction"),
		)
		.map((e) => ({
			...base(
				`correction:${e.id}`,
				e.occurredAt,
				typeof e.metadata?.projectId === "string" ? e.metadata.projectId : null,
				typeof e.metadata?.workItemId === "string"
					? e.metadata.workItemId
					: null,
			),
			kind: "correction",
			classId: "correction",
			actor: "You",
			sentence: sentence(String(e.metadata?.answer)),
			source:
				typeof e.metadata?.source === "string"
					? e.metadata.source
					: `/work/interactions/${e.targetId}`,
			explanation: OS_COPY.feed.correctionExplanation,
		}));
}

export function safeSource(source: string): boolean {
	return (
		/^\/(?!\/)[^\\\s]*$/.test(source) || /^https?:\/\/[^\s]+$/.test(source)
	);
}

/** Explainable personal rank, recomputed as time passes; recency only breaks ties. */
export function rankFeed(
	items: ActivityFeedItem[],
	config: ActivityFeedConfig,
	prefs: FeedPreferences,
	now: Date,
	model?: DecisionLearningModel,
) {
	const allowed = new Set(config.projects.map((p) => p.id));
	const seen = new Set<string>();
	return items
		.filter((item) => {
			if (!safeSource(item.source) || !item.sentence || seen.has(item.id))
				return false;
			seen.add(item.id);
			if (
				item.projectId &&
				(!allowed.has(item.projectId) ||
					(prefs.projectIds.length > 0 &&
						!prefs.projectIds.includes(item.projectId)))
			)
				return false;
			return (
				!prefs.mutedClasses.includes(item.classId) ||
				item.needsAction ||
				item.importance === "critical"
			);
		})
		.map((item) => {
			const deadline =
				item.dueAt && !item.done
					? Math.max(
							0,
							Math.min(
								2,
								1 - (Date.parse(item.dueAt) - now.getTime()) / 86_400_000,
							),
						)
					: 0;
			const unseen = !prefs.lastSeenAt || item.at > prefs.lastSeenAt;
			const importance = { low: 0, normal: 1, high: 2, critical: 3 }[
				item.importance
			];
			const score =
				importance * config.weights.importance +
				Number(item.needsAction) * config.weights.action +
				deadline * config.weights.deadline +
				Number(unseen) * config.weights.unseen +
				Number(prefs.preferredClasses.includes(item.classId)) *
					config.weights.preference;
			const learned = model
				? scoreLearning(
						{
							id: item.id,
							classId: item.classId,
							text: item.sentence,
							projectId: item.projectId,
							tediId: item.tediId,
							source: item.source,
							dueAt: item.done ? null : item.dueAt,
							protected: item.needsAction || item.importance === "critical",
							lessons: item.decision?.lessons.map((l) => ({
								...l,
								classId: item.classId,
								text: item.sentence,
							})),
						},
						model,
						now,
					)
				: null;
			const why = learned?.factors
				.map((f) => `${f.reason} [${f.evidenceIds.join(", ")}]`)
				.join("; ");
			return {
				...item,
				explanation: [
					item.explanation,
					why,
					learned?.lessonIds.length
						? `Lessons: ${learned.lessonIds.join(", ")}`
						: "",
				]
					.filter(Boolean)
					.join("\n"),
				score: score + (learned?.score ?? 0),
				unseen,
				deadline: deadline > 0,
			};
		})
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.at.localeCompare(a.at) ||
				b.id.localeCompare(a.id),
		);
}

export function quietNow(config: ActivityFeedConfig, hour: number) {
	const q = config.quietHours;
	return (
		!!q &&
		(q.start < q.end
			? hour >= q.start && hour < q.end
			: hour >= q.start || hour < q.end)
	);
}

export function feedLearningInput(
	item: ActivityFeedItem,
	reaction: "more" | "mute" | "comment" | "why" | "work" | "ignore",
	text: string,
	clientEventId: string,
) {
	return {
		clientEventId,
		eventKind:
			reaction === "ignore"
				? ("ignored" as const)
				: reaction === "comment"
					? ("edited" as const)
					: reaction === "why"
						? ("answered" as const)
						: reaction === "more" || reaction === "work"
							? ("accepted" as const)
							: ("rejected" as const),
		scope: { kind: "personal" as const },
		surface: "activity_feed",
		issueKey: `feed:${item.classId}`,
		targetType: "feed_item",
		targetId: item.id,
		metadata: {
			reaction,
			classId: item.classId,
			proposerTediId: item.tediId,
			source: item.source,
			projectId: item.projectId,
			workItemId: item.workItemId,
			...(reaction === "comment"
				? {
						answer: text,
						question: { tail: item.sentence },
						draft: { body: item.sentence },
						scope: { repo: "general", harness: "os", topic: item.classId },
					}
				: {}),
		},
	};
}
