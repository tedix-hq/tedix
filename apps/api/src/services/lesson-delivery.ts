/**
 * Lesson delivery log and measurement holdout.
 *
 * Every `get_agent_session_lessons` call that names its chat
 * (`sessionId`) records which lessons reached that session as one
 * `learning_interaction_events` row (surface `lesson_delivery`, kind
 * `delivered`, thread = the session), idempotent per session and lesson
 * set, so a long chat that keeps the same lessons adds one row.
 *
 * A stable HOLDOUT_PERCENT of sessions (a hash of the session id) receive no
 * learned lessons: the miner's own (`metadata.learningFeed.autoConfirmed`)
 * are withheld, while written and person-reviewed lessons are always
 * delivered. A holdout row records the learned lessons it withheld, so a
 * lesson's corrections with and without it can be compared
 * (`lesson-effectiveness.ts`).
 *
 * Subjects are the distiller's (`lesson-map-reduce.ts` SUBJECTS). A lesson's
 * subjects and a correction's subjects are read the same deterministic way
 * (its subject tag, else keywords), so a correction counts against a lesson
 * only when it is about what the lesson teaches.
 */

import type { AgentSessionLesson } from "@tedix/api-contract/schemas/agent-session-lessons";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { LearningInteractionEventRow } from "@tedix/db/schema/learning-feedback";
import type { Subject } from "./lesson-map-reduce";

export const LESSON_DELIVERY_SURFACE = "lesson_delivery";
export const LESSON_DELIVERY_SCHEMA = "tedix.lesson-delivery.v1";
/** Share of sessions, by session id, that receive no learned lessons. */
export const HOLDOUT_PERCENT = 10;
const HOLDOUT_SALT = "tedix.lesson-holdout.v1:";

type Meta = Record<string, unknown>;
const rec = (value: unknown): Meta =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Meta)
		: {};
const text = (value: unknown): string =>
	typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

/** Same session id, same arm, always. */
export async function isHoldoutSession(sessionId: string): Promise<boolean> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			`${HOLDOUT_SALT}${sessionId.trim().toLowerCase()}`,
		),
	);
	return new DataView(digest).getUint32(0) % 100 < HOLDOUT_PERCENT;
}

/** Written by the miner without review (not seeded, not person-reviewed). */
export function isMinedLesson(metadata: unknown): boolean {
	return rec(rec(metadata).learningFeed).autoConfirmed === true;
}

/** Keywords per distiller subject; the record keeps every subject covered. */
const SUBJECT_PATTERNS: Record<Subject, RegExp> = {
	communication:
		/\b(?:plain[- ](?:english|language)|shorter|too long|concise|brief(?:ly)?|explain\w*|summar\w*|report\w*|jargon|verbose|wordy|answer\w*|tl;?dr|bullets?)\b/i,
	git: /\b(?:commit\w*|push\w*|branch\w*|rebas\w*|merg\w*|pull requests?|prs?|git)\b/i,
	deploy:
		/\b(?:deploy\w*|ci|pipelines?|live|prod(?:uction)?|releas\w*|verif\w*|proof|prove\w*|health ?checks?|smoke)\b/i,
	agents:
		/\b(?:sub-?agents?|agents?|tedis?|delegat\w*|parallel\w*|fan[- ]?out|models?)\b/i,
	work: /\b(?:work items?|board|tickets?|backlog|claim\w*|leases?|track(?:ing|ed)?)\b/i,
	coding:
		/\b(?:code|tests?|typ(?:e|es|ing)|refactor\w*|simpl\w*|architect\w*|functions?|bugs?|legacy|abstraction\w*|over-?engineer\w*|lint\w*)\b/i,
	personal:
		/\b(?:emails?|calendar|invoices?|meetings?|personal|family|travel)\b/i,
};
const SUBJECT_NAMES = Object.keys(SUBJECT_PATTERNS) as Subject[];

