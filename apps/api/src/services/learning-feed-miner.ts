/**
 * Learning feed miner: one deterministic step of MemoryReflectionWorkflow.
 *
 * 1. Decisions → memory. Decision-capture answers recorded in the learning
 *    ledger (`decision-learning-signal.ts`) are grouped by scope
 *    (repo, harness, topic). A group with a draft correction (edited /
 *    replaced / overridden) or at least two substantive decisions becomes ONE
 *    review-pending memory fact per scope. A newer fact for the same scope
 *    supersedes the earlier still-pending one instead of duplicating it;
 *    reviewed facts (confirmed, rejected, ...) are never superseded, and the
 *    events they already cover are not learned again.
 * 2. Agent mistakes → proposals. Completed Work Items titled as a fix
 *    (`fix(scope): ...`, `revert ...`) are recorded as `undone` learning events
 *    on surface `work_fix`. A scope with three or more fixes in the window
 *    becomes a `learning_improvement_proposals` row (subject `directive`) on
 *    the existing human review path. Anything else may record the same signal
 *    through `record_learning_interaction` with surface `work_fix` and issue key
 *    `agent-mistake:<topic>` and it joins the same grouping.
 *
 * Nothing here approves anything: facts stay `reviewStatus: "pending"` with
 * `usePolicy: "requires_user_confirmation"`; proposals stay `proposed`.
 *
 * Fact tags for delivery (see LearningFeedFactMetadata): `topicKey`
 * `learning-feed:decision:<repo>:<harness>:<topic>` and
 * `metadata.learningFeed.scope = { repo, harness, topic }`.
 */

import type { DbClient } from "@tedix/db/client";
import type { LearningInteractionEventRow } from "@tedix/db/schema/learning-feedback";
import {
	listLearningImprovementProposals,
	listLearningInteractionsForReflection,
	proposeLearningImprovement,
	recordLearningInteraction,
	summarizeRecurringLearningIssues,
} from "@tedix/db/queries/learning-feedback";
import { getOrCreateDomain } from "@tedix/db/queries/memory-graph/domains";
import { createEdge } from "@tedix/db/queries/memory-graph/edges";
import { invalidateFact } from "@tedix/db/queries/memory-graph/fact-lifecycle";
import {
	createFact,
	findCurrentFactsByTopicKey,
	findFactBySourceHash,
	updateFact,
} from "@tedix/db/queries/memory-graph/facts";
import { listWorkActivity } from "@tedix/db/queries/work-items/activity";
import { AUTO_REPLY_FOLLOW_CLASSES } from "@tedix/db/queries/work-items/reply-drafts";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	DECISION_CAPTURE_LEARNING_SURFACE,
	learningScopeSlug,
} from "./decision-learning-signal";
import {
	buildBrainWriteQualityEnvelope,
	mergeBrainWriteMetadata,
} from "./brain-write-quality";

export const LEARNING_FEED_PRODUCER = "learning-feed";
export const WORK_FIX_LEARNING_SURFACE = "work_fix";
const DOMAIN_NAME = "operations";
const LOOKBACK_DAYS = 30;
const EVENT_SCAN_LIMIT = 300;
const MAX_FACTS_PER_RUN = 20;
const MAX_PROPOSALS_PER_RUN = 5;
const ITEMS_PER_FACT = 5;
const FACT_CHARS = 1500;
/** Shorter answers ("yes", "go on") carry no lesson on their own. */
const MIN_DECISION_CHARS = 24;
const MIN_DECISIONS_PER_FACT = 2;
const MISTAKE_MIN_OCCURRENCES = 3;
const STRONG_KINDS = new Set(["edited", "manually_replaced"]);
const OPEN_PROPOSAL_STATUSES = new Set([
	"proposed",
	"evaluating",
	"ready_for_review",
]);

export interface LearningFeedScope {
	repo: string;
	harness: string;
	topic: string;
}

/** Shape of `memory_facts.metadata.learningFeed` written by this miner. */
export interface LearningFeedFactMetadata {
	version: 1;
	/** `prefer_avoid` when a draft correction is included, else `decision`. */
	kind: "prefer_avoid" | "decision";
	scope: LearningFeedScope;
	evidenceEventIds: string[];
	/** Personal-scope ids (users) whose decisions the fact was learned from. */
	learnedFromUserIds: string[];
	signalCounts: Record<string, number>;
	lastEventAt: string;
}

export interface LearningFeedResult {
	decisionEventsScanned: number;
	factsWritten: number;
	factsSuperseded: number;
	mistakeEventsRecorded: number;
	proposalsCreated: number;
	budgetHit: boolean;
}

type Meta = Record<string, unknown>;

