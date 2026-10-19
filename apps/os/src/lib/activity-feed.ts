import { cardIsDue } from "@/lib/card-schedule";
import { sessionHarness, workActorReference } from "@/lib/work-actor";
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
	projectId: string | null,
	names: ReadonlyMap<string, string> = new Map(),
): ActivityFeedItem[] {
	const actors: Record<string, string> = OS_COPY.feed.actors;
	const workEvents: Record<string, string> = OS_COPY.feed.workEvents;
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
				e.personalAgentContribution?.sourceAgentName ??
				(e.authorType === "external_agent"
					? actors[e.agentHarness ?? ""]
					: undefined) ??
				names.get(`${e.authorType}:${e.authorId}`) ??
				actors[e.authorType] ??
				OS_COPY.feed.actors.system,
			actorIdentity: {
				type: e.authorType,
				id: e.authorId,
				harness: e.agentHarness,
				...(e.personalAgentContribution
					? {
							contributor: {
								id: e.personalAgentContribution.sourceAgentId,
								displayName: e.personalAgentContribution.sourceAgentName,
								representedUserId:
									e.personalAgentContribution.representedUserId,
							},
							source: {
								channel: e.personalAgentContribution.sourceChannel,
								capturedAt: e.personalAgentContribution.capturedAt,
								evidenceUrl: e.personalAgentContribution.evidenceUrl,
								externalFindingId:
									e.personalAgentContribution.externalFindingId,
							},
						}
					: {}),
			},
			tediId: e.authorType === "tedi" ? e.authorId : null,
			personalAgentContribution: e.personalAgentContribution,
			kind: e.personalAgentContribution?.kind === "fyi" ? "signal" : "work",
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
			importance: e.personalAgentContribution
				? "normal"
				: /blocked|failed/.test(e.eventType)
					? "high"
					: "low",
			explanation: [
				e.personalAgentContribution
					? `From ${e.personalAgentContribution.sourceAgentName}, for you. ${e.personalAgentContribution.kind === "fyi" ? "FYI" : "Proposal"}; no action executed. Source: ${e.personalAgentContribution.evidenceUrl}`
					: null,
				e.body === e.eventType ? null : e.body,
				OS_COPY.feed.workExplanation,
			]
				.filter(Boolean)
				.join("\n\n"),
		}));
}

function outcomeSummary(value: unknown) {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		/attempt failed without a reported reason|inspect its run history/i.test(
			value,
		)
	)
		return undefined;
	return sentence(value.replace(/^failed:\s*/i, ""));
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
			classId: `${a.executorType}:result:${a.outcome}`,
			actor:
				a.executorType === "tedi"
					? OS_COPY.feed.actors.tedi
					: sessionHarness(a.metadata.agentHarness, a.externalSessionKey) ===
						  "claude-code"
						? "Claude"
						: sessionHarness(a.metadata.agentHarness, a.externalSessionKey) ===
							  "codex"
							? "Codex"
							: OS_COPY.feed.actors.external_agent,
			actorIdentity: workActorReference(
				a.executorType,
				a.executorId,
				a.metadata,
				a.externalSessionKey,
			),
			tediId: a.executorType === "tedi" ? a.executorId : null,
			sentence: sentence(
				outcomeSummary(a.metadata.feedSentence) ??
					outcomeSummary(a.summary) ??
					`${w.title} — ${a.outcome === "failed" || a.outcome === "expired" ? "Didn't finish" : (OS_COPY.feed.outcomes[a.outcome as keyof typeof OS_COPY.feed.outcomes] ?? OS_COPY.feed.workUpdated)}.`,
			),
			attachment: {
				title: w.title.slice(0, 200),
				summary: outcomeSummary(a.summary)?.slice(0, 300),
			},
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
	now = new Date(),
	timeZone?: string,
): ActivityFeedItem[] {
	return rows
		.filter(
			(row) =>
				row.effectiveState !== "open" || cardIsDue(row.request, now, timeZone),
		)
		.map(({ request: r, effectiveState, workItem, askedBy }) => {
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
	now = new Date(),
	timeZone?: string,
): ActivityFeedItem[] {
	return rows
		.filter(
			(row) =>
				row.effectiveStatus !== "pending" ||
				cardIsDue(row.proposal, now, timeZone),
		)
		.map(({ proposal: p, effectiveStatus, workItem: w }) => ({
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
			actorIdentity: { type: e.actorType, id: e.actorId },
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
				((config.scope !== "organization" && !allowed.has(item.projectId)) ||
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
