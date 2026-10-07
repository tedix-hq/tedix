/**
 * Cross-lesson consolidation for one person's distilled learning-feed lessons.
 *
 * Distillation runs per scope (repo, harness, topic), so a standing habit
 * ("answer in short plain English") is restated in many topic lessons and
 * fills the small delivery budget with repeats. After each mining run, a rule
 * found in two or more of a person's lessons is hoisted into ONE standing
 * lesson for that person (scope general/general, delivered in every session,
 * ranked first) and removed from the topic lessons; a topic lesson left with
 * no rule is retired. Only lessons the miner owns are touched: auto-confirmed,
 * distilled by the current distiller, never one a person reviewed.
 */

import type { DbClient } from "@tedix/db/client";
import { getOrCreateDomain } from "@tedix/db/queries/memory-graph/domains";
import { invalidateFact } from "@tedix/db/queries/memory-graph/fact-lifecycle";
import { createFact, updateFact } from "@tedix/db/queries/memory-graph/facts";
import {
	type CurrentLearningFeedLessonRow,
	listCurrentLearningFeedLessons,
} from "@tedix/db/queries/memory-graph/agent-lessons";
import { toJsonRecord } from "@tedix/db/utils/json";
import { DISTILL_VERSION } from "./lesson-distiller";

export const STANDING_TOPIC = "standing";
const LESSON_PREFIX = "learning-feed:decision:";
/** Delivery shows at most 600 characters of one lesson. */
const STANDING_CHARS = 600;
const STANDING_HEADER =
	"Standing preferences from your decisions across sessions:";
const MIN_LESSONS_FOR_STANDING = 2;
const SIMILAR = 0.6;

type Meta = Record<string, unknown>;
const rec = (value: unknown): Meta =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Meta)
		: {};

export function standingTopicKey(userId: string): string {
	return `${LESSON_PREFIX}general:general:${STANDING_TOPIC}:user:${userId}`;
}

const STOP = new Set(
	"the and for not you your with from into that this them they are all any its use own".split(
		" ",
	),
);

function ruleWords(rule: string): Set<string> {
	return new Set(
		rule
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((word) => word.length >= 3 && !STOP.has(word)),
	);
}

function similar(a: Set<string>, b: Set<string>): boolean {
	if (a.size === 0 || b.size === 0) return false;
	const shared = [...a].filter((word) => b.has(word)).length;
	return shared / new Set([...a, ...b]).size >= SIMILAR;
}

/** `header\n- rule\n- rule` → [header, rules]. */
export function splitLesson(content: string): [string, string[]] {
	const [header = "", ...lines] = content.split("\n");
	return [
		header,
		lines
			.filter((line) => line.startsWith("- "))
			.map((line) => line.slice(2).trim())
			.filter(Boolean),
	];
}

export interface ConsolidationPlan {
	/** Shared rules, most widespread first. */
	standing: string[];
	/** Topic lessons to rewrite: fact id → remaining rules (empty: retire). */
	topics: Map<string, string[]>;
}

/** Pure: which rules several lessons share, and what each lesson keeps. */
export function planConsolidation(
	lessons: Array<{ id: string; content: string }>,
): ConsolidationPlan {
	const groups: Array<{ words: Set<string>; text: string; ids: Set<string> }> =
		[];
	const parsed = lessons.map((lesson) => ({
		id: lesson.id,
		rules: splitLesson(lesson.content)[1],
	}));
	for (const lesson of parsed)
		for (const rule of lesson.rules) {
			const words = ruleWords(rule);
			const group = groups.find((g) => similar(g.words, words));
			if (group) group.ids.add(lesson.id);
			else groups.push({ words, text: rule, ids: new Set([lesson.id]) });
		}
	const shared = groups
		.filter((g) => g.ids.size >= MIN_LESSONS_FOR_STANDING)
		.sort((a, b) => b.ids.size - a.ids.size);
	const standing: string[] = [];
	let length = STANDING_HEADER.length;
	for (const group of shared) {
		const line = group.text.replace(/[.;]+$/, "");
		if (length + line.length + 4 > STANDING_CHARS) break;
		standing.push(line);
		length += line.length + 4;
	}
	const hoisted = shared
		.filter((g) => standing.includes(g.text.replace(/[.;]+$/, "")))
		.map((g) => g.words);
	const topics = new Map<string, string[]>();
	for (const lesson of parsed) {
		const keep = lesson.rules.filter(
			(rule) => !hoisted.some((words) => similar(words, ruleWords(rule))),
		);
		if (keep.length !== lesson.rules.length) topics.set(lesson.id, keep);
	}
	return { standing, topics };
}

