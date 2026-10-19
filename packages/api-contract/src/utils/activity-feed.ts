import { cardIsDue } from "./card-schedule";
import type { WorkActorReference } from "../schemas/os-work-actor";
function sessionHarness(harness: unknown, sessionKey?: string | null) {
	return typeof harness === "string" && harness
		? harness
		: (sessionKey?.split(":")[0] ?? null);
}
function workActorReference(
	type: string,
	id: string | null | undefined,
	metadata: Record<string, unknown> = {},
	sessionKey?: string | null,
): WorkActorReference {
	return {
		type,
		id,
		harness: sessionHarness(
			metadata.agentHarness ?? metadata.host,
			sessionKey ??
				(typeof metadata.agentSession === "string"
					? metadata.agentSession
					: null),
		),
	};
}
import type { DecisionLearningModel } from "../schemas/decision-learning";
import { scoreLearning } from "./decision-learning";
import type {
	ActivityFeedConfig,
	ActivityFeedItem,
} from "../schemas/os-activity-feed";
import type {
	WorkActivityEvent,
	WorkAttemptProjectionSchema,
} from "../schemas/work-items";
import type { WorkInteractionInboxRowSchema } from "../schemas/work-interactions";
import type { WorkApprovalInboxRowSchema } from "../schemas/work-approvals";
import type { LearningInteractionEvent } from "../schemas/learning-feedback";
import type { OsUserPreferences } from "../schemas/user-settings";
import type * as z from "zod";
export interface FeedCopy {
	actors: Record<string, string>;
	workEvents: Record<string, string>;
	outcomes: Record<string, string>;
	workUpdated: string;
	workExplanation: string;
	resultExplanation: string;
	correctionExplanation: string;
}
export const DEFAULT_FEED_COPY: FeedCopy = {
	actors: {
		user: "Person",
		tedi: "Tedi",
		external_agent: "Project team",
		codex: "Codex",
		devin: "Devin",
		"claude-code": "Claude",
		system: "Tedix",
	},
	workEvents: {
		"work.created": "was proposed",
		"work.accepted": "was accepted",
		"work.completed": "was completed",
		"work.cancelled": "was cancelled",
		"work.specification_updated": "was updated",
		"attempt.started": "started",
		"attempt.expired": "needs a fresh attempt",
		"attempt.failed": "needs another look",
	},
	outcomes: {
		succeeded: "the work finished",
		failed: "needs another look",
		expired: "paused before finishing",
		cancelled: "was stopped",
	},
	workUpdated: "was updated",
	workExplanation: "Recorded in the linked Work history.",
	resultExplanation: "The linked attempt records this outcome.",
	correctionExplanation:
		"Your correction is recorded for reflection into personal lessons.",
};
import { DecisionEnvelopeSchema } from "../schemas/os-decision-deck";
function decisionEnvelope(
	metadata: Record<string, unknown> | null | undefined,
) {
	return DecisionEnvelopeSchema.safeParse(metadata?.decisionDeck).data ?? null;
}

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
	copy: FeedCopy = DEFAULT_FEED_COPY,
): ActivityFeedItem[] {
	const actors: Record<string, string> = copy.actors;
	const workEvents: Record<string, string> = copy.workEvents;
	return events
		.filter(
			(e) =>
				!/heartbeat|lease.renewed|^attempt\.(settled|finished)$/.test(
					e.eventType,
				),
		)
		.map((e) => ({
			...base(`work:${e.id}`, e.createdAt, projectId, e.workItemId),
			...(e.delegationFyi
				? {
						autonomyFeedback: {
							eventId: e.id,
							classId: e.delegationFyi.classId,
						},
					}
				: {}),
			actor:
				e.personalAgentContribution?.sourceAgentName ??
				(e.authorType === "external_agent"
					? actors[e.agentHarness ?? ""]
					: undefined) ??
				names.get(`${e.authorType}:${e.authorId}`) ??
				actors[e.authorType] ??
				copy.actors.system ??
				"Tedix",
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
			tediId:
				e.delegationFyi?.tediId ??
				(e.authorType === "tedi" ? e.authorId : null),
			personalAgentContribution: e.personalAgentContribution,
			kind: e.personalAgentContribution?.kind === "fyi" ? "signal" : "work",
			sentence: sentence(
				e.delegationFyi
					? `Delegated “${e.delegationFyi.task.slice(0, 100)}” to ${e.delegationFyi.tediName}: ${e.delegationFyi.outcome}.`
					: e.body !== e.eventType &&
						  e.body.length <= 180 &&
						  /\p{L}/u.test(sentence(e.body)) &&
						  !/[`\n]|https?:|[a-f\d]{8,}|(?:session|codex|claude-code)\s*(?:·|waiting:)|\b(?:SHA|D1|Attempt)\b/i.test(
								e.body,
						  )
						? e.body
						: `${e.workItemTitle} ${workEvents[e.eventType] ?? copy.workUpdated}.`,
			),
			classId: (e.delegationFyi?.classId ?? `work:${e.eventType}`).slice(
				0,
				100,
			),
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
				copy.workExplanation,
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
	copy: FeedCopy = DEFAULT_FEED_COPY,
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
					? (copy.actors.tedi ?? "Tedi")
					: sessionHarness(a.metadata.agentHarness, a.externalSessionKey) ===
						  "claude-code"
						? "Claude"
						: sessionHarness(a.metadata.agentHarness, a.externalSessionKey) ===
							  "codex"
							? "Codex"
							: sessionHarness(
										a.metadata.agentHarness,
										a.externalSessionKey,
								  ) === "devin"
								? "Devin"
								: (copy.actors.external_agent ?? "Project team"),
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
					`${w.title} — ${a.outcome === "failed" || a.outcome === "expired" ? "Didn't finish" : (copy.outcomes[a.outcome as keyof typeof copy.outcomes] ?? copy.workUpdated)}.`,
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
			explanation: [a.summary, copy.resultExplanation]
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
	copy: FeedCopy = DEFAULT_FEED_COPY,
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
			explanation: copy.correctionExplanation,
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
