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

import { filterConsolidatedEvidence } from "./observations";

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
import {
	LessonEvidenceSchema,
	type LessonEvidence,
	type LessonEvidenceSource,
} from "@tedix/api-contract/schemas/agent-session-lessons";
import { learningInteractionEvents } from "../../schema/learning-feedback";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../../query-client";
import { memoryFacts } from "../../schema/memory-graph";
import { batchNonEmpty } from "../../utils/batch";

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
	const rows = await db
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
	return filterEvidenceBackedLessons(db, orgId, rows);
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
	ownerUserId?: string,
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
				ownerUserId
					? sql`json_extract(${memoryFacts.metadata}, '$.learningFeed.ownerUserId') = ${ownerUserId}`
					: undefined,
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

/** Preserve peer edits and tenant ownership when replacing trigger metadata. */
export async function setAgentLessonTriggers(
	db: DbQueryClient,
	orgId: string,
	row: ApprovedAgentLessonRow,
	triggers: import("@tedix/api-contract/schemas/agent-session-lessons").LessonTriggers,
): Promise<boolean> {
	const feed = row.metadata?.learningFeed;
	const learningFeed =
		feed && typeof feed === "object" && !Array.isArray(feed) ? feed : {};
	const changed = await db
		.update(memoryFacts)
		.set({
			metadata: {
				...row.metadata,
				learningFeed: { ...learningFeed, triggers },
			},
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(memoryFacts.id, row.id),
				eq(memoryFacts.organizationId, orgId),
				eq(memoryFacts.content, row.content),
				sql`coalesce(${memoryFacts.metadata}, 'null') = ${JSON.stringify(row.metadata)}`,
				eq(memoryFacts.status, "active"),
				eq(memoryFacts.reviewStatus, "confirmed"),
				isNull(memoryFacts.archivedAt),
				isNull(memoryFacts.validTo),
			),
		)
		.returning({ id: memoryFacts.id });
	return changed.length === 1;
}

/** Undo can retire only the caller's automatically mined lesson, never a person-authored rule. */
export async function archiveCorrectedAgentLessons(
	db: DbQueryClient,
	orgId: string,
	ownerUserId: string,
	eventId: string,
	now: string,
) {
	return db
		.update(memoryFacts)
		.set({ archivedAt: now, validTo: now, updatedAt: now })
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				isNull(memoryFacts.archivedAt),
				sql`json_extract(${memoryFacts.metadata}, '$.learningFeed.ownerUserId') = ${ownerUserId}`,
				sql`json_extract(${memoryFacts.metadata}, '$.learningFeed.autoConfirmed') = 1`,
				sql`EXISTS (SELECT 1 FROM json_each(json_extract(${memoryFacts.metadata}, '$.learningFeed.evidenceEventIds')) AS evidence WHERE evidence.value = ${eventId})`,
			),
		)
		.returning({ id: memoryFacts.id });
}

/** Resolve decision ids within the tenant; quotes are copied from canonical sources. */
export async function decisionLessonEvidence(
	db: DbQueryClient,
	orgId: string,
	ids: string[],
): Promise<LessonEvidence> {
	const sources: LessonEvidenceSource[] = [];
	const unique = [...new Set(ids)];
	for (let offset = 0; offset < unique.length; offset += 50) {
		const rows = await db
			.select({
				id: learningInteractionEvents.id,
				metadata: learningInteractionEvents.metadata,
				eventKind: learningInteractionEvents.eventKind,
			})
			.from(learningInteractionEvents)
			.where(
				and(
					eq(learningInteractionEvents.organizationId, orgId),
					inArray(
						learningInteractionEvents.id,
						unique.slice(offset, offset + 50),
					),
				),
			);
		for (const row of rows) {
			const quote = row.metadata?.answer;
			if (typeof quote === "string" && quote.trim())
				sources.push({
					kind: ["edited", "manually_replaced"].includes(row.eventKind)
						? "correction"
						: "decision",
					id: row.id,
					quote: quote.replace(/\s+/g, " ").trim().slice(0, 280),
				});
		}
	}
	const live = await liveEvidenceSources(db, orgId, sources);
	const supported = sources.filter((s) =>
		live.get(`event:${s.id}`)?.includes(s.quote),
	);
	return {
		version: 1,
		sources: supported,
		supportCount: supported.length,
		...(supported.length === unique.length && supported.length > 0
			? {}
			: { redistillRequestedAt: new Date().toISOString() }),
		state:
			supported.length === unique.length && supported.length > 0
				? "live"
				: "held",
	};
}

