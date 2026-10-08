/**
 * Approved team lessons for local coding-agent sessions.
 *
 * A lesson is a fact whose topic key starts with the given prefix
 * (`learning-feed:`). Only approved lessons are returned: org-wide ones (no
 * tedi, not a personal lesson) plus the viewer's own personal lessons,
 * `review_status = confirmed`, `status = active`, a use policy that allows
 * injection, not archived and not invalidated (superseded facts carry
 * `valid_to`). The prefix is a range on `idx_memory_facts_topic_key`
 * (organization, topic key), so the scan never leaves the lesson keys.
 *
 * A personal lesson carries `metadata.learningFeed.ownerUserId` and
 * `visibility = private`; it reaches only that user, also when it was routed
 * into a tedi's brain. A reviewer who widens it to `org` (or `shared`) makes
 * it an org-wide lesson, provided no tedi owns it.
 */

import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../../query-client";
import { memoryFacts } from "../../schema/memory-graph";

export interface ApprovedAgentLessonRow {
	id: string;
	/** The lesson's lineage: a newer lesson that supersedes it keeps the key. */
	topicKey: string | null;
	content: string;
	priority: "core" | "active" | "background" | null;
	confidence: number;
	metadata: Record<string, JsonValue> | null;
	createdAt: string | null;
	updatedAt: string | null;
}

/** The first string after every string that starts with `prefix`. */
function prefixEnd(prefix: string): string {
	const last = prefix.charCodeAt(prefix.length - 1);
	return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

export async function listApprovedAgentLessons(
	db: DbQueryClient,
	orgId: string,
	topicPrefix: string,
	options: { viewerUserId?: string | null; limit?: number } = {},
): Promise<ApprovedAgentLessonRow[]> {
	const owner = sql`json_extract(${memoryFacts.metadata}, '$.learningFeed.ownerUserId')`;
	const orgWide = and(
		isNull(memoryFacts.tediId),
		or(sql`${memoryFacts.visibility} IS NOT 'private'`, sql`${owner} IS NULL`),
	);
	return db
		.select({
			id: memoryFacts.id,
			topicKey: memoryFacts.topicKey,
			content: memoryFacts.content,
			priority: memoryFacts.priority,
			confidence: memoryFacts.confidence,
			metadata: memoryFacts.metadata,
			createdAt: memoryFacts.createdAt,
			updatedAt: memoryFacts.updatedAt,
		})
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				gte(memoryFacts.topicKey, topicPrefix),
				lt(memoryFacts.topicKey, prefixEnd(topicPrefix)),
				options.viewerUserId
					? or(orgWide, sql`${owner} = ${options.viewerUserId}`)
					: orgWide,
				eq(memoryFacts.reviewStatus, "confirmed"),
				eq(memoryFacts.status, "active"),
				// A confirmed lesson is delivered; one restricted to evidence or
				// barred from injection is not.
				inArray(memoryFacts.usePolicy, [
					"can_use_as_instruction",
					"requires_user_confirmation",
				]),
				isNull(memoryFacts.archivedAt),
				isNull(memoryFacts.validTo),
			),
		)
		.orderBy(desc(memoryFacts.confidence), desc(memoryFacts.updatedAt))
		.limit(options.limit ?? 200);
}

export interface StaleLearningFeedLessonRow {
	id: string;
	reviewStatus: string | null;
	metadata: Record<string, JsonValue> | null;
}

export interface CurrentLearningFeedLessonRow {
	id: string;
	topicKey: string | null;
	content: string;
	reviewStatus: string | null;
	metadata: Record<string, JsonValue> | null;
	priority?: "core" | "active" | "background" | null;
	confidence?: number;
}

/**
 * Every current (not archived, not invalidated) lesson under the prefix, for
 * the miner's cross-lesson consolidation. The caller decides which it may edit.
 */
export async function listCurrentLearningFeedLessons(
	db: DbQueryClient,
	orgId: string,
	topicPrefix: string,
	limit = 500,
): Promise<CurrentLearningFeedLessonRow[]> {
	return db
		.select({
			id: memoryFacts.id,
			topicKey: memoryFacts.topicKey,
			content: memoryFacts.content,
			reviewStatus: memoryFacts.reviewStatus,
			metadata: memoryFacts.metadata,
			priority: memoryFacts.priority,
			confidence: memoryFacts.confidence,
		})
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				gte(memoryFacts.topicKey, topicPrefix),
				lt(memoryFacts.topicKey, prefixEnd(topicPrefix)),
				isNull(memoryFacts.archivedAt),
				isNull(memoryFacts.validTo),
			),
		)
		.limit(limit);
}

/**
 * Current (not archived, not invalidated) lessons under the prefix whose
 * `metadata.learningFeed.lastEventAt` is before `before`. The caller decides
 * which of them it may archive.
 */
export async function listStaleLearningFeedLessons(
	db: DbQueryClient,
	orgId: string,
	topicPrefix: string,
	before: string,
	limit = 200,
): Promise<StaleLearningFeedLessonRow[]> {
	return db
		.select({
			id: memoryFacts.id,
			reviewStatus: memoryFacts.reviewStatus,
			metadata: memoryFacts.metadata,
		})
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				gte(memoryFacts.topicKey, topicPrefix),
				lt(memoryFacts.topicKey, prefixEnd(topicPrefix)),
				isNull(memoryFacts.archivedAt),
				isNull(memoryFacts.validTo),
				sql`json_extract(${memoryFacts.metadata}, '$.learningFeed.lastEventAt') < ${before}`,
			),
		)
		.limit(limit);
}

/**
 * Archived lessons under these exact topic keys. A lesson a person archived
 * still covers its decisions: the miner must not learn them again.
 */
export async function listArchivedLearningFeedLessons(
	db: DbQueryClient,
	orgId: string,
	topicKeys: string[],
	limit = 50,
): Promise<StaleLearningFeedLessonRow[]> {
	if (topicKeys.length === 0) return [];
	return db
		.select({
			id: memoryFacts.id,
			reviewStatus: memoryFacts.reviewStatus,
			metadata: memoryFacts.metadata,
		})
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				// bound-params: capped at 10 keys (callers pass a topic key and its legacy key)
				inArray(memoryFacts.topicKey, topicKeys.slice(0, 10)),
				isNotNull(memoryFacts.archivedAt),
			),
		)
		.limit(limit);
}

/**
 * One person's archived lessons under the prefix. A lesson a person archived
 * still covers its decisions and its rules: the miner must not learn them
 * again. The caller tells a person's archive from the miner's stale archive.
 */
export async function listArchivedLearningFeedLessonsForOwner(
	db: DbQueryClient,
	orgId: string,
	topicPrefix: string,
	ownerUserId: string,
	limit = 200,
): Promise<CurrentLearningFeedLessonRow[]> {
	return db
		.select({
			id: memoryFacts.id,
			topicKey: memoryFacts.topicKey,
			content: memoryFacts.content,
			reviewStatus: memoryFacts.reviewStatus,
			metadata: memoryFacts.metadata,
		})
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				gte(memoryFacts.topicKey, topicPrefix),
				lt(memoryFacts.topicKey, prefixEnd(topicPrefix)),
				isNotNull(memoryFacts.archivedAt),
				sql`json_extract(${memoryFacts.metadata}, '$.learningFeed.ownerUserId') = ${ownerUserId}`,
			),
		)
		.orderBy(desc(memoryFacts.updatedAt))
		.limit(limit);
}
