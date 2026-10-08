/**
 * Approved team lessons for a local agent session (`get_agent_session_lessons`).
 *
 * Lessons are brain facts under the `learning-feed:` topic keys (see
 * `@tedix/api-contract/schemas/agent-session-lessons`). The query returns only
 * approved lessons: org-wide ones plus the calling user's own personal ones
 * (`metadata.learningFeed.ownerUserId`); this module filters them to the session's repo
 * and harness by `metadata.learningFeed.scope`, ranks them (standing lessons,
 * answer-style lessons, core rules, then repo, harness, topic overlap and
 * confidence) and trims them to the caller's byte budget.
 *
 * With a `sessionId`, a stable 10% of sessions are a measurement holdout that
 * receives no learned lessons, and what each session received is recorded
 * (`services/lesson-delivery.ts`) so `get_lesson_effectiveness` can compare.
 */

import {
	AGENT_LESSON_TOPIC_PREFIX,
	type AgentSessionLesson,
	type GetAgentSessionLessonsResult,
} from "@tedix/api-contract/schemas/agent-session-lessons";
import {
	type ApprovedAgentLessonRow,
	listApprovedAgentLessons,
} from "@tedix/db/queries/memory-graph/agent-lessons";
import {
	observedLearningActor,
	observedLearningEventId,
	recordObservedLearningInteraction,
} from "../../services/learning-interaction-recorder";
import {
	isHoldoutSession,
	isMinedLesson,
	LESSON_DELIVERY_SURFACE,
	lessonDeliveryMetadata,
	lessonSubjects,
	type MeasuredLesson,
} from "../../services/lesson-delivery";
import type { BaseContext } from "../orpc";

/** Per-lesson text cap, so one long fact cannot take the whole budget. */
const LESSON_TEXT_LIMIT = 600;
/** Bytes a rendered lesson line adds beyond its text (id, separators). */
const LINE_OVERHEAD = 16;
/** The learning feed's slug for "no specific value": matches any session. */
const ANY = "general";
/** The miner's answer-style subject (`lesson-map-reduce` SUBJECTS). */
const ANSWER_TOPIC = "communication";