function rec(value: unknown): Meta {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Meta)
		: {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function clip(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function learningFeedTopicKey(scope: LearningFeedScope): string {
	return `learning-feed:decision:${scope.repo}:${scope.harness}:${scope.topic}`;
}

function scopeOf(event: LearningInteractionEventRow): LearningFeedScope {
	const scope = rec(rec(event.metadata).scope);
	return {
		repo: learningScopeSlug(text(scope.repo)),
		harness: learningScopeSlug(text(scope.harness)),
		topic: learningScopeSlug(text(scope.topic)),
	};
}

/** One line of a lesson, or null when the event teaches nothing alone. */
export function decisionLessonLine(
	event: LearningInteractionEventRow,
): { line: string; strong: boolean } | null {
	const meta = rec(event.metadata);
	const answer = text(meta.answer);
	if (!answer) return null;
	const question = text(rec(meta.question).tail);
	if (STRONG_KINDS.has(event.eventKind)) {
		const draft = text(rec(meta.draft).body);
		const avoid = draft ? ` Avoid: "${clip(draft, 200)}".` : "";
		return {
			line: `Prefer: "${clip(answer, 260)}".${avoid}`,
			strong: true,
		};
	}
	if (event.eventKind !== "answered") return null;
	const replyClass = text(meta.replyClass);
	if (
		answer.length < MIN_DECISION_CHARS ||
		(AUTO_REPLY_FOLLOW_CLASSES as readonly string[]).includes(replyClass)
	)
		return null;
	const asked = question ? ` (agent asked: "${clip(question, 160)}")` : "";
	return { line: `Decided: "${clip(answer, 260)}"${asked}.`, strong: false };
}

export interface DecisionLessonDraft {
	scope: LearningFeedScope;
	content: string;
	metadata: LearningFeedFactMetadata;
}

/**
 * Build one lesson per scope from events not already covered by a reviewed
 * fact. Pure: grouping, filtering and wording are deterministic.
 */
export function buildDecisionLessons(
	events: LearningInteractionEventRow[],
	coveredEventIds: ReadonlySet<string> = new Set(),
): DecisionLessonDraft[] {
	const groups = new Map<string, LearningInteractionEventRow[]>();
	for (const event of events) {
		if (event.surface !== DECISION_CAPTURE_LEARNING_SURFACE) continue;
		if (coveredEventIds.has(event.id)) continue;
		const key = learningFeedTopicKey(scopeOf(event));
		groups.set(key, [...(groups.get(key) ?? []), event]);
	}
	const lessons: DecisionLessonDraft[] = [];
	for (const group of groups.values()) {
		const ordered = [...group].sort((a, b) =>
			b.occurredAt.localeCompare(a.occurredAt),
		);
		const scope = scopeOf(ordered[0]!);
		const signalCounts: Record<string, number> = {};
		for (const event of ordered)
			signalCounts[event.eventKind] = (signalCounts[event.eventKind] ?? 0) + 1;
		const lines: Array<{
			line: string;
			strong: boolean;
			event: LearningInteractionEventRow;
		}> = [];
		for (const event of ordered) {
			const lesson = decisionLessonLine(event);
			if (lesson) lines.push({ ...lesson, event });
		}
		const strong = lines.filter((l) => l.strong);
		if (strong.length === 0 && lines.length < MIN_DECISIONS_PER_FACT) continue;
		// Corrections first: they are the strongest signal.
		const chosen = [...strong, ...lines.filter((l) => !l.strong)].slice(
			0,
			ITEMS_PER_FACT,
		);
		const header = `Lessons from user decisions in ${scope.repo} (${scope.harness}, ${scope.topic}):`;
		const content = clip(
			[header, ...chosen.map((l) => `- ${l.line}`)].join("\n"),
			FACT_CHARS,
		);
		lessons.push({
			scope,
			content,
			metadata: {
				version: 1,
				kind: strong.length > 0 ? "prefer_avoid" : "decision",
				scope,
				evidenceEventIds: ordered.map((e) => e.id),
				learnedFromUserIds: [
					...new Set(
						ordered
							.filter((e) => e.scopeKind === "personal")
							.map((e) => e.scopeId),
					),
				],
				signalCounts,
				lastEventAt: ordered[0]!.occurredAt,
			},
		});
	}
	return lessons;
}

function evidenceIdsOf(metadata: unknown): string[] {
	const ids = rec(rec(metadata).learningFeed).evidenceEventIds;
	return Array.isArray(ids)
		? ids.filter((id): id is string => typeof id === "string")
		: [];
}

async function writeDecisionLessons(
	db: DbClient,
	orgId: string,
	events: LearningInteractionEventRow[],
	result: LearningFeedResult,
): Promise<void> {
	const byTopic = new Map<string, LearningInteractionEventRow[]>();
	for (const event of events) {
		const key = learningFeedTopicKey(scopeOf(event));
		byTopic.set(key, [...(byTopic.get(key) ?? []), event]);
	}
	for (const [topicKey, topicEvents] of byTopic) {
		if (result.factsWritten >= MAX_FACTS_PER_RUN) {
			result.budgetHit = true;
			return;
		}
		const current = await findCurrentFactsByTopicKey(db, orgId, topicKey);
		const pending = current.filter((f) => f.reviewStatus === "pending");
		const covered = new Set(
			current
				.filter((f) => f.reviewStatus !== "pending")
				.flatMap((f) => evidenceIdsOf(f.metadata)),
		);
		const [lesson] = buildDecisionLessons(topicEvents, covered);
		if (!lesson) continue;
		// Nothing new since the pending lesson for this scope: no churn.
		const pendingIds = new Set(
			pending.flatMap((f) => evidenceIdsOf(f.metadata)),
		);
		if (lesson.metadata.evidenceEventIds.every((id) => pendingIds.has(id)))
			continue;
		const sourceHash = await sha256(lesson.content.toLowerCase());
		if (await findFactBySourceHash(db, orgId, sourceHash)) continue;

		const domain = await getOrCreateDomain(db, orgId, DOMAIN_NAME);
		const source = `learning-feed:decision:${orgId}:${lesson.metadata.evidenceEventIds[0]}`;
		const strong = lesson.metadata.kind === "prefer_avoid";
		const metadata: Meta = {
			producer: LEARNING_FEED_PRODUCER,
			sourceKind: "brain-reflection",
			expectedUse:
				"Deliver reviewed user decisions to agents working in the same repo, harness and topic",
			confidenceReason: strong
				? "User corrected a drafted reply; reversible until reviewed"
				: "Repeated explicit user decisions; reversible until reviewed",
			learningFeed: lesson.metadata,
		};
		const quality = buildBrainWriteQualityEnvelope({
			content: lesson.content,
			domain: DOMAIN_NAME,
			confidence: strong ? 0.6 : 0.5,
			priority: "active",
			source,
			sourceHash,
			metadata,
		});
		const factId = crypto.randomUUID();
		const now = new Date().toISOString();
		await createFact(db, {
			id: factId,
			organizationId: orgId,
			tediId: null,
			domainId: domain.id,
			content: lesson.content,
			summary: clip(
				lesson.content.split("\n")[1]?.slice(2) ?? lesson.content,
				100,
			),
			factType: strong ? "preference" : "decision",
			confidence: quality.confidenceApplied,
			priority: quality.priorityApplied,
			status: "probation",
			reviewStatus: "pending",
			usePolicy: "requires_user_confirmation",
			memoryScope: "org",
			visibility: "org",
			topicKey,
			validFrom: now,
			validTo: null,
			archivedAt: null,
			source,
			sourceSessionId: null,
			sourceUrl: null,
			sourceHash,
			metadata: toJsonRecord(mergeBrainWriteMetadata(metadata, quality)),
			accessCount: 0,
		});
		result.factsWritten++;
		for (const old of pending) {
			await invalidateFact(
				db,
				old.id,
				`Superseded by ${factId} for topic ${topicKey}`,
			);
			await updateFact(db, old.id, { reviewStatus: "superseded" });
			await createEdge(db, {
				id: crypto.randomUUID(),
				sourceFactId: factId,
				targetFactId: old.id,
				relationType: "supersedes",
				strength: 1,
				context: `Learning feed supersession: ${topicKey}`,
			});
			result.factsSuperseded++;
		}
	}
}

const FIX_TITLE =
	/^\s*(?:fix|hotfix|revert|repair)(?:\(([^)]{1,64})\))?!?(?::|\b)/i;

/** Topic of a fix-titled Work Item, or null when the title is not a fix. */
export function fixTopic(title: string): string | null {
	const match = FIX_TITLE.exec(title);
	if (!match) return null;
	return learningScopeSlug(match[1] ?? null);
}

async function recordWorkFixes(
	db: DbClient,
	orgId: string,
	result: LearningFeedResult,
): Promise<void> {
	const { events } = await listWorkActivity(db, {
		orgId,
		eventTypes: ["work.completed", "attempt.settled"],
		limit: EVENT_SCAN_LIMIT,
	});
	const seen = new Set<string>();
	for (const event of events) {
		if (event.workItemStatus !== "completed" || seen.has(event.workItemId))
			continue;
		seen.add(event.workItemId);
		const topic = fixTopic(event.workItemTitle);
		if (!topic) continue;
		const { duplicate } = await recordLearningInteraction(db, {
			organizationId: orgId,
			actorType: "service",
			actorId: LEARNING_FEED_PRODUCER,
			tediId: null,
			clientEventId: `work-fix:${event.workItemId}`,
			signalClass: "quality",
			eventKind: "undone",
			scopeKind: "organization",
			scopeId: orgId,
			issueKey: `agent-mistake:${topic}`,
			surface: WORK_FIX_LEARNING_SURFACE,
			targetType: "work_item",
			targetId: event.workItemId,
			metadata: toJsonRecord({
				title: clip(event.workItemTitle, 200),
				harness: event.agentHarness,
				agentSession: event.agentSession,
				commitSha: event.settlement?.commitSha ?? null,
			}),
			occurredAt: event.createdAt,
		});
		if (!duplicate) result.mistakeEventsRecorded++;
	}
}

async function proposeMistakeDirectives(
	db: DbClient,
	orgId: string,
	events: LearningInteractionEventRow[],
	result: LearningFeedResult,
): Promise<void> {
	const issues = summarizeRecurringLearningIssues({
		events: events.filter((e) => e.surface === WORK_FIX_LEARNING_SURFACE),
		minimumOccurrences: MISTAKE_MIN_OCCURRENCES,
		limit: 25,
	}).filter((issue) => issue.eligible);
	const byId = new Map(events.map((e) => [e.id, e]));
	for (const issue of issues) {
		if (result.proposalsCreated >= MAX_PROPOSALS_PER_RUN) {
			result.budgetHit = true;
			return;
		}
		const open = (
			await listLearningImprovementProposals(db, {
				organizationId: orgId,
				issueKey: issue.issueKey,
				limit: 10,
			})
		).some((p) => OPEN_PROPOSAL_STATUSES.has(p.status));
		if (open) continue;
		const evidence = issue.evidenceEventIds.slice(-50);
		const titles = evidence
			.map((id) => text(rec(byId.get(id)?.metadata).title))
			.filter(Boolean)
			.slice(-5);
		const topic = issue.issueKey.replace(/^agent-mistake:/, "");
		const recommendation = clip(
			`Agents needed ${issue.negativeCount} follow-up fixes in "${topic}" between ${issue.firstOccurredAt.slice(0, 10)} and ${issue.lastOccurredAt.slice(0, 10)}. Recent fixes: ${titles.map((t) => `"${t}"`).join("; ")}. Review the pattern and approve a directive (prefer/avoid) for agents working on ${topic}.`,
			4000,
		);
		const digest = (await sha256(evidence.join(","))).slice(0, 24);
		const { duplicate } = await proposeLearningImprovement(db, {
			organizationId: orgId,
			clientProposalId: `learning-feed:${issue.issueKey}:${digest}`.slice(
				0,
				128,
			),
			tediId: issue.tediId,
			scopeKind: issue.scopeKind,
			scopeId: issue.scopeId,
			issueKey: issue.issueKey,
			subjectKind: "directive",
			subjectId: issue.issueKey,
			recommendation,
			evidenceEventIds: evidence,
			proposedByType: "service",
			proposedById: LEARNING_FEED_PRODUCER,
		});
		if (!duplicate) result.proposalsCreated++;
	}
}

/**
 * Called from MemoryReflectionWorkflow step "mine-learning-feed". Each half is
 * fail-soft so a mistake-scan error never drops the decision lessons.
 */
export async function mineLearningFeed(
	db: DbClient,
	{ orgId, now = new Date() }: { orgId: string; now?: Date },
): Promise<LearningFeedResult> {
	const result: LearningFeedResult = {
		decisionEventsScanned: 0,
		factsWritten: 0,
		factsSuperseded: 0,
		mistakeEventsRecorded: 0,
		proposalsCreated: 0,
		budgetHit: false,
	};
	const since = new Date(
		now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
	).toISOString();
	try {
		const decisions = await listLearningInteractionsForReflection(db, {
			organizationId: orgId,
			surfaces: [DECISION_CAPTURE_LEARNING_SURFACE],
			since,
			limit: EVENT_SCAN_LIMIT,
		});
		result.decisionEventsScanned = decisions.length;
		await writeDecisionLessons(db, orgId, decisions, result);
	} catch (error) {
		console.error("[learning-feed] decision lessons failed:", error);
	}
	try {
		await recordWorkFixes(db, orgId, result);
		const fixes = await listLearningInteractionsForReflection(db, {
			organizationId: orgId,
			surfaces: [WORK_FIX_LEARNING_SURFACE],
			since,
			limit: EVENT_SCAN_LIMIT,
		});
		await proposeMistakeDirectives(db, orgId, fixes, result);
	} catch (error) {
		console.error("[learning-feed] agent-mistake proposals failed:", error);
	}
	return result;
}
