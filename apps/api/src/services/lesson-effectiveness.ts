/**
 * Do delivered lessons reduce repeated corrections?
 *
 * Exposure comes from the delivery log (`lesson-delivery.ts`): per session,
 * the learned lessons it received, or, in the 10% holdout, the ones it would
 * have received. Outcomes are the user's corrections in the same session
 * (decision-capture answers, thread = session) after the lessons arrived: a
 * reply classed correction, challenge, frustration, simplify, verify or
 * plain-english, or a drafted reply the person edited or replaced.
 *
 *   overall   corrections per session, sessions with learned lessons vs
 *             holdout sessions, also per week (of the session's first
 *             delivery)
 *   lesson    per lesson lineage (topic key: a superseding lesson keeps it),
 *             corrections on the lesson's subject per session, delivered vs
 *             holdout
 *
 * Retirement (nightly, {@link retireIneffectiveLessons}): a learned lesson
 * with enough exposure in both arms whose subject is still corrected at least
 * as often with it as without it loses confidence, at most once a week; one
 * that does so in ARCHIVE_STRIKES weeks is archived and marked retired, so the
 * distiller does not learn its rules again. Written, person-reviewed and core
 * lessons are never touched. Every decision is logged as a learning event
 * (surface `lesson_retirement`).
 */

import type {
	GetLessonEffectivenessResult,
	LessonEffectivenessArm,
	LessonEffectivenessEntry,
	LessonEffectivenessVerdict,
} from "@tedix/api-contract/schemas/agent-session-lessons";
import { AGENT_LESSON_TOPIC_PREFIX } from "@tedix/api-contract/schemas/agent-session-lessons";
import type { DbClient } from "@tedix/db/client";
import {
	listLearningInteractions,
	listLearningInteractionsForReflection,
	recordLearningInteraction,
} from "@tedix/db/queries/learning-feedback";
import {
	listApprovedAgentLessons,
	listCurrentLearningFeedLessons,
} from "@tedix/db/queries/memory-graph/agent-lessons";
import { updateFact } from "@tedix/db/queries/memory-graph/facts";
import type { LearningInteractionEventRow } from "@tedix/db/schema/learning-feedback";
import { toJsonRecord } from "@tedix/db/utils/json";
import type { BaseContext } from "../rpc/orpc";
import { DECISION_CAPTURE_LEARNING_SURFACE } from "./decision-learning-signal";
import { observedLearningActor } from "./learning-interaction-recorder";
import { isReplaceableLesson } from "./learning-feed-miner";
import {
	correctionSubjects,
	HOLDOUT_PERCENT,
	isMinedLesson,
	LESSON_DELIVERY_SURFACE,
	measuredLessonsOf,
} from "./lesson-delivery";

export const LESSON_RETIREMENT_SURFACE = "lesson_retirement";
/** Exposure a lesson needs before it gets a verdict. */
export const MIN_DELIVERED_SESSIONS = 20;
export const MIN_HOLDOUT_SESSIONS = 4;
/** A lesson is only judged unhelpful while its subject is still corrected. */
export const MIN_DELIVERED_CORRECTIONS = 3;
const DECAY_FACTOR = 0.8;
const MIN_CONFIDENCE = 0.1;
/** Weeks judged unhelpful (within STRIKE_DAYS) before a lesson is archived. */
export const ARCHIVE_STRIKES = 3;
const STRIKE_DAYS = 56;
const RETIREMENT_WINDOW_DAYS = 28;
const READ_LIMIT = 3000;
const LESSONS_SHOWN = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRODUCER = "learning-feed";

type Meta = Record<string, unknown>;
const rec = (value: unknown): Meta =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Meta)
		: {};

/** Monday (UTC) of the week of an ISO time, as YYYY-MM-DD. */
export function weekStart(iso: string): string {
	const day = new Date(iso);
	const monday = new Date(
		Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()),
	);
	monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
	return monday.toISOString().slice(0, 10);
}

interface Counter {
	sessions: number;
	corrections: number;
}
const counter = (): Counter => ({ sessions: 0, corrections: 0 });
const arm = (c: Counter): LessonEffectivenessArm => ({
	sessions: c.sessions,
	corrections: c.corrections,
	rate: c.sessions
		? Math.round((c.corrections / c.sessions) * 1e4) / 1e4
		: null,
});

