/**
 * Learning feed miner: one deterministic step of MemoryReflectionWorkflow,
 * also run on demand (`mine_agent_session_lessons`).
 *
 * 1. Decisions → memory. A person's own decisions (personal scope: live
 *    decision capture and imported historic sessions) are distilled from
 *    their whole history by `lesson-map-reduce.ts`, as Workflow steps. Here,
 *    org-wide decision-capture answers in the learning ledger
 *    (`decision-learning-signal.ts`) are grouped by scope (repo, harness,
 *    topic). A group with a draft correction
 *    (edited / replaced / overridden) or at least two substantive decisions
 *    becomes ONE memory fact per user and scope, active at once: no review
 *    gate. Correction is organic — when newer decisions arrive for a scope,
 *    a fresh lesson built from them supersedes the earlier learned one, so a
 *    later decision that contradicts or edits around a lesson replaces it. A
 *    lesson with no new supporting decision for STALE_DAYS is archived.
 *    A fact a person reviewed by hand (confirmed, rejected, ...) is never
 *    superseded or archived here, and the events it covers are not learned
 *    again.
 * 2. Agent mistakes → proposals. Completed Work Items titled as a fix
 *    (`fix(scope): ...`, `revert ...`) are recorded as `undone` learning events
 *    on surface `work_fix`. A scope with three or more fixes in the window
 *    becomes a `learning_improvement_proposals` row (subject `directive`) on
 *    the existing human review path. Anything else may record the same signal
 *    through `record_learning_interaction` with surface `work_fix` and issue key
 *    `agent-mistake:<topic>` and it joins the same grouping.
 *
 * Where a lesson lands (its brain):
 *   - Organization: always the organization the events were recorded in. One
 *     run mines exactly one organization and drops any row of another.
 *   - Person: a lesson learned from one user's decisions is personal — tedi
 *     null, visibility `private`, `metadata.learningFeed.ownerUserId` — so it
 *     reaches every session of that user in the organization and no one
 *     else's. A person may widen it (visibility `org`) through memory review.
 *     Events without a personal scope keep the org-wide shape.
 *   - Tedi: when one of the organization's live tedis clearly owns the
 *     lesson's domain (Clef decides from the tedis' own names, tags and
 *     personality, never a hardcoded roster; probability >= ROUTE_THRESHOLD),
 *     the fact carries that tediId (memory scope `tedi`, private to it), so
 *     that tedi's brain learns it. Model unavailable or unsure: personal.
 *
 * A lesson is context, never authority: delivery frames it as tenant data
 * that cannot override repository rules, approvals or tenant boundaries, and
 * its use policy stays `requires_user_confirmation` (no action on the
 * lesson's strength alone). Its review status is `confirmed` with
 * `metadata.learningFeed.autoConfirmed`, which marks it as the miner's own and
 * replaceable. Mistake proposals stay `proposed` for a human.
 *
 * Fact tags for delivery (see LearningFeedFactMetadata): `topicKey`
 * `learning-feed:decision:<repo>:<harness>:<topic>` (personal lessons append
 * `:user:<userId>`) and
 * `metadata.learningFeed.scope = { repo, harness, topic }`.
 */