/** A held lesson is the existing reflection workflow's re-distillation queue. */
function buildHoldLessonForRedistillationStatement(
	db: DbQueryClient,
	orgId: string,
	id: string,
	expectedMetadata?: Record<string, JsonValue> | null,
) {
	const now = new Date().toISOString();
	return db
		.update(memoryFacts)
		.set({
			updatedAt: now,
			metadata: sql`json_set(COALESCE(${memoryFacts.metadata}, '{}'), '$.learningFeed.evidence.state', 'held', '$.learningFeed.evidence.redistillRequestedAt', ${now})`,
		})
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				eq(memoryFacts.id, id),
				expectedMetadata === undefined
					? undefined
					: sql`coalesce(${memoryFacts.metadata}, 'null') = ${JSON.stringify(expectedMetadata)}`,
				or(
					sql`COALESCE(json_extract(${memoryFacts.metadata}, '$.learningFeed.evidence.state'), '') != 'held'`,
					sql`json_extract(${memoryFacts.metadata}, '$.learningFeed.evidence.redistillRequestedAt') IS NULL`,
				),
			),
		);
}

export async function holdLessonForRedistillation(
	db: DbQueryClient,
	orgId: string,
	id: string,
	expectedMetadata?: Record<string, JsonValue> | null,
): Promise<void> {
	await buildHoldLessonForRedistillationStatement(
		db,
		orgId,
		id,
		expectedMetadata,
	);
}

