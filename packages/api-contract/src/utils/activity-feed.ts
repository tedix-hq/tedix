import { cardIsDue } from "./card-schedule";
import { technicalCopyIssues } from "./decision-card-copy";
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
import type { PersonalAgentContribution } from "../schemas/personal-agent-inbound";
import {
	DeckCurationStateSchema,
	type DeckRetirementReason,
} from "../schemas/deck-curation";
import type { WorkApprovalInboxRowSchema } from "../schemas/work-approvals";
import type { DeckPipelineStatus } from "../schemas/deck-pipeline";
import { deckWeekOneVerdicts } from "./deck-pipeline";
import type { LearningInteractionEvent } from "../schemas/learning-feedback";
import type { OsUserPreferences } from "../schemas/user-settings";
import type * as z from "zod";
export interface FeedCopy {
	actors: Record<string, string>;
	workEvents: Record<string, string>;
	outcomes: Record<string, string>;
	workUpdated: string;
	/** Known outcome codes in people's words, for older stored text. */
	codes: Record<string, string>;
	partlyDone: (title: string) => string;
	delegationOutcomes: Record<string, string>;
	didntFinish: string;
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
	codes: {
		partial_result: "partly done",
		reported_partial: "partly done",
		needs_follow_up: "needs follow-up",
		delegation_failed: "didn't finish",
		stopped_without_output: "stopped before producing anything",
		completed_without_proof: "finished without proof",
		dispatch_timeout: "didn't start in time",
		dispatch_never_landed: "never started",
		delegation_cancelled: "was cancelled",
		context_ceiling: "ran out of room",
		step_ceiling: "ran out of steps",
		budget_exhausted: "ran out of budget",
		provider_error: "hit a model error",
		early_stop: "stopped early",
	},
	partlyDone: (title) =>
		`Finished part of “${title}” and needs you to check the rest.`,
	didntFinish: "Didn't finish",
	delegationOutcomes: {
		completed: "finished",
		failed: "didn't finish",
		canceled: "stopped",
	},
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
const UUID = "[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}";
const CODE = "[a-z][a-z0-9]*(?:_[a-z0-9]+)+";
const LEADING_CODE = new RegExp(
	`^\\s*(?:failed:\\s*)?${CODE}\\b[:.]?\\s*`,
	"i",
);
const CODE_ASIDE = new RegExp(`\\s*\\([^()]*\\b${CODE}\\b[^()]*\\)`, "gi");
const OUTCOME_CODE = new RegExp(`\\bOutcome:\\s*(${CODE})\\b`, "gi");
const NAMED_UUID = new RegExp(`\\b${UUID}\\s*\\(([^()]+)\\)`, "gi");
const BARE_UUID = new RegExp(`\\s*\\b${UUID}\\b`, "gi");
const ANY_CODE = new RegExp(`\\b${CODE}\\b`, "gi");

/**
 * People-facing Activity text: known outcome codes become words; ids and
 * other `snake_case` tokens are dropped. Older stored events still carry them,
 * so both the feed builders and the Activity card pass text through here.
 */
export function plainFeedText(
	text: string,
	copy: FeedCopy = DEFAULT_FEED_COPY,
) {
	const word = (code: string) => copy.codes[code.toLowerCase()] ?? "";
	return (
		text
			// "Failed: partial_result" or a bare leading code repeats the chip.
			.replace(LEADING_CODE, "")
			// "(reported_partial; The tedi reported …)" is a machine aside.
			.replace(CODE_ASIDE, "")
			.replace(OUTCOME_CODE, (_, code: string) => word(code))
			// "skill <id> (Reddit Operator)" names the record by its name.
			.replace(NAMED_UUID, "$1")
			.replace(BARE_UUID, "")
			.replace(ANY_CODE, word)
			.replace(/\(\s*\)/g, "")
			.replace(/\s+([.,;:!?…])/g, "$1")
			.replace(/\s{2,}/g, " ")
			.trim()
	);
}

/** Copy self-check: an Activity headline never shows ids or `snake_case` codes. */
export function feedHeadlineIssues(text: string) {
	return technicalCopyIssues(text);
}

/** A headline that still reads as machine output after cleaning is replaced. */
function plainHeadline(
	text: string | undefined,
	copy: FeedCopy,
): string | undefined {
	if (!text) return undefined;
	const plain = plainFeedText(text, copy);
	return plain && /\p{L}/u.test(plain) && !feedHeadlineIssues(plain).length
		? plain
		: undefined;
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

/**
 * The display identity of a server-stamped personal-agent contribution: the
 * agent, its configured logo, whom it represents and where the finding came from.
 */
export function personalAgentActorFields(c: PersonalAgentContribution) {
	return {
		contributor: {
			id: c.sourceAgentId,
			displayName: c.sourceAgentName,
			representedUserId: c.representedUserId,
			...(c.imageUrl ? { imageUrl: c.imageUrl } : {}),
		},
		source: {
			channel: c.sourceChannel,
			capturedAt: c.capturedAt,
			evidenceUrl: c.evidenceUrl,
			externalFindingId: c.externalFindingId,
		},
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
					? personalAgentActorFields(e.personalAgentContribution)
					: {}),
			},
			tediId:
				e.delegationFyi?.tediId ??
				(e.authorType === "tedi" ? e.authorId : null),
			personalAgentContribution: e.personalAgentContribution,
			kind: e.personalAgentContribution?.kind === "fyi" ? "signal" : "work",
			sentence: sentence(
				e.delegationFyi
					? plainFeedText(
							`Delegated “${plainFeedText(e.delegationFyi.task, copy).slice(0, 100)}” to ${
								plainFeedText(e.delegationFyi.tediName, copy) ||
								names.get(`tedi:${e.delegationFyi.tediId}`) ||
								copy.actors.tedi ||
								"Tedi"
							}: ${copy.delegationOutcomes[e.delegationFyi.outcome] ?? e.delegationFyi.outcome}.`,
							copy,
						)
					: e.body !== e.eventType &&
						  e.body.length <= 180 &&
						  /\p{L}/u.test(sentence(e.body)) &&
						  !/[`\n]|https?:|[a-f\d]{8,}|(?:session|codex|claude-code)\s*(?:·|waiting:)|\b(?:SHA|D1|Attempt)\b/i.test(
								e.body,
						  )
						? (plainHeadline(e.body, copy) ??
							`${plainFeedText(e.workItemTitle, copy) || e.workItemTitle} ${workEvents[e.eventType] ?? copy.workUpdated}.`)
						: `${plainFeedText(e.workItemTitle, copy) || e.workItemTitle} ${workEvents[e.eventType] ?? copy.workUpdated}.`,
			),
			classId: (e.delegationFyi?.classId ?? `work:${e.eventType}`).slice(
				0,
				100,
			),
			done: ["completed", "cancelled"].includes(e.workItemDisposition),
			stalled: /blocked|expired|failed/.test(e.eventType),
			importance: e.personalAgentContribution
				? "normal"
				: e.workItemKind === "incident" &&
					  !["completed", "cancelled"].includes(e.workItemDisposition)
					? "critical"
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

/** The pre-2026-10-27 delegation producer never named the task or the tedi. */
const LEGACY_DELEGATION_TEXT =
	/^Delegated tedi (?:returned|reported|produced|failed)\b/i;

function readableOutcome(value: unknown, copy: FeedCopy) {
	const plain = plainHeadline(outcomeSummary(value), copy);
	return plain && !LEGACY_DELEGATION_TEXT.test(plain) ? plain : undefined;
}

/** Drop the "Failed: <code>" stamp and machine codes; keep the paragraphs. */
function plainReceipt(value: string | null | undefined, copy: FeedCopy) {
	return (value ?? "")
		.split(/\n{2,}/)
		.map((part) => plainFeedText(part, copy))
		.filter(
			(part) =>
				part && /\p{L}/u.test(part) && !LEGACY_DELEGATION_TEXT.test(part),
		)
		.join("\n\n");
}

function resultOutcome(
	a: z.infer<typeof WorkAttemptProjectionSchema>["attempt"],
): ActivityFeedItem["resultOutcome"] {
	if (a.outcome === "failed")
		return a.metadata.failureReason === "partial_result" ||
			/^\s*failed:\s*partial_result\b/i.test(a.summary ?? "")
			? "partial"
			: "failed";
	return a.outcome ?? undefined;
}

export function resultFeedItems(
	rows: z.infer<typeof WorkAttemptProjectionSchema>[],
	copy: FeedCopy = DEFAULT_FEED_COPY,
): ActivityFeedItem[] {
	return rows
		.filter((r) => r.attempt.outcome !== null)
		.map(({ attempt: a, workItem: w }) => {
			const outcome = resultOutcome(a);
			const title = plainFeedText(w.title, copy) || w.title;
			return {
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
							: sessionHarness(
										a.metadata.agentHarness,
										a.externalSessionKey,
								  ) === "codex"
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
				resultOutcome: outcome,
				sentence: sentence(
					readableOutcome(a.metadata.feedSentence, copy) ??
						readableOutcome(a.summary, copy) ??
						(outcome === "partial"
							? copy.partlyDone(title)
							: `${title} — ${outcome === "failed" ? copy.didntFinish : (copy.outcomes[a.outcome as keyof typeof copy.outcomes] ?? copy.workUpdated)}.`),
				),
				attachment: {
					title: title.slice(0, 200),
					summary: readableOutcome(a.summary, copy)?.slice(0, 300),
				},
				importance:
					a.outcome === "failed"
						? "high"
						: a.outcome === "succeeded"
							? "normal"
							: "low",
				stalled: a.outcome !== "succeeded",
				done: a.outcome === "succeeded",
				explanation: [plainReceipt(a.summary, copy), copy.resultExplanation]
					.filter(Boolean)
					.join("\n\n"),
			};
		});
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

const RETIREMENT_LABELS: Record<DeckRetirementReason, string> = {
	already_decided: "Already decided",
	expired: "Expired",
	handled_elsewhere: "Handled elsewhere",
	superseded: "Superseded",
	no_longer_relevant: "No longer relevant",
	duplicate: "Duplicate",
};

/** Deck cards retired without an answer in the last day, shown as handled updates. */
export function retiredDeckFeedItems(
	rows: z.infer<typeof WorkInteractionInboxRowSchema>[],
	now = new Date(),
): ActivityFeedItem[] {
	const since = now.getTime() - 24 * 3_600_000;
	return rows.flatMap(({ request: r, effectiveState, workItem }) => {
		const curation = DeckCurationStateSchema.safeParse(r.metadata?.curation);
		const at = r.resolvedAt ?? r.requestedAt;
		if (
			effectiveState !== "cancelled" ||
			!curation.success ||
			!curation.data.retirement ||
			!(Date.parse(at) >= since)
		)
			return [];
		const label = RETIREMENT_LABELS[curation.data.retirement.reason];
		const evidence = curation.data.evidenceRefs.find(safeSource);
		return [
			{
				...base(
					`retired:${r.id}`,
					at,
					r.projectId ?? workItem?.projectId ?? null,
					curation.data.retirement.workItemId ?? r.workItemId,
				),
				kind: "result" as const,
				classId: "deck_retired",
				sentence: sentence(`Retired (${label.toLowerCase()}): ${r.subject}`),
				source: evidence ?? `/work/interactions/${r.id}`,
				done: true,
				explanation: `${label}. ${curation.data.reason}`,
				// Retiring never answered the card, so restoring its prior revision is a real reversal.
				...(curation.data.revision && curation.data.revision > 1
					? {
							internalDecisionUndo: {
								requestId: r.id,
								expectedRequestVersion: r.version,
								expectedRevision: curation.data.revision,
								restoreRevision: curation.data.revision - 1,
							},
						}
					: {}),
			},
		];
	});
}

/** The Deck curator has not cleaned for too long: an ops alarm in the Feed. */
export function deckPipelineFeedItems(
	status: DeckPipelineStatus | null | undefined,
	now = new Date(),
): ActivityFeedItem[] {
	const items: ActivityFeedItem[] = [];
	const metrics = status?.metrics;
	if (metrics?.morning) {
		const v = deckWeekOneVerdicts(metrics);
		const pct =
			v.notUsefulRate.value === null
				? "no swipes yet"
				: `${Math.round(v.notUsefulRate.value * 100)}% not useful (${v.notUsefulRate.verdict.replace("_", "-")})`;
		items.push({
			...base(
				`deck-pipeline:metrics:${metrics.morning.date}`,
				status!.lastCleanedAt ?? now.toISOString(),
				null,
				null,
			),
			kind: "result" as const,
			classId: "deck_pipeline_metrics",
			sentence: sentence(
				`Decisions today: ${v.liveCards.value} cards at 08:30 (${v.liveCards.verdict.replace("_", "-")}), ${pct}, ${v.wrongRemovals.value} wrong removals (${v.wrongRemovals.verdict.replace("_", "-")})`,
			),
			source: "/work?view=deck",
			done: true,
			explanation:
				"Week-1 targets: at most 10 cards at 08:30 (more than 15 is a no-go), at most 25% of shown cards not useful (over 40% is a no-go), no wrong removal of a protected card and at most 5% overall.",
		});
	}
	if (!status?.stale) return items;
	const last = status.lastCleanedAt
		? `Last cleaned ${status.lastCleanedAt.slice(11, 16)} UTC.`
		: "It has never run.";
	return [
		...items,
		{
			...base("deck-pipeline:stale", now.toISOString(), null, null),
			kind: "result" as const,
			classId: "deck_pipeline_stale",
			importance: "high" as const,
			sentence: sentence(
				`Decisions cleanup has not run for over ${status.staleAfterHours} h`,
			),
			source: "/work?view=deck",
			explanation: `${last} Expired, finished and duplicate cards stay in Decisions until the 15-minute sweep runs again.`,
			stalled: true,
		},
	];
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