interface Exposure {
	holdout: boolean;
	firstAt: string;
	lessons: Map<string, { id: string; firstAt: string; subjects: string[] }>;
}

export function verdictOf(
	delivered: LessonEffectivenessArm,
	holdout: LessonEffectivenessArm,
): LessonEffectivenessVerdict {
	if (
		delivered.sessions < MIN_DELIVERED_SESSIONS ||
		holdout.sessions < MIN_HOLDOUT_SESSIONS ||
		delivered.rate === null ||
		holdout.rate === null
	)
		return "insufficient";
	return delivered.rate < holdout.rate ? "helps" : "no_better";
}

/** Pure: delivery rows and decision rows → the effectiveness report. */
export function summarizeLessonEffectiveness(input: {
	deliveries: LearningInteractionEventRow[];
	decisions: LearningInteractionEventRow[];
	/** Current lesson id per topic key, when known. */
	current?: ReadonlyMap<string, string>;
	lessonLimit?: number;
}): Omit<
	GetLessonEffectivenessResult,
	"organizationId" | "since" | "truncated"
> {
	const sessions = new Map<string, Exposure>();
	for (const row of input.deliveries) {
		if (row.surface !== LESSON_DELIVERY_SURFACE || !row.threadId) continue;
		const measured = measuredLessonsOf(row.metadata);
		// Only sessions where learned lessons were in play compare the arms.
		if (measured.length === 0) continue;
		const session = sessions.get(row.threadId) ?? {
			holdout: rec(row.metadata).holdout === true,
			firstAt: row.occurredAt,
			lessons: new Map(),
		};
		if (row.occurredAt < session.firstAt) session.firstAt = row.occurredAt;
		for (const lesson of measured) {
			const seen = session.lessons.get(lesson.topicKey);
			if (!seen || row.occurredAt < seen.firstAt)
				session.lessons.set(lesson.topicKey, {
					id: lesson.id,
					firstAt: row.occurredAt,
					subjects: lesson.subjects,
				});
		}
		sessions.set(row.threadId, session);
	}
	const corrections = new Map<
		string,
		Array<{ at: string; subjects: string[] }>
	>();
	for (const row of input.decisions) {
		if (row.surface !== DECISION_CAPTURE_LEARNING_SURFACE || !row.threadId)
			continue;
		if (!sessions.has(row.threadId)) continue;
		const subjects = correctionSubjects(row);
		if (!subjects) continue;
		const list = corrections.get(row.threadId) ?? [];
		list.push({ at: row.occurredAt, subjects });
		corrections.set(row.threadId, list);
	}

	const overall = { delivered: counter(), holdout: counter() };
	const weeks = new Map<string, { delivered: Counter; holdout: Counter }>();
	const lessons = new Map<
		string,
		{ id: string; subjects: Set<string>; delivered: Counter; holdout: Counter }
	>();
	for (const [sessionId, session] of sessions) {
		const side = session.holdout ? "holdout" : "delivered";
		const after = (corrections.get(sessionId) ?? []).filter(
			(c) => c.at >= session.firstAt,
		);
		overall[side].sessions++;
		overall[side].corrections += after.length;
		const week = weekStart(session.firstAt);
		const bucket = weeks.get(week) ?? {
			delivered: counter(),
			holdout: counter(),
		};
		bucket[side].sessions++;
		bucket[side].corrections += after.length;
		weeks.set(week, bucket);
		for (const [topicKey, exposure] of session.lessons) {
			const entry = lessons.get(topicKey) ?? {
				id: exposure.id,
				subjects: new Set<string>(),
				delivered: counter(),
				holdout: counter(),
			};
			for (const subject of exposure.subjects) entry.subjects.add(subject);
			entry[side].sessions++;
			entry[side].corrections += after.filter(
				(c) =>
					c.at >= exposure.firstAt &&
					c.subjects.some((subject) => exposure.subjects.includes(subject)),
			).length;
			lessons.set(topicKey, entry);
		}
	}

	const entries: LessonEffectivenessEntry[] = [...lessons]
		.map(([topicKey, entry]) => {
			const delivered = arm(entry.delivered);
			const holdout = arm(entry.holdout);
			const lessonId = input.current
				? (input.current.get(topicKey) ?? null)
				: entry.id;
			return {
				topicKey,
				lessonId,
				shortId: lessonId ? lessonId.slice(0, 8) : null,
				subjects: [...entry.subjects].sort(),
				delivered,
				holdout,
				verdict: verdictOf(delivered, holdout),
			};
		})
		.sort(
			(a, b) =>
				b.delivered.sessions - a.delivered.sessions ||
				a.topicKey.localeCompare(b.topicKey),
		);
	return {
		holdoutPercent: HOLDOUT_PERCENT,
		overall: {
			delivered: arm(overall.delivered),
			holdout: arm(overall.holdout),
		},
		weeks: [...weeks]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([week, bucket]) => ({
				weekStart: week,
				delivered: arm(bucket.delivered),
				holdout: arm(bucket.holdout),
			})),
		lessons: entries.slice(0, input.lessonLimit ?? entries.length),
	};
}