import type { DbClient } from "@tedix/db/client";
import type { Tedi } from "@tedix/db/schema/tedis";
import type { LearningInteractionEventRow } from "@tedix/db/schema/learning-feedback";
import {
	listLearningImprovementProposals,
	listLearningInteractionsForReflection,
	proposeLearningImprovement,
	recordLearningInteraction,
	summarizeRecurringLearningIssues,
} from "@tedix/db/queries/learning-feedback";
import {
	listArchivedLearningFeedLessons,
	listStaleLearningFeedLessons,
} from "@tedix/db/queries/memory-graph/agent-lessons";
import { getOrCreateDomain } from "@tedix/db/queries/memory-graph/domains";
import { createEdge } from "@tedix/db/queries/memory-graph/edges";
import { invalidateFact } from "@tedix/db/queries/memory-graph/fact-lifecycle";
import {
	createFact,
	findCurrentFactsByTopicKey,
	findFactBySourceHash,
	updateFact,
} from "@tedix/db/queries/memory-graph/facts";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import { listWorkActivity } from "@tedix/db/queries/work-items/activity";
import { AUTO_REPLY_FOLLOW_CLASSES } from "@tedix/db/queries/work-items/reply-drafts";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	DECISION_CAPTURE_LEARNING_SURFACE,
	learningScopeSlug,
} from "./decision-learning-signal";
import { AGENT_SESSION_IMPORT_LEARNING_SURFACE } from "./agent-session-decision-import";
import {
	buildBrainWriteQualityEnvelope,
	mergeBrainWriteMetadata,
} from "./brain-write-quality";
import { type ClefModelId, type ClefQuestion, runClef } from "../lib/clef";
import { DISTILL_VERSION, type LessonDistiller } from "./lesson-distiller";

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
/** A learned lesson with no supporting decision for this long is archived. */
export const STALE_DAYS = 90;
const STRONG_KINDS = new Set(["edited", "manually_replaced"]);
/** Clef probability a tedi must reach before a lesson enters its brain. */
export const ROUTE_THRESHOLD = 0.75;
const ROUTE_MODEL: ClefModelId = "@cf/cloudflare/clef-flash";
const ROUTE_MAX_TEDIS = 12;
const ROUTE_NONE = "none";
/** Live decision capture and historic session imports teach alike. */
const DECISION_SURFACES = [
	DECISION_CAPTURE_LEARNING_SURFACE,
	AGENT_SESSION_IMPORT_LEARNING_SURFACE,
];
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
	/** The user a personal lesson belongs to; null for an org-wide lesson. */
	ownerUserId: string | null;
	/** How the owning tedi was chosen; absent when routing was not attempted. */
	routing?: LessonRouting;
	/** Active without review; the miner may supersede or archive it. */
	autoConfirmed?: true;
	signalCounts: Record<string, number>;
	lastEventAt: string;
	/** Distiller version whose rules the content is; absent for quotes. */
	distilled?: number;
}

export interface LessonRouting {
	status: "routed" | "personal" | "unavailable";
	tediId: string | null;
	probability: number | null;
	model: ClefModelId;
}

/** Chooses the tedi that owns a lesson, or none. Injected in tests. */
export type LessonRouter = (
	lesson: DecisionLessonDraft,
	tedis: Tedi[],
) => Promise<LessonRouting>;

export interface LearningFeedResult {
	decisionEventsScanned: number;
	factsWritten: number;
	factsSuperseded: number;
	factsRoutedToTedi: number;
	factsArchived: number;
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

export function learningFeedTopicKey(
	scope: LearningFeedScope,
	ownerUserId: string | null = null,
): string {
	const base = `learning-feed:decision:${scope.repo}:${scope.harness}:${scope.topic}`;
	return ownerUserId ? `${base}:user:${ownerUserId}` : base;
}

/** The user whose decision this is, or null for a non-personal event. */
function ownerOf(event: LearningInteractionEventRow): string | null {
	return event.scopeKind === "personal" && event.scopeId ? event.scopeId : null;
}

function groupKey(event: LearningInteractionEventRow): string {
	return learningFeedTopicKey(scopeOf(event), ownerOf(event));
}

function scopeOf(event: LearningInteractionEventRow): LearningFeedScope {
	const scope = rec(rec(event.metadata).scope);
	// An imported session's topic is only its reply type (continue, question,
	// ...), and a person works the same way in either host: learn one lesson
	// per subject, the repository, so a rule is stated once.
	if (event.surface === AGENT_SESSION_IMPORT_LEARNING_SURFACE)
		return {
			repo: learningScopeSlug(text(scope.repo)),
			harness: "general",
			topic: "general",
		};
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
		if (!DECISION_SURFACES.includes(event.surface)) continue;
		if (coveredEventIds.has(event.id)) continue;
		const key = groupKey(event);
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
		const where = scope.repo === "general" ? "" : ` in ${scope.repo}`;
		const header = `Lessons from user decisions${where} (${scope.harness}, ${scope.topic}):`;
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
				ownerUserId: ownerOf(ordered[0]!),
				signalCounts,
				lastEventAt: ordered[0]!.occurredAt,
			},
		});
	}
	return lessons;
}

/**
 * The miner's own lesson (pending from before auto-confirmation, or
 * auto-confirmed) that no person has reviewed since: safe to replace.
 */
export function isReplaceableLesson(fact: {
	reviewStatus: string | null;
	metadata: unknown;
}): boolean {
	const meta = rec(fact.metadata);
	if (rec(meta.memoryLifecycle).lastReview) return false;
	// Retired for not reducing corrections (`lesson-effectiveness.ts`):
	// settled like a person's archive, so it is not learned again.
	if (rec(meta.learningFeed).retired) return false;
	return (
		fact.reviewStatus === "pending" ||
		(fact.reviewStatus === "confirmed" &&
			rec(meta.learningFeed).autoConfirmed === true)
	);
}

