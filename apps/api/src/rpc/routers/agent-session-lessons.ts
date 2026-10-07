/**
 * Approved team lessons for a local agent session (`get_agent_session_lessons`).
 *
 * Lessons are brain facts under the `learning-feed:` topic keys (see
 * `@tedix/api-contract/schemas/agent-session-lessons`). The query returns only
 * approved lessons: org-wide ones plus the calling user's own personal ones
 * (`metadata.learningFeed.ownerUserId`); this module filters them to the session's repo
 * and harness by `metadata.learningFeed.scope`, ranks them (repo, then harness,
 * then topic overlap, then priority and confidence) and trims them to the
 * caller's byte budget.
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
import { observedLearningActor } from "../../services/learning-interaction-recorder";
import type { BaseContext } from "../orpc";

/** Per-lesson text cap, so one long fact cannot take the whole budget. */
const LESSON_TEXT_LIMIT = 600;
/** Bytes a rendered lesson line adds beyond its text (id, separators). */
const LINE_OVERHEAD = 16;
/** The learning feed's slug for "no specific value": matches any session. */
const ANY = "general";

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

/** Written by the miner without review (not seeded, not person-reviewed). */
function isMinedLesson(metadata: ApprovedAgentLessonRow["metadata"]): boolean {
	const feed = metadata?.learningFeed;
	return (
		!!feed &&
		typeof feed === "object" &&
		!Array.isArray(feed) &&
		feed.autoConfirmed === true
	);
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
				(row.priority === "core" ? 1 : 0) +
				// A person's standing preferences apply to every session: first.
				(isStandingLesson(row.metadata) ? 10 : 0) +
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
	return { organizationId, ...selectSessionLessons(rows, input) };
}