/**
 * The caller's view (`get_lesson_effectiveness`): org-wide events plus the
 * caller's own personal ones, the same fence as every learning read.
 */
export async function readLessonEffectiveness(
	context: Pick<
		BaseContext,
		| "db"
		| "authType"
		| "user"
		| "tediId"
		| "descopeUserId"
		| "serviceAccount"
		| "apiKey"
	>,
	organizationId: string,
	weeks: number,
	now: Date = new Date(),
): Promise<GetLessonEffectivenessResult> {
	const actor = observedLearningActor(context);
	const viewer = actor.actorType === "user" ? actor.actorId : null;
	const since = new Date(now.getTime() - weeks * 7 * DAY_MS).toISOString();
	const read = (surface: string) =>
		listLearningInteractions(context.db, {
			organizationId,
			personalScopeId: viewer,
			surfaces: [surface],
			since,
			limit: READ_LIMIT,
		});
	const [deliveries, decisions, current] = await Promise.all([
		read(LESSON_DELIVERY_SURFACE),
		read(DECISION_CAPTURE_LEARNING_SURFACE),
		listApprovedAgentLessons(
			context.db,
			organizationId,
			AGENT_LESSON_TOPIC_PREFIX,
			{ viewerUserId: viewer },
		),
	]);
	const currentByKey = new Map(
		current.flatMap((row) =>
			row.topicKey ? [[row.topicKey, row.id]] : [],
		) as Array<[string, string]>,
	);
	return {
		organizationId,
		since,
		...summarizeLessonEffectiveness({
			deliveries,
			decisions,
			current: currentByKey,
			lessonLimit: LESSONS_SHOWN,
		}),
		truncated:
			deliveries.length >= READ_LIMIT || decisions.length >= READ_LIMIT,
	};
}

export interface RetirementResult {
	evaluated: number;
	decayed: number;
	archived: number;
}

/** The miner's own unreviewed, non-core lesson: the only kind retired here. */
function retirable(row: {
	reviewStatus: string | null;
	metadata: unknown;
	priority?: string | null;
}): boolean {
	return (
		isMinedLesson(row.metadata) &&
		isReplaceableLesson(row) &&
		row.priority !== "core"
	);
}

/**
 * Nightly: decay, then archive, learned lessons that do not reduce
 * corrections on their subject. Conservative by construction: a verdict
 * needs MIN_DELIVERED_SESSIONS and MIN_HOLDOUT_SESSIONS, a decay needs
 * MIN_DELIVERED_CORRECTIONS, at most one decision per lesson and week, and
 * an archive ARCHIVE_STRIKES such weeks.
 */