function evidenceIdsOf(metadata: unknown): string[] {
	const ids = rec(rec(metadata).learningFeed).evidenceEventIds;
	return Array.isArray(ids)
		? ids.filter((id): id is string => typeof id === "string")
		: [];
}

function tediCriterion(tedi: Tedi): string {
	const tags = (tedi.tags ?? []).filter((t) => typeof t === "string");
	const persona = text(tedi.personality ?? "");
	return clip(
		[
			`${tedi.displayName ?? tedi.name} (${tedi.slug})`,
			tags.length ? `tags: ${tags.join(", ")}` : "",
			persona ? `role: ${persona}` : "",
		]
			.filter(Boolean)
			.join("; "),
		400,
	);
}

/**
 * Tedis that may receive a lesson: the organization's live, org-scoped
 * workers, plus the owner's own personal tedi. Never another user's personal
 * tedi, never another organization's.
 */
export function routeCandidates(
	tedis: Tedi[],
	orgId: string,
	ownerUserId: string | null,
): Tedi[] {
	return tedis
		.filter(
			(t) =>
				t.organizationId === orgId &&
				!t.retiredAt &&
				(t.scope === "organization" ||
					(ownerUserId !== null && t.ownerUserId === ownerUserId)),
		)
		.slice(0, ROUTE_MAX_TEDIS);
}

/**
 * Pure decision step: the chosen tedi when Clef's choice is a candidate at or
 * above ROUTE_THRESHOLD, else personal.
 */
export function routingFromChoice(
	choice: { choice: string; probabilities: Record<string, number> } | null,
	optionToTedi: ReadonlyMap<string, string>,
): LessonRouting {
	if (!choice)
		return {
			status: "unavailable",
			tediId: null,
			probability: null,
			model: ROUTE_MODEL,
		};
	const probability = choice.probabilities[choice.choice] ?? 0;
	const tediId = optionToTedi.get(choice.choice) ?? null;
	return tediId && probability >= ROUTE_THRESHOLD
		? { status: "routed", tediId, probability, model: ROUTE_MODEL }
		: { status: "personal", tediId: null, probability, model: ROUTE_MODEL };
}

/**
 * The tedi among `tedis` that clearly owns a subject: Clef decides from the
 * tedis' own names, tags and personality, never a hardcoded roster. Below
 * ROUTE_THRESHOLD, or on any model failure, no tedi owns it. Shared by lesson
 * routing and reply-draft routing.
 */
export async function routeToOwningTedi(
	env: Parameters<typeof runClef>[0],
	input: {
		tedis: Tedi[];
		instructions: string;
		state: Record<string, unknown>;
		surface: string;
	},
): Promise<LessonRouting> {
	const optionToTedi = new Map<string, string>();
	const criteria: Record<string, string> = {};
	input.tedis.forEach((tedi, index) => {
		optionToTedi.set(`t${index + 1}`, tedi.id);
		criteria[`t${index + 1}`] = tediCriterion(tedi);
	});
	criteria[ROUTE_NONE] =
		"No single worker clearly owns this: personal, cross-cutting or unclear";
	const question: ClefQuestion = {
		type: "choice",
		instructions: input.instructions,
		criteria,
	};
	const result = await runClef(env, {
		modelId: ROUTE_MODEL,
		state: input.state,
		questions: { owner: question },
		surface: input.surface,
	});
	const answer = result.ok ? result.answers.owner : undefined;
	return routingFromChoice(
		answer?.type === "choice" ? answer : null,
		optionToTedi,
	);
}

/** Clef-backed router. Any model failure leaves the lesson personal. */
export function clefLessonRouter(
	env: Parameters<typeof runClef>[0],
): LessonRouter {
	return (lesson, tedis) =>
		routeToOwningTedi(env, {
			tedis,
			instructions:
				"A person made these decisions while working with an AI agent. Which AI worker's area of responsibility (for example engineering, finance, marketing) do they clearly belong to? Choose none unless one worker plainly owns the subject.",
			state: { lesson: lesson.content, scope: lesson.scope },
			surface: "learning-feed-routing",
		});
}