/** Written by the miner and never reviewed by a person. */
function minerWritten(row: CurrentLearningFeedLessonRow): boolean {
	const meta = rec(row.metadata);
	return (
		!rec(meta.memoryLifecycle).lastReview &&
		(row.reviewStatus === "pending" ||
			(row.reviewStatus === "confirmed" &&
				rec(meta.learningFeed).autoConfirmed === true))
	);
}

/** ...and distilled by the current distiller, so its lines are rules. */
function ownedByMiner(row: CurrentLearningFeedLessonRow): boolean {
	return (
		minerWritten(row) &&
		row.reviewStatus === "confirmed" &&
		rec(rec(row.metadata).learningFeed).distilled === DISTILL_VERSION
	);
}

/** A per-repository lesson of imported sessions (harness and topic general). */
function isSubjectLesson(row: CurrentLearningFeedLessonRow): boolean {
	const scope = rec(rec(rec(row.metadata).learningFeed).scope);
	return scope.harness === "general" && scope.topic === "general";
}

/**
 * Reply classes the session importer assigned (`classify` in the CLI). An
 * imported lesson was once keyed by host and one of these; live decision
 * capture uses triage labels and draft turn types instead.
 */
const IMPORT_REPLY_CLASSES = new Set([
	"frustration",
	"correction",
	"challenge",
	"verify",
	"plain-english",
	"simplify",
	"fan-out",
	"ship",
	"approve",
	"status",
	"continue",
	"question",
	"instruction",
]);

/** A lesson of imported sessions under the retired per-reply-type grouping. */
function isReplyTypeLesson(row: CurrentLearningFeedLessonRow): boolean {
	const scope = rec(rec(rec(row.metadata).learningFeed).scope);
	return (
		(scope.harness === "codex" || scope.harness === "claude-code") &&
		typeof scope.topic === "string" &&
		IMPORT_REPLY_CLASSES.has(scope.topic)
	);
}

function evidenceOf(row: CurrentLearningFeedLessonRow): string[] {
	const ids = rec(rec(row.metadata).learningFeed).evidenceEventIds;
	return Array.isArray(ids)
		? ids.filter((id): id is string => typeof id === "string")
		: [];
}

export interface ConsolidationResult {
	standingWritten: number;
	topicLessonsTrimmed: number;
	topicLessonsRetired: number;
}