/** Reply classes (decision capture's `classify`) that are corrections. */
export const CORRECTION_REPLY_CLASSES = new Set([
	"correction",
	"challenge",
	"frustration",
	"simplify",
	"verify",
	"plain-english",
]);
/** A drafted reply the person rewrote is a correction too. */
const CORRECTION_KINDS = new Set(["edited", "manually_replaced"]);
const REPLY_CLASS_SUBJECTS: Record<string, Subject> = {
	"plain-english": "communication",
	verify: "deploy",
	simplify: "coding",
};

function subjectsIn(value: string): Subject[] {
	return SUBJECT_NAMES.filter((subject) =>
		SUBJECT_PATTERNS[subject].test(value),
	);
}

function asSubject(value: unknown): Subject | null {
	const slug = text(value).toLowerCase();
	return (SUBJECT_NAMES as string[]).includes(slug) ? (slug as Subject) : null;
}

/**
 * What a lesson teaches: its subject tag (a distilled lesson's topic, or a
 * standing lesson's rule subjects), else the subjects its words name.
 */
export function lessonSubjects(lesson: {
	content: string;
	metadata: unknown;
}): Subject[] {
	const feed = rec(rec(lesson.metadata).learningFeed);
	const topic = text(rec(feed.scope).topic);
	const tagged = asSubject(topic);
	if (tagged) return [tagged];
	const fromRules = Array.isArray(feed.rules)
		? feed.rules.flatMap((rule) => asSubject(rec(rule).subject) ?? [])
		: [];
	if (fromRules.length) return [...new Set(fromRules)];
	return subjectsIn(`${topic.replace(/[-_]/g, " ")} ${lesson.content}`);
}

/**
 * The subjects of a user correction on a decision-capture answer, or null
 * when the answer is not a correction.
 */
export function correctionSubjects(
	event: Pick<LearningInteractionEventRow, "eventKind" | "metadata">,
): Subject[] | null {
	const meta = rec(event.metadata);
	const replyClass = text(meta.replyClass);
	if (
		!CORRECTION_KINDS.has(event.eventKind) &&
		!CORRECTION_REPLY_CLASSES.has(replyClass)
	)
		return null;
	const subjects = new Set(subjectsIn(text(meta.answer)));
	const implied = REPLY_CLASS_SUBJECTS[replyClass];
	if (implied) subjects.add(implied);
	return [...subjects];
}

/** One learned lesson a session received, or (holdout) would have. */
export interface MeasuredLesson {
	id: string;
	topicKey: string;
	subjects: Subject[];
	/** Rule keys delivered (or withheld) from it, to spot misapplied ones. */
	keys?: string[];
}

/** `learning_interaction_events.metadata` of a delivery row. */
export function lessonDeliveryMetadata(input: {
	holdout: boolean;
	harness: string;
	repo?: string;
	delivered: AgentSessionLesson[];
	measured: MeasuredLesson[];
}): Record<string, JsonValue> {
	return {
		schema: LESSON_DELIVERY_SCHEMA,
		holdout: input.holdout,
		harness: input.harness,
		repo: input.repo ?? null,
		lessonIds: input.delivered.map((lesson) => lesson.id),
		// Delivered learned lessons, or the ones a holdout session withheld.
		measured: input.measured.map((lesson) => ({
			id: lesson.id,
			topicKey: lesson.topicKey,
			subjects: lesson.subjects,
			...(lesson.keys ? { keys: lesson.keys } : {}),
		})),
	};
}

/** The measured lessons recorded on a delivery row. */
export function measuredLessonsOf(metadata: unknown): MeasuredLesson[] {
	const measured = rec(metadata).measured;
	if (!Array.isArray(measured)) return [];
	return measured.flatMap((value) => {
		const lesson = rec(value);
		const id = text(lesson.id);
		const topicKey = text(lesson.topicKey);
		if (!id || !topicKey) return [];
		const subjects = Array.isArray(lesson.subjects)
			? lesson.subjects.flatMap((s) => asSubject(s) ?? [])
			: [];
		return [{ id, topicKey, subjects }];
	});
}