async function writeDecisionLessons(
	db: DbClient,
	orgId: string,
	events: LearningInteractionEventRow[],
	result: LearningFeedResult,
	route: LessonRouter | undefined,
	distill?: LessonDistiller,
): Promise<void> {
	const byTopic = new Map<string, LearningInteractionEventRow[]>();
	for (const event of events) {
		const key = groupKey(event);
		byTopic.set(key, [...(byTopic.get(key) ?? []), event]);
	}
	let tedis: Tedi[] | undefined;
	for (const [topicKey, topicEvents] of byTopic) {
		if (result.factsWritten >= MAX_FACTS_PER_RUN) {
			result.budgetHit = true;
			return;
		}
		const ownerUserId = ownerOf(topicEvents[0]!);
		const current = await findCurrentFactsByTopicKey(db, orgId, topicKey);
		// Lessons written before personal scoping used the shared key; events a
		// reviewed one covers are not learned again.
		const legacyKey = learningFeedTopicKey(scopeOf(topicEvents[0]!));
		const legacy =
			legacyKey === topicKey
				? []
				: await findCurrentFactsByTopicKey(db, orgId, legacyKey);
		// A lesson a person archived is not current, but still covers its events.
		const archived = await listArchivedLearningFeedLessons(db, orgId, [
			...new Set([topicKey, legacyKey]),
		]);
		const covered = new Set(
			[...current, ...legacy, ...archived]
				.filter((f) => !isReplaceableLesson(f))
				.flatMap((f) => evidenceIdsOf(f.metadata)),
		);
		const [quoted] = buildDecisionLessons(topicEvents, covered);
		if (!quoted) continue;
		const evidence = new Set(quoted.metadata.evidenceEventIds);
		// The miner's earlier lessons this one replaces: every one under this
		// key, and a shared-key one whose evidence this lesson fully contains.
		const replaced = [
			...new Map(
				[
					...current.filter(isReplaceableLesson),
					...legacy.filter(
						(f) =>
							isReplaceableLesson(f) &&
							evidenceIdsOf(f.metadata).every((id) => evidence.has(id)),
					),
				].map((f) => [f.id, f]),
			).values(),
		];
		// Nothing new since the active lesson for this scope: no churn. A
		// pending one from before auto-confirmation is rewritten as active, and
		// a quoted one is rewritten once a distiller is available.
		const activeIds = new Set(
			replaced
				.filter((f) => f.reviewStatus === "confirmed")
				.flatMap((f) => evidenceIdsOf(f.metadata)),
		);
		const undistilled =
			distill !== undefined &&
			replaced.some(
				(f) => rec(rec(f.metadata).learningFeed).distilled !== DISTILL_VERSION,
			);
		if (
			!undistilled &&
			!replaced.some((f) => f.reviewStatus === "pending") &&
			quoted.metadata.evidenceEventIds.every((id) => activeIds.has(id))
		)
			continue;
		// Quotes become durable rules when a distiller is given. A distiller
		// that finds nothing lasting retires the miner's earlier lesson here.
		const rules = distill
			? await distill({
					content: quoted.content,
					scope: quoted.scope,
					replies: topicEvents
						.filter((event) => !covered.has(event.id))
						.map((event) => ({
							text: text(rec(event.metadata).answer),
							session: event.threadId,
							occurredAt: event.occurredAt,
							kind: text(rec(rec(event.metadata).scope).topic),
						})),
				}).catch(() => null)
			: null;
		if (rules && rules.length === 0) {
			for (const old of replaced)
				await invalidateFact(
					db,
					old.id,
					`No lasting rule in the decisions for topic ${topicKey}`,
				);
			continue;
		}
		const lesson: DecisionLessonDraft = rules
			? {
					...quoted,
					content: clip(
						[
							quoted.content.split("\n")[0]!,
							...rules.map((rule) => `- ${rule}`),
						].join("\n"),
						FACT_CHARS,
					),
					metadata: { ...quoted.metadata, distilled: DISTILL_VERSION },
				}
			: quoted;
		const sourceHash = await sha256(
			`${ownerUserId ?? ""}\n${lesson.content.toLowerCase()}`,
		);
		if (await findFactBySourceHash(db, orgId, sourceHash)) continue;

		let routing: LessonRouting | undefined;
		if (route) {
			tedis ??= await getTedisByOrganization(db, orgId).catch(() => []);
			const candidates = routeCandidates(tedis, orgId, ownerUserId);
			if (candidates.length) {
				try {
					routing = await route(lesson, candidates);
				} catch {
					routing = undefined;
				}
				// Only a candidate of this organization can own the fact.
				if (
					routing?.tediId &&
					!candidates.some((t) => t.id === routing!.tediId)
				)
					routing = { ...routing, status: "personal", tediId: null };
			}
		}
		const tediId = routing?.status === "routed" ? routing.tediId : null;
		if (tediId) result.factsRoutedToTedi++;
		const learningFeed: LearningFeedFactMetadata = {
			...lesson.metadata,
			...(routing ? { routing } : {}),
			autoConfirmed: true,
		};

		const domain = await getOrCreateDomain(db, orgId, DOMAIN_NAME);
		const source = `learning-feed:decision:${orgId}:${lesson.metadata.evidenceEventIds[0]}`;
		const strong = lesson.metadata.kind === "prefer_avoid";
		const metadata: Meta = {
			producer: LEARNING_FEED_PRODUCER,
			sourceKind: "brain-reflection",
			expectedUse: tediId
				? "Teach the tedi that owns this domain the user's reviewed decisions"
				: ownerUserId
					? "Deliver the user's own reviewed decisions to their agent sessions in the same repo, harness and topic"
					: "Deliver reviewed user decisions to agents working in the same repo, harness and topic",
			confidenceReason: strong
				? "User corrected a drafted reply; replaced by the next decisions in scope"
				: "Repeated explicit user decisions; replaced by the next decisions in scope",
			learningFeed,
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
			tediId,
			domainId: domain.id,
			content: lesson.content,
			summary: clip(
				lesson.content.split("\n")[1]?.slice(2) ?? lesson.content,
				100,
			),
			factType: strong ? "preference" : "decision",
			confidence: quality.confidenceApplied,
			priority: quality.priorityApplied,
			// Active at once; context only, never authority (see header).
			status: "active",
			reviewStatus: "confirmed",
			usePolicy: "requires_user_confirmation",
			lastVerifiedAt: now,
			// Personal (one user's decisions) or tedi-owned until a reviewer
			// widens it; org-wide only for events without a personal scope.
			memoryScope: tediId ? "tedi" : "org",
			visibility: tediId || ownerUserId ? "private" : "org",
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
		for (const old of replaced) {
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

/**
 * Archive the miner's own lessons whose newest supporting decision is older
 * than STALE_DAYS. Lessons a person reviewed by hand are left alone.
 */
async function archiveStaleLessons(
	db: DbClient,
	orgId: string,
	now: Date,
	result: LearningFeedResult,
): Promise<void> {
	const before = new Date(
		now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000,
	).toISOString();
	const stale = await listStaleLearningFeedLessons(
		db,
		orgId,
		"learning-feed:decision:",
		before,
	);
	for (const fact of stale) {
		if (!isReplaceableLesson(fact)) continue;
		await updateFact(db, fact.id, { archivedAt: now.toISOString() });
		result.factsArchived++;
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
	{
		orgId,
		now = new Date(),
		route,
		distill,
	}: {
		orgId: string;
		now?: Date;
		/** Owning-tedi router (`clefLessonRouter(env)`); omitted: no routing. */
		route?: LessonRouter;
		/** Turns quoted decisions into durable rules (`modelLessonDistiller(env)`). */
		distill?: LessonDistiller;
	},
): Promise<LearningFeedResult> {
	const result: LearningFeedResult = {
		decisionEventsScanned: 0,
		factsWritten: 0,
		factsSuperseded: 0,
		factsRoutedToTedi: 0,
		factsArchived: 0,
		mistakeEventsRecorded: 0,
		proposalsCreated: 0,
		budgetHit: false,
	};
	const since = new Date(
		now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
	).toISOString();
	try {
		// One run, one organization: a row of another never joins a lesson. A
		// person's own decisions are distilled from their whole history by
		// `lesson-map-reduce.ts`; this pass learns the org-wide ones.
		const decisions = (
			await listLearningInteractionsForReflection(db, {
				organizationId: orgId,
				surfaces: [DECISION_CAPTURE_LEARNING_SURFACE],
				since,
				limit: EVENT_SCAN_LIMIT,
			})
		).filter(
			(event) => event.organizationId === orgId && ownerOf(event) === null,
		);
		result.decisionEventsScanned = decisions.length;
		await writeDecisionLessons(db, orgId, decisions, result, route, distill);
	} catch (error) {
		console.error("[learning-feed] decision lessons failed:", error);
	}
	try {
		await archiveStaleLessons(db, orgId, now, result);
	} catch (error) {
		console.error("[learning-feed] stale lesson archive failed:", error);
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