/** `git@github.com:a/b.git`, `https://github.com/a/b` → `github.com/a/b`. */
export function normalizeRepo(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^[a-z+]+:\/\//, "")
		.replace(/^[^@/]+@([^:/]+):/, "$1/")
		.replace(/^[^@/]+@/, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
}

/** A scope repo is a slug (`tedix`) or a path (`tedix-hq/tedix`). */
function repoMatches(tag: string, repo: string): boolean {
	const a = normalizeRepo(tag);
	const b = normalizeRepo(repo);
	return a === b || b.endsWith(`/${a}`) || a.endsWith(`/${b}`);
}

export function normalizeHarness(value: string): string {
	const harness = value.trim().toLowerCase();
	return harness === "claude" || harness === "claude_code"
		? "claude-code"
		: harness;
}

function words(value: string): Set<string> {
	return new Set(
		value
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((word) => word.length >= 3),
	);
}

function slug(value: unknown): string {
	return typeof value === "string" && value.trim()
		? value.trim().toLowerCase()
		: ANY;
}

/** `metadata.learningFeed.scope`; a missing value is `general`. */
export function lessonScope(
	metadata: ApprovedAgentLessonRow["metadata"],
): AgentSessionLesson["scope"] {
	const feed = metadata?.learningFeed;
	const scope =
		feed && typeof feed === "object" && !Array.isArray(feed)
			? feed.scope
			: undefined;
	const record =
		scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {};
	return {
		repo: slug(record.repo),
		harness: slug(record.harness),
		topic: slug(record.topic),
	};
}

/** The learning feed's consolidated standing lesson for one person. */
function isStandingLesson(
	metadata: ApprovedAgentLessonRow["metadata"],
): boolean {
	const feed = metadata?.learningFeed;
	return (
		!!feed &&
		typeof feed === "object" &&
		!Array.isArray(feed) &&
		feed.hoisted === true
	);
}

function lessonText(row: ApprovedAgentLessonRow): string {
	const text = row.content.replace(/\s+/g, " ").trim();
	return text.length > LESSON_TEXT_LIMIT
		? `${text.slice(0, LESSON_TEXT_LIMIT - 1)}…`
		: text;
}

/** Pure selection step, exported for tests. */
export function selectSessionLessons(
	rows: ApprovedAgentLessonRow[],
	session: {
		harness: string;
		repo?: string;
		topics?: string[];
		budgetBytes: number;
	},
): Omit<GetAgentSessionLessonsResult, "organizationId"> {
	const harness = normalizeHarness(session.harness);
	const topicWords = new Set(
		(session.topics ?? []).flatMap((topic) => [...words(topic)]),
	);
	const scored: Array<{ lesson: AgentSessionLesson; score: number }> = [];
	for (const row of rows) {
		const scope = lessonScope(row.metadata);
		const repoScoped = scope.repo !== ANY;
		const harnessScoped = scope.harness !== ANY;
		if (repoScoped && !(session.repo && repoMatches(scope.repo, session.repo)))
			continue;
		if (harnessScoped && normalizeHarness(scope.harness) !== harness) continue;
		const text = lessonText(row);
		const lessonWords = words(
			`${scope.topic === ANY ? "" : scope.topic} ${text}`,
		);
		const overlap = [...topicWords].filter((word) =>
			lessonWords.has(word),
		).length;
		scored.push({
			score:
				(repoScoped ? 2 : 0) +
				(harnessScoped ? 1 : 0) +
				Math.min(overlap, 3) +
				// A core rule (naming, shipping) must survive a crowded budget.
				(row.priority === "core" ? 4 : 0) +
				// A person's standing preferences apply to every session: first.
				(isStandingLesson(row.metadata) ? 10 : 0) +
				// How to answer shapes every reply: next after standing ones.
				(scope.topic === ANSWER_TOPIC ? 6 : 0) +
				// A written or person-reviewed rule outranks a mined one of the same reach.
				(isMinedLesson(row.metadata) ? 0 : 2) +
				row.confidence,
			lesson: {
				id: row.id,
				shortId: row.id.slice(0, 8),
				text,
				scope,
				updatedAt: row.updatedAt,
			},
		});
	}
	scored.sort((a, b) => b.score - a.score);
	const encoder = new TextEncoder();
	const lessons: AgentSessionLesson[] = [];
	let used = 0;
	for (const { lesson } of scored) {
		const bytes = encoder.encode(lesson.text).length + LINE_OVERHEAD;
		if (used + bytes > session.budgetBytes) continue;
		used += bytes;
		lessons.push(lesson);
	}
	return {
		lessons,
		matched: scored.length,
		truncated: lessons.length < scored.length,
	};
}

export async function getSessionLessons(
	context: BaseContext,
	organizationId: string,
	input: {
		harness: string;
		repo?: string;
		topics?: string[];
		budgetBytes: number;
		sessionId?: string;
	},
): Promise<GetAgentSessionLessonsResult> {
	// The same server-derived identity the learning ledger records answers
	// under, so a user's personal lessons come back only to that user.
	const actor = observedLearningActor(context);
	const rows = await listApprovedAgentLessons(
		context.db,
		organizationId,
		AGENT_LESSON_TOPIC_PREFIX,
		{ viewerUserId: actor.actorType === "user" ? actor.actorId : null },
	);
	const selected = selectSessionLessons(rows, input);
	const sessionId = input.sessionId?.toLowerCase();
	if (!sessionId) return { organizationId, ...selected };
	// A holdout session gets every lesson except the miner's own.
	const holdout = await isHoldoutSession(sessionId);
	const result = holdout
		? selectSessionLessons(
				rows.filter((row) => !isMinedLesson(row.metadata)),
				input,
			)
		: selected;
	// The learned lessons this session got, or (holdout) would have got.
	const byId = new Map(rows.map((row) => [row.id, row]));
	const measured: MeasuredLesson[] = selected.lessons.flatMap((lesson) => {
		const row = byId.get(lesson.id);
		if (!row || !isMinedLesson(row.metadata)) return [];
		return [
			{
				id: row.id,
				topicKey: row.topicKey ?? `fact:${row.id}`,
				subjects: lessonSubjects(row),
			},
		];
	});
	const record = recordLessonDelivery(context, organizationId, {
		sessionId,
		harness: normalizeHarness(input.harness),
		repo: input.repo ? normalizeRepo(input.repo) : undefined,
		holdout,
		delivered: result.lessons,
		measured,
	});
	// Measurement never delays or fails the lessons themselves.
	if (context.waitUntil) context.waitUntil(record);
	else await record;
	return { organizationId, ...result, holdout };
}

/** One row per session and lesson set (fail-soft, see the recorder). */
async function recordLessonDelivery(
	context: BaseContext,
	organizationId: string,
	input: {
		sessionId: string;
		harness: string;
		repo?: string;
		holdout: boolean;
		delivered: AgentSessionLesson[];
		measured: MeasuredLesson[];
	},
): Promise<void> {
	try {
		await recordObservedLearningInteraction(context, {
			organizationId,
			clientEventId: await observedLearningEventId(
				"lesson-delivery",
				input.sessionId,
				input.holdout ? "holdout" : "delivered",
				input.delivered
					.map((lesson) => lesson.id)
					.sort()
					.join(","),
				input.measured
					.map((lesson) => lesson.id)
					.sort()
					.join(","),
			),
			signalClass: "lifecycle",
			eventKind: "delivered",
			surface: LESSON_DELIVERY_SURFACE,
			targetType: "agent_session",
			targetId: input.sessionId,
			threadId: input.sessionId,
			metadata: lessonDeliveryMetadata(input),
		});
	} catch (error) {
		console.warn("[lesson-delivery] record failed:", error);
	}
}