export async function consolidatePersonalLessons(
	db: DbClient,
	orgId: string,
): Promise<ConsolidationResult> {
	const result: ConsolidationResult = {
		standingWritten: 0,
		topicLessonsTrimmed: 0,
		topicLessonsRetired: 0,
	};
	const rows = await listCurrentLearningFeedLessons(db, orgId, LESSON_PREFIX);
	const byOwner = new Map<string, CurrentLearningFeedLessonRow[]>();
	for (const row of rows) {
		const owner = rec(rec(row.metadata).learningFeed).ownerUserId;
		if (typeof owner !== "string" || !owner) continue;
		byOwner.set(owner, [...(byOwner.get(owner) ?? []), row]);
	}
	for (const [userId, all] of byOwner) {
		const key = standingTopicKey(userId);
		// A lesson whose every decision a per-repository subject lesson now
		// covers was learned under the old per-reply-type grouping: retire it.
		const subjectEvidence = new Set(
			all
				.filter((row) => isSubjectLesson(row) && ownedByMiner(row))
				.flatMap((row) => evidenceOf(row)),
		);
		const lessons: CurrentLearningFeedLessonRow[] = [];
		for (const row of all) {
			const evidence = evidenceOf(row);
			if (
				row.topicKey !== key &&
				!isSubjectLesson(row) &&
				minerWritten(row) &&
				((evidence.length > 0 &&
					evidence.every((id) => subjectEvidence.has(id))) ||
					(subjectEvidence.size > 0 && isReplyTypeLesson(row)))
			) {
				await invalidateFact(db, row.id, "Folded into its subject lesson");
				result.topicLessonsRetired++;
				continue;
			}
			lessons.push(row);
		}
		const existing = lessons.filter((row) => row.topicKey === key);
		const topicLessons = lessons.filter(
			(row) => row.topicKey !== key && ownedByMiner(row),
		);
		// Rules hoisted earlier stay standing until no topic restates them.
		const plan = planConsolidation([
			...existing.map((row) => ({ id: row.id, content: row.content })),
			...topicLessons.map((row) => ({ id: row.id, content: row.content })),
		]);
		const previous = existing.flatMap((row) => splitLesson(row.content)[1]);
		const standing = [
			...plan.standing,
			...previous.filter(
				(rule) =>
					!plan.standing.some((s) => similar(ruleWords(s), ruleWords(rule))),
			),
		];
		for (const row of topicLessons) {
			const keep = plan.topics.get(row.id);
			if (!keep) continue;
			if (keep.length === 0) {
				await invalidateFact(
					db,
					row.id,
					`Every rule is in the standing lesson ${key}`,
				);
				result.topicLessonsRetired++;
				continue;
			}
			const [header] = splitLesson(row.content);
			await updateFact(db, row.id, {
				content: [header, ...keep.map((rule) => `- ${rule}`)].join("\n"),
				summary: keep[0]!.slice(0, 100),
			});
			result.topicLessonsTrimmed++;
		}
		if (standing.length === 0) continue;
		let content = STANDING_HEADER;
		for (const rule of standing) {
			const next = `${content}\n- ${rule}`;
			if (next.length > STANDING_CHARS) break;
			content = next;
		}
		if (existing.some((row) => row.content === content)) continue;
		await writeStanding(db, orgId, userId, content, [
			...existing,
			...topicLessons,
		]);
		for (const old of existing)
			await invalidateFact(db, old.id, `Superseded by a newer ${key}`);
		result.standingWritten++;
	}
	return result;
}

async function writeStanding(
	db: DbClient,
	orgId: string,
	userId: string,
	content: string,
	sources: CurrentLearningFeedLessonRow[],
): Promise<void> {
	const feeds = sources.map((row) => rec(rec(row.metadata).learningFeed));
	const evidence = [
		...new Set(
			feeds.flatMap((feed) =>
				Array.isArray(feed.evidenceEventIds)
					? feed.evidenceEventIds.filter(
							(id): id is string => typeof id === "string",
						)
					: [],
			),
		),
	].slice(0, 200);
	const lastEventAt =
		feeds
			.map((feed) =>
				typeof feed.lastEventAt === "string" ? feed.lastEventAt : "",
			)
			.sort()
			.at(-1) || new Date().toISOString();
	const domain = await getOrCreateDomain(db, orgId, "operations");
	const now = new Date().toISOString();
	await createFact(db, {
		id: crypto.randomUUID(),
		organizationId: orgId,
		tediId: null,
		domainId: domain.id,
		content,
		summary: content.split("\n")[1]?.slice(2, 102) ?? content.slice(0, 100),
		factType: "preference",
		confidence: 0.7,
		priority: "core",
		status: "active",
		reviewStatus: "confirmed",
		usePolicy: "requires_user_confirmation",
		lastVerifiedAt: now,
		memoryScope: "org",
		visibility: "private",
		topicKey: standingTopicKey(userId),
		validFrom: now,
		validTo: null,
		archivedAt: null,
		source: `learning-feed:standing:${orgId}:${userId}`,
		sourceSessionId: null,
		sourceUrl: null,
		sourceHash: null,
		metadata: toJsonRecord({
			producer: "learning-feed",
			sourceKind: "brain-reflection",
			expectedUse:
				"Deliver the user's standing preferences to every one of their agent sessions",
			learningFeed: {
				version: 1,
				kind: "decision",
				scope: { repo: "general", harness: "general", topic: STANDING_TOPIC },
				evidenceEventIds: evidence,
				learnedFromUserIds: [userId],
				ownerUserId: userId,
				autoConfirmed: true,
				signalCounts: {},
				lastEventAt,
				distilled: DISTILL_VERSION,
				hoisted: true,
			},
		}),
		accessCount: 0,
	});
}