export async function retireIneffectiveLessons(
	db: DbClient,
	{ orgId, now = new Date() }: { orgId: string; now?: Date },
): Promise<RetirementResult> {
	const result: RetirementResult = { evaluated: 0, decayed: 0, archived: 0 };
	const since = new Date(
		now.getTime() - RETIREMENT_WINDOW_DAYS * DAY_MS,
	).toISOString();
	const read = (surface: string, from: string) =>
		listLearningInteractionsForReflection(db, {
			organizationId: orgId,
			surfaces: [surface],
			since: from,
			limit: READ_LIMIT,
		});
	const deliveries = await read(LESSON_DELIVERY_SURFACE, since);
	if (deliveries.length === 0) return result;
	const decisions = await read(DECISION_CAPTURE_LEARNING_SURFACE, since);
	const report = summarizeLessonEffectiveness({ deliveries, decisions });
	const candidates = report.lessons.filter((lesson) => {
		if (lesson.verdict === "insufficient") return false;
		result.evaluated++;
		return (
			lesson.verdict === "no_better" &&
			lesson.delivered.corrections >= MIN_DELIVERED_CORRECTIONS
		);
	});
	if (candidates.length === 0) return result;

	const current = await listCurrentLearningFeedLessons(
		db,
		orgId,
		AGENT_LESSON_TOPIC_PREFIX,
	);
	const strikeLog = await read(
		LESSON_RETIREMENT_SURFACE,
		new Date(now.getTime() - STRIKE_DAYS * DAY_MS).toISOString(),
	);
	const week = weekStart(now.toISOString());
	for (const lesson of candidates) {
		const facts = current.filter(
			(row) => row.topicKey === lesson.topicKey && retirable(row),
		);
		if (facts.length === 0) continue;
		const strikes =
			new Set(
				strikeLog
					.filter((row) => rec(row.metadata).topicKey === lesson.topicKey)
					.map((row) => weekStart(row.occurredAt)),
			).size + 1;
		const action = strikes >= ARCHIVE_STRIKES ? "archive" : "decay";
		const owner = rec(rec(facts[0]!.metadata).learningFeed).ownerUserId;
		const stats = {
			delivered: lesson.delivered,
			holdout: lesson.holdout,
			subjects: lesson.subjects,
		};
		// The log row is the once-a-week fence: a repeat run this week is a no-op.
		const { duplicate } = await recordLearningInteraction(db, {
			organizationId: orgId,
			actorType: "service",
			actorId: PRODUCER,
			tediId: null,
			clientEventId: `lesson-retirement:${week}:${lesson.topicKey}`.slice(
				0,
				400,
			),
			signalClass: "lifecycle",
			eventKind: "rejected",
			scopeKind:
				typeof owner === "string" && owner ? "personal" : "organization",
			scopeId: typeof owner === "string" && owner ? owner : orgId,
			surface: LESSON_RETIREMENT_SURFACE,
			targetType: "lesson_topic",
			targetId: lesson.topicKey,
			metadata: toJsonRecord({
				schema: "tedix.lesson-retirement.v1",
				topicKey: lesson.topicKey,
				factIds: facts.map((fact) => fact.id),
				action,
				strikes,
				...stats,
			}),
			occurredAt: now.toISOString(),
		});
		if (duplicate) continue;
		for (const fact of facts) {
			const meta = rec(fact.metadata);
			const feed = rec(meta.learningFeed);
			const effectiveness = {
				evaluatedAt: now.toISOString(),
				action,
				strikes,
				...stats,
			};
			if (action === "archive") {
				await updateFact(db, fact.id, {
					archivedAt: now.toISOString(),
					metadata: toJsonRecord({
						...meta,
						learningFeed: {
							...feed,
							effectiveness,
							// Settled: its decisions and rules are not learned again.
							retired: {
								at: now.toISOString(),
								reason: `Corrections on its subject were no lower with it than without it in ${strikes} weeks`,
							},
						},
					}),
				});
				result.archived++;
			} else {
				await updateFact(db, fact.id, {
					confidence: Math.max(
						MIN_CONFIDENCE,
						Math.round((fact.confidence ?? 0.5) * DECAY_FACTOR * 1000) / 1000,
					),
					metadata: toJsonRecord({
						...meta,
						learningFeed: { ...feed, effectiveness },
					}),
				});
				result.decayed++;
			}
			console.log(
				`[lesson-effectiveness] ${action} ${fact.id} (${lesson.topicKey}): delivered ${lesson.delivered.corrections}/${lesson.delivered.sessions}, holdout ${lesson.holdout.corrections}/${lesson.holdout.sessions}, strike ${strikes}`,
			);
		}
	}
	return result;
}