/** Resolve a set once, in chunks of 50 (under D1's 100 parameter cap). */
async function liveEvidenceSources(
	db: DbQueryClient,
	orgId: string,
	sources: LessonEvidenceSource[],
): Promise<Map<string, string>> {
	const live = new Map<string, string>();
	const factIds = [
		...new Set(sources.filter((s) => s.kind === "fact").map((s) => s.id)),
	];
	const eventIds = [
		...new Set(sources.filter((s) => s.kind !== "fact").map((s) => s.id)),
	];
	for (let i = 0; i < factIds.length; i += 50) {
		const facts = await db
			.select({ id: memoryFacts.id, content: memoryFacts.content })
			.from(memoryFacts)
			.where(
				and(
					eq(memoryFacts.organizationId, orgId),
					inArray(memoryFacts.id, factIds.slice(i, i + 50)),
					isNull(memoryFacts.validTo),
					isNull(memoryFacts.archivedAt),
					inArray(memoryFacts.status, ["active", "probation"]),
					sql`COALESCE(${memoryFacts.reviewStatus}, 'pending') NOT IN ('rejected', 'superseded', 'disputed', 'stale', 'restricted')`,
					sql`NOT EXISTS (SELECT 1 FROM memory_edges e JOIN memory_facts f ON f.id = CASE WHEN e.source_fact_id = ${memoryFacts.id} THEN e.target_fact_id ELSE e.source_fact_id END
    WHERE (e.source_fact_id = ${memoryFacts.id} OR e.target_fact_id = ${memoryFacts.id}) AND e.relation_type IN ('contradicts', 'supersedes')
    AND f.organization_id = ${orgId} AND f.valid_to IS NULL AND f.archived_at IS NULL AND f.status = 'active'
    AND (e.relation_type = 'contradicts' OR e.target_fact_id = ${memoryFacts.id}))`,
				),
			);
		for (const f of facts)
			live.set(`fact:${f.id}`, f.content.replace(/\s+/g, " ").trim());
	}
	for (let i = 0; i < eventIds.length; i += 50) {
		const events = await db
			.select({
				id: learningInteractionEvents.id,
				metadata: learningInteractionEvents.metadata,
			})
			.from(learningInteractionEvents)
			.where(
				and(
					eq(learningInteractionEvents.organizationId, orgId),
					inArray(learningInteractionEvents.id, eventIds.slice(i, i + 50)),
					sql`json_extract(${learningInteractionEvents.metadata}, '$.validTo') IS NULL`,
					sql`json_extract(${learningInteractionEvents.metadata}, '$.supersededBy') IS NULL`,
					sql`NOT EXISTS (SELECT 1 FROM learning_interaction_events c WHERE c.organization_id = ${orgId}
    AND c.occurred_at > ${learningInteractionEvents.occurredAt}
    AND c.scope_kind = ${learningInteractionEvents.scopeKind} AND c.scope_id = ${learningInteractionEvents.scopeId}
    AND c.target_type = ${learningInteractionEvents.targetType} AND c.target_id = ${learningInteractionEvents.targetId}
    AND c.event_kind IN ('edited', 'manually_replaced')
    AND json_extract(c.metadata, '$.answer') IS NOT json_extract(${learningInteractionEvents.metadata}, '$.answer'))`,
				),
			);
		for (const event of events) {
			const answer = event.metadata?.answer;
			if (typeof answer === "string")
				live.set(`event:${event.id}`, answer.replace(/\s+/g, " ").trim());
		}
	}
	return live;
}
function evidenceIsLive(
	evidence: LessonEvidence,
	live: ReadonlyMap<string, string>,
): boolean {
	return (
		evidence.state === "live" &&
		evidence.sources.length > 0 &&
		evidence.supportCount ===
			new Set(
				evidence.sources.map(
					(s) => `${s.kind === "fact" ? "fact" : "event"}:${s.id}`,
				),
			).size &&
		evidence.sources.every((s) =>
			live
				.get(`${s.kind === "fact" ? "fact" : "event"}:${s.id}`)
				?.includes(s.quote),
		)
	);
}
/** Authored lessons need no distillation proof; mined lessons fail closed. */
export async function filterEvidenceBackedLessons<
	T extends { id: string; metadata: Record<string, JsonValue> | null },
>(db: DbQueryClient, orgId: string, rows: T[]): Promise<T[]> {
	const parsedRows = rows
		.map((row) => {
			const feed = row.metadata?.learningFeed;
			return {
				row,
				feed:
					feed && typeof feed === "object" && !Array.isArray(feed)
						? feed
						: undefined,
			};
		})
		.map((r) => ({
			...r,
			parsed: LessonEvidenceSchema.safeParse(r.feed?.evidence),
		}));
	const sourceState = await liveEvidenceSources(
		db,
		orgId,
		parsedRows.flatMap((r) => (r.parsed.success ? r.parsed.data.sources : [])),
	);
	const live: T[] = [];
	const held: T[] = [];
	for (const { row, parsed } of parsedRows) {
		const feed = row.metadata?.learningFeed;
		if (!feed || typeof feed !== "object" || Array.isArray(feed)) {
			live.push(row);
			continue;
		}
		if (
			!parsed.success &&
			feed.evidence === undefined &&
			feed.autoConfirmed !== true &&
			!Array.isArray(feed.evidenceEventIds)
		) {
			live.push(row);
			continue;
		}
		if (parsed.success && evidenceIsLive(parsed.data, sourceState))
			live.push(row);
		else held.push(row);
	}
	for (let offset = 0; offset < held.length; offset += 50) {
		await db.batch(
			batchNonEmpty(
				held
					.slice(offset, offset + 50)
					.map((row) =>
						buildHoldLessonForRedistillationStatement(
							db,
							orgId,
							row.id,
							row.metadata,
						),
					),
			),
		);
	}
	return filterConsolidatedEvidence(db, orgId, live);
}
