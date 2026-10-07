import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	lt,
	lte,
	max,
	ne,
	or,
} from "drizzle-orm";
import type { DbClient } from "../client";
import { batchNonEmpty, chunkForBoundParams } from "../utils/batch";
import {
	type LearningFeedbackAttributionRow,
	type LearningFeedbackMeasurementRow,
	type LearningImprovementProposalRow,
	type LearningInteractionEventRow,
	learningFeedbackAttributions,
	learningFeedbackMeasurements,
	learningImprovementProposals,
	learningInteractionEvents,
} from "../schema/learning-feedback";

type LearningChangeKind = LearningFeedbackAttributionRow["changeKind"];
type LearningImprovementStatus = LearningImprovementProposalRow["status"];
type LearningInteractionKind = LearningInteractionEventRow["eventKind"];
type LearningPromotionRoute = LearningImprovementProposalRow["promotionRoute"];
type LearningScopeKind = LearningInteractionEventRow["scopeKind"];
type LearningSignalClass = LearningInteractionEventRow["signalClass"];
type LearningSubjectKind = LearningFeedbackAttributionRow["subjectKind"];
type LearningMeasurementWindow = LearningFeedbackMeasurementRow["windowKind"];

export type LearningFeedbackSummaryResult = {
	subjectKind: LearningSubjectKind;
	subjectId: string;
	issueKey: string | null;
	attributionCount: number;
	attributedEventCount: number;
	eventKinds: Record<string, number>;
	baseline: LearningFeedbackRateResult | null;
	followup: LearningFeedbackRateResult | null;
	recurrenceRateDelta: number | null;
	improved: boolean | null;
};

export type LearningFeedbackRateResult = {
	measurementId: string;
	attributionId: string;
	windowStart: string;
	windowEnd: string;
	opportunityCount: number;
	recurrenceCount: number;
	successCount: number;
	recurrenceRate: number;
	successRate: number;
};

export type RecurringLearningIssueResult = {
	issueKey: string;
	tediId: string | null;
	scopeKind: LearningScopeKind;
	scopeId: string;
	occurrenceCount: number;
	negativeCount: number;
	acceptedCount: number;
	uniqueActorCount: number;
	uniqueRunCount: number;
	eventKinds: Record<string, number>;
	evidenceEventIds: string[];
	firstOccurredAt: string;
	lastOccurredAt: string;
	eligible: boolean;
};

export class LearningFeedbackIdempotencyConflictError extends Error {
	constructor(
		kind: "interaction" | "attribution" | "measurement" | "proposal",
	) {
		super(`Idempotency key was already used for a different ${kind}`);
		this.name = "LearningFeedbackIdempotencyConflictError";
	}
}

const NEGATIVE_INTERACTION_KINDS = new Set<LearningInteractionKind>([
	"edited",
	"ignored",
	"rejected",
	"retried",
	"undone",
	"manually_replaced",
	"completed_elsewhere",
]);

export function promotionRouteForSubject(
	subjectKind: LearningSubjectKind,
): LearningPromotionRoute {
	switch (subjectKind) {
		case "memory_fact":
			return "memory_fact_governance";
		case "directive":
			return "directive_governance";
		case "skill":
			return "skill_workshop";
		case "harness_version":
			return "harness_promotion";
		case "workflow":
			return "workflow_improvement";
	}
}

export async function recordLearningInteraction(
	db: DbClient,
	input: {
		organizationId: string;
		actorType: LearningInteractionEventRow["actorType"];
		actorId?: string | null;
		tediId?: string | null;
		clientEventId: string;
		signalClass?: LearningSignalClass;
		eventKind: LearningInteractionKind;
		scopeKind: LearningScopeKind;
		scopeId: string;
		issueKey?: string | null;
		surface: string;
		targetType?: string | null;
		targetId?: string | null;
		threadId?: string | null;
		runId?: string | null;
		metadata?: Record<string, JsonValue> | null;
		occurredAt: string;
	},
): Promise<{ event: LearningInteractionEventRow; duplicate: boolean }> {
	const inserted = await db
		.insert(learningInteractionEvents)
		.values({ ...input, signalClass: input.signalClass ?? "quality" })
		.onConflictDoNothing({
			target: [
				learningInteractionEvents.organizationId,
				learningInteractionEvents.clientEventId,
			],
		})
		.returning();
	const insertedRow = inserted[0];
	if (insertedRow) {
		return { event: insertedRow, duplicate: false };
	}

	const existing = await db
		.select()
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, input.organizationId),
				eq(learningInteractionEvents.clientEventId, input.clientEventId),
			),
		)
		.limit(1);
	const existingRow = existing[0];
	if (!existingRow) {
		throw new Error("Learning interaction conflict did not resolve to a row");
	}
	if (
		existingRow.actorType !== input.actorType ||
		existingRow.actorId !== (input.actorId ?? null) ||
		existingRow.tediId !== (input.tediId ?? null) ||
		existingRow.signalClass !== (input.signalClass ?? "quality") ||
		existingRow.eventKind !== input.eventKind ||
		existingRow.scopeKind !== input.scopeKind ||
		existingRow.scopeId !== input.scopeId ||
		existingRow.issueKey !== (input.issueKey ?? null) ||
		existingRow.surface !== input.surface ||
		existingRow.targetType !== (input.targetType ?? null) ||
		existingRow.targetId !== (input.targetId ?? null) ||
		existingRow.threadId !== (input.threadId ?? null) ||
		existingRow.runId !== (input.runId ?? null)
	) {
		throw new LearningFeedbackIdempotencyConflictError("interaction");
	}
	return { event: existingRow, duplicate: true };
}

export async function listLearningInteractions(
	db: DbClient,
	input: {
		organizationId: string;
		tediId?: string;
		personalScopeId?: string | null;
		eventKind?: LearningInteractionKind;
		scopeKind?: LearningScopeKind;
		scopeId?: string;
		issueKey?: string;
		since?: string;
		until?: string;
		limit: number;
	},
): Promise<LearningInteractionEventRow[]> {
	const conditions = [
		eq(learningInteractionEvents.organizationId, input.organizationId),
	];
	conditions.push(
		input.personalScopeId
			? (or(
					ne(learningInteractionEvents.scopeKind, "personal"),
					and(
						eq(learningInteractionEvents.scopeKind, "personal"),
						eq(learningInteractionEvents.scopeId, input.personalScopeId),
					),
				) as (typeof conditions)[number])
			: ne(learningInteractionEvents.scopeKind, "personal"),
	);
	if (input.tediId) {
		conditions.push(eq(learningInteractionEvents.tediId, input.tediId));
	}
	if (input.eventKind) {
		conditions.push(eq(learningInteractionEvents.eventKind, input.eventKind));
	}
	if (input.scopeKind) {
		conditions.push(eq(learningInteractionEvents.scopeKind, input.scopeKind));
	}
	if (input.scopeId) {
		conditions.push(eq(learningInteractionEvents.scopeId, input.scopeId));
	}
	if (input.issueKey) {
		conditions.push(eq(learningInteractionEvents.issueKey, input.issueKey));
	}
	if (input.since) {
		conditions.push(gte(learningInteractionEvents.occurredAt, input.since));
	}
	if (input.until) {
		conditions.push(lte(learningInteractionEvents.occurredAt, input.until));
	}
	const rows = await db
		.select()
		.from(learningInteractionEvents)
		.where(and(...conditions))
		.orderBy(desc(learningInteractionEvents.occurredAt))
		.limit(input.limit);
	return rows;
}

/**
 * Server-side reflection read of one organization's events on the given
 * surfaces, every scope included. Personal events are returned for every
 * member: only the reflection workflow (a service actor that writes governed,
 * review-pending memory) may call this — never a user-facing handler, which
 * must use {@link listLearningInteractions} and its personal-scope fence.
 */
export async function listLearningInteractionsForReflection(
	db: DbClient,
	input: {
		organizationId: string;
		surfaces: string[];
		since: string;
		limit: number;
	},
): Promise<LearningInteractionEventRow[]> {
	if (input.surfaces.length === 0) return [];
	return db
		.select()
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, input.organizationId),
				// bound-params: callers pass a fixed list of producer surfaces
				inArray(learningInteractionEvents.surface, input.surfaces),
				gte(learningInteractionEvents.occurredAt, input.since),
			),
		)
		.orderBy(desc(learningInteractionEvents.occurredAt))
		.limit(input.limit);
}

function ownedBy(userId: string | undefined) {
	return userId
		? and(
				eq(learningInteractionEvents.scopeKind, "personal"),
				eq(learningInteractionEvents.scopeId, userId),
			)
		: undefined;
}

/**
 * Issue keys that have events on one producer surface, most recently active
 * first. Reflection-only (same fence as
 * {@link listLearningInteractionsForReflection}): it lets a miner walk a large
 * historic backlog one scope at a time instead of one time window.
 */
export async function listLearningIssueKeysForReflection(
	db: DbClient,
	input: {
		organizationId: string;
		surface: string;
		/** Only this person's own personal-scope events. */
		ownerUserId?: string;
		limit: number;
	},
): Promise<string[]> {
	const lastAt = max(learningInteractionEvents.occurredAt);
	const rows = await db
		.select({ issueKey: learningInteractionEvents.issueKey, lastAt })
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, input.organizationId),
				eq(learningInteractionEvents.surface, input.surface),
				isNotNull(learningInteractionEvents.issueKey),
				ownedBy(input.ownerUserId),
			),
		)
		.groupBy(learningInteractionEvents.issueKey)
		.orderBy(desc(lastAt))
		.limit(input.limit);
	return rows.flatMap((row) => (row.issueKey ? [row.issueKey] : []));
}

/** Newest events of one issue key on the given producer surfaces. Reflection-only. */
export async function listLearningInteractionsForIssueKey(
	db: DbClient,
	input: {
		organizationId: string;
		issueKey: string;
		surfaces: string[];
		/** Only this person's own personal-scope events. */
		ownerUserId?: string;
		limit: number;
	},
): Promise<LearningInteractionEventRow[]> {
	if (input.surfaces.length === 0) return [];
	return db
		.select()
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, input.organizationId),
				eq(learningInteractionEvents.issueKey, input.issueKey),
				// bound-params: callers pass a fixed list of producer surfaces
				inArray(learningInteractionEvents.surface, input.surfaces),
				ownedBy(input.ownerUserId),
			),
		)
		.orderBy(desc(learningInteractionEvents.occurredAt))
		.limit(input.limit);
}

/**
 * Newest events whose issue key starts with `issuePrefix` (a range on
 * `idx_learning_event_issue`), on the given producer surfaces. Reflection-only.
 */
export async function listLearningInteractionsForIssuePrefix(
	db: DbClient,
	input: {
		organizationId: string;
		issuePrefix: string;
		surfaces: string[];
		limit: number;
	},
): Promise<LearningInteractionEventRow[]> {
	if (input.surfaces.length === 0 || !input.issuePrefix) return [];
	const last = input.issuePrefix.charCodeAt(input.issuePrefix.length - 1);
	const end = input.issuePrefix.slice(0, -1) + String.fromCharCode(last + 1);
	return db
		.select()
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, input.organizationId),
				gte(learningInteractionEvents.issueKey, input.issuePrefix),
				lt(learningInteractionEvents.issueKey, end),
				// bound-params: callers pass a fixed list of producer surfaces
				inArray(learningInteractionEvents.surface, input.surfaces),
			),
		)
		.orderBy(desc(learningInteractionEvents.occurredAt))
		.limit(input.limit);
}

/** Rows per INSERT: 18 columns each keeps a statement under D1's 100 bound params. */
const INTERACTION_INSERT_CHUNK = 5;

/**
 * Insert many learning events in one D1 batch, idempotent per
 * (organization, clientEventId): an existing key is skipped, never compared or
 * overwritten. Returns how many rows were new.
 */
export async function recordLearningInteractionsBatch(
	db: DbClient,
	rows: Array<
		Omit<
			typeof learningInteractionEvents.$inferInsert,
			"id" | "createdAt" | "signalClass"
		> & { signalClass?: LearningSignalClass }
	>,
): Promise<{ recorded: number }> {
	if (rows.length === 0) return { recorded: 0 };
	const statements = chunkForBoundParams(rows, INTERACTION_INSERT_CHUNK).map(
		(chunk) =>
			db
				.insert(learningInteractionEvents)
				.values(
					chunk.map((row) => ({
						...row,
						id: crypto.randomUUID(),
						signalClass: row.signalClass ?? "quality",
					})),
				)
				.onConflictDoNothing({
					target: [
						learningInteractionEvents.organizationId,
						learningInteractionEvents.clientEventId,
					],
				})
				.returning({ id: learningInteractionEvents.id }),
	);
	const results = await db.batch(batchNonEmpty(statements));
	return {
		recorded: results.reduce(
			(sum, inserted) => sum + (inserted as unknown[]).length,
			0,
		),
	};
}

export async function getLearningInteractionsByIds(
	db: DbClient,
	organizationId: string,
	ids: string[],
): Promise<LearningInteractionEventRow[]> {
	if (ids.length === 0) return [];
	const rows: LearningInteractionEventRow[] = [];
	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	for (const chunk of chunkForBoundParams([...new Set(ids)], 50)) {
		rows.push(
			...(await db
				.select()
				.from(learningInteractionEvents)
				.where(
					and(
						eq(learningInteractionEvents.organizationId, organizationId),
						inArray(learningInteractionEvents.id, chunk),
					),
				)),
		);
	}
	return rows;
}

export async function attributeLearningFeedback(
	db: DbClient,
	input: {
		organizationId: string;
		clientAttributionId: string;
		feedbackEventIds: string[];
		subjectKind: LearningSubjectKind;
		subjectId: string;
		changeKind: LearningChangeKind;
		rationale?: string | null;
		evidenceRefs: string[];
		metadata?: Record<string, JsonValue> | null;
		occurredAt: string;
	},
): Promise<{
	attributions: LearningFeedbackAttributionRow[];
	created: number;
	duplicates: number;
}> {
	const inserted = await db
		.insert(learningFeedbackAttributions)
		.values(
			input.feedbackEventIds.map((feedbackEventId) => ({
				organizationId: input.organizationId,
				clientAttributionId: input.clientAttributionId,
				feedbackEventId,
				subjectKind: input.subjectKind,
				subjectId: input.subjectId,
				changeKind: input.changeKind,
				rationale: input.rationale,
				evidenceRefs: input.evidenceRefs,
				metadata: input.metadata,
				occurredAt: input.occurredAt,
			})),
		)
		.onConflictDoNothing()
		.returning();

	const rows: LearningFeedbackAttributionRow[] = [];
	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	for (const chunk of chunkForBoundParams(
		[...new Set(input.feedbackEventIds)],
		50,
	)) {
		rows.push(
			...(await db
				.select()
				.from(learningFeedbackAttributions)
				.where(
					and(
						eq(
							learningFeedbackAttributions.organizationId,
							input.organizationId,
						),
						eq(
							learningFeedbackAttributions.clientAttributionId,
							input.clientAttributionId,
						),
						inArray(learningFeedbackAttributions.feedbackEventId, chunk),
					),
				)),
		);
	}
	// Re-establish the single-statement ordering across chunks.
	rows.sort((a, b) => a.feedbackEventId.localeCompare(b.feedbackEventId));
	if (
		rows.some(
			(row) =>
				row.subjectKind !== input.subjectKind ||
				row.subjectId !== input.subjectId ||
				row.changeKind !== input.changeKind,
		)
	) {
		throw new LearningFeedbackIdempotencyConflictError("attribution");
	}

	return {
		attributions: rows,
		created: inserted.length,
		duplicates: input.feedbackEventIds.length - inserted.length,
	};
}

export async function getLearningAttributionById(
	db: DbClient,
	organizationId: string,
	id: string,
): Promise<LearningFeedbackAttributionRow | null> {
	const rows = await db
		.select()
		.from(learningFeedbackAttributions)
		.where(
			and(
				eq(learningFeedbackAttributions.organizationId, organizationId),
				eq(learningFeedbackAttributions.id, id),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

export async function getLearningAttributionsForEvents(
	db: DbClient,
	input: {
		organizationId: string;
		feedbackEventIds: string[];
		subjectKind: LearningSubjectKind;
		subjectId: string;
	},
): Promise<LearningFeedbackAttributionRow[]> {
	if (input.feedbackEventIds.length === 0) return [];
	const rows: LearningFeedbackAttributionRow[] = [];
	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	for (const chunk of chunkForBoundParams(
		[...new Set(input.feedbackEventIds)],
		50,
	)) {
		rows.push(
			...(await db
				.select()
				.from(learningFeedbackAttributions)
				.where(
					and(
						eq(
							learningFeedbackAttributions.organizationId,
							input.organizationId,
						),
						inArray(learningFeedbackAttributions.feedbackEventId, chunk),
						eq(learningFeedbackAttributions.subjectKind, input.subjectKind),
						eq(learningFeedbackAttributions.subjectId, input.subjectId),
					),
				)),
		);
	}
	return rows;
}

export async function getLearningMeasurementsByIds(
	db: DbClient,
	organizationId: string,
	ids: string[],
): Promise<LearningFeedbackMeasurementRow[]> {
	if (ids.length === 0) return [];
	const rows: LearningFeedbackMeasurementRow[] = [];
	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	for (const chunk of chunkForBoundParams([...new Set(ids)], 50)) {
		rows.push(
			...(await db
				.select()
				.from(learningFeedbackMeasurements)
				.where(
					and(
						eq(learningFeedbackMeasurements.organizationId, organizationId),
						inArray(learningFeedbackMeasurements.id, chunk),
					),
				)),
		);
	}
	return rows;
}

export async function recordLearningMeasurement(
	db: DbClient,
	input: {
		organizationId: string;
		clientMeasurementId: string;
		attributionId: string;
		windowKind: LearningMeasurementWindow;
		windowStart: string;
		windowEnd: string;
		opportunityCount: number;
		recurrenceCount: number;
		successCount: number;
		metadata?: Record<string, JsonValue> | null;
	},
): Promise<{
	measurement: LearningFeedbackMeasurementRow;
	duplicate: boolean;
}> {
	const inserted = await db
		.insert(learningFeedbackMeasurements)
		.values(input)
		.onConflictDoNothing({
			target: [
				learningFeedbackMeasurements.organizationId,
				learningFeedbackMeasurements.clientMeasurementId,
			],
		})
		.returning();
	const insertedRow = inserted[0];
	if (insertedRow) {
		return {
			measurement: insertedRow,
			duplicate: false,
		};
	}

	const rows = await db
		.select()
		.from(learningFeedbackMeasurements)
		.where(
			and(
				eq(learningFeedbackMeasurements.organizationId, input.organizationId),
				eq(
					learningFeedbackMeasurements.clientMeasurementId,
					input.clientMeasurementId,
				),
			),
		)
		.limit(1);
	const existing = rows[0];
	if (!existing) {
		throw new Error("Learning measurement conflict did not resolve to a row");
	}
	if (
		existing.attributionId !== input.attributionId ||
		existing.windowKind !== input.windowKind ||
		existing.windowStart !== input.windowStart ||
		existing.windowEnd !== input.windowEnd ||
		existing.opportunityCount !== input.opportunityCount ||
		existing.recurrenceCount !== input.recurrenceCount ||
		existing.successCount !== input.successCount
	) {
		throw new LearningFeedbackIdempotencyConflictError("measurement");
	}
	return {
		measurement: existing,
		duplicate: true,
	};
}

type SummaryAttribution = LearningFeedbackAttributionRow & {
	eventKind: LearningInteractionKind;
	issueKey: string | null;
};

export function summarizeLearningFeedback(input: {
	subjectKind: LearningSubjectKind;
	subjectId: string;
	issueKey?: string;
	attributions: SummaryAttribution[];
	measurements: LearningFeedbackMeasurementRow[];
}): LearningFeedbackSummaryResult {
	const eventKinds: Record<string, number> = {};
	const eventIds = new Set<string>();
	for (const attribution of input.attributions) {
		if (!eventIds.has(attribution.feedbackEventId)) {
			eventIds.add(attribution.feedbackEventId);
			eventKinds[attribution.eventKind] =
				(eventKinds[attribution.eventKind] ?? 0) + 1;
		}
	}

	const latest = (windowKind: LearningMeasurementWindow) =>
		input.measurements
			.filter((measurement) => measurement.windowKind === windowKind)
			.sort((a, b) => b.windowEnd.localeCompare(a.windowEnd))[0] ?? null;
	const rate = (measurement: LearningFeedbackMeasurementRow | null) =>
		measurement
			? {
					measurementId: measurement.id,
					attributionId: measurement.attributionId,
					windowStart: measurement.windowStart,
					windowEnd: measurement.windowEnd,
					opportunityCount: measurement.opportunityCount,
					recurrenceCount: measurement.recurrenceCount,
					successCount: measurement.successCount,
					recurrenceRate:
						measurement.recurrenceCount / measurement.opportunityCount,
					successRate: measurement.successCount / measurement.opportunityCount,
				}
			: null;
	const baseline = rate(latest("baseline"));
	const followup = rate(latest("followup"));
	const recurrenceRateDelta =
		baseline && followup
			? followup.recurrenceRate - baseline.recurrenceRate
			: null;

	return {
		subjectKind: input.subjectKind,
		subjectId: input.subjectId,
		issueKey: input.issueKey ?? null,
		attributionCount: input.attributions.length,
		attributedEventCount: eventIds.size,
		eventKinds,
		baseline,
		followup,
		recurrenceRateDelta,
		improved: recurrenceRateDelta === null ? null : recurrenceRateDelta < 0,
	};
}

export function validateLearningMeasurementPair(input: {
	baseline: LearningFeedbackMeasurementRow;
	followup: LearningFeedbackMeasurementRow;
	allowedAttributionIds: Set<string>;
}): { valid: boolean; improved: boolean; reason: string | null } {
	if (
		input.baseline.windowKind !== "baseline" ||
		input.followup.windowKind !== "followup"
	) {
		return {
			valid: false,
			improved: false,
			reason: "Measurements must be an explicit baseline/follow-up pair",
		};
	}
	if (input.baseline.attributionId !== input.followup.attributionId) {
		return {
			valid: false,
			improved: false,
			reason: "Baseline and follow-up must belong to one attribution cohort",
		};
	}
	if (!input.allowedAttributionIds.has(input.baseline.attributionId)) {
		return {
			valid: false,
			improved: false,
			reason:
				"Measurement cohort is not attributed to this proposal's evidence",
		};
	}
	if (input.baseline.windowEnd > input.followup.windowStart) {
		return {
			valid: false,
			improved: false,
			reason:
				"Baseline and follow-up windows must be chronological and non-overlapping",
		};
	}
	return {
		valid: true,
		improved:
			input.followup.recurrenceCount / input.followup.opportunityCount <
			input.baseline.recurrenceCount / input.baseline.opportunityCount,
		reason: null,
	};
}

export async function getLearningFeedbackSummary(
	db: DbClient,
	input: {
		organizationId: string;
		tediId?: string;
		personalScopeId?: string | null;
		subjectKind: LearningSubjectKind;
		subjectId: string;
		issueKey?: string;
	},
): Promise<LearningFeedbackSummaryResult> {
	const conditions = [
		eq(learningFeedbackAttributions.organizationId, input.organizationId),
		eq(learningFeedbackAttributions.subjectKind, input.subjectKind),
		eq(learningFeedbackAttributions.subjectId, input.subjectId),
	];
	if (input.issueKey) {
		conditions.push(eq(learningInteractionEvents.issueKey, input.issueKey));
	}
	if (input.tediId) {
		conditions.push(eq(learningInteractionEvents.tediId, input.tediId));
	}
	conditions.push(
		input.personalScopeId
			? (or(
					ne(learningInteractionEvents.scopeKind, "personal"),
					and(
						eq(learningInteractionEvents.scopeKind, "personal"),
						eq(learningInteractionEvents.scopeId, input.personalScopeId),
					),
				) as (typeof conditions)[number])
			: ne(learningInteractionEvents.scopeKind, "personal"),
	);

	const joined = await db
		.select({
			attribution: learningFeedbackAttributions,
			eventKind: learningInteractionEvents.eventKind,
			issueKey: learningInteractionEvents.issueKey,
		})
		.from(learningFeedbackAttributions)
		.innerJoin(
			learningInteractionEvents,
			eq(
				learningInteractionEvents.id,
				learningFeedbackAttributions.feedbackEventId,
			),
		)
		.where(and(...conditions));

	const attributions: SummaryAttribution[] = joined.map((row) => ({
		...row.attribution,
		eventKind: row.eventKind,
		issueKey: row.issueKey,
	}));
	const attributionIds = attributions.map((attribution) => attribution.id);
	const measurementRows: LearningFeedbackMeasurementRow[] = [];
	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	for (const chunk of chunkForBoundParams(attributionIds, 50)) {
		measurementRows.push(
			...(await db
				.select()
				.from(learningFeedbackMeasurements)
				.where(
					and(
						eq(
							learningFeedbackMeasurements.organizationId,
							input.organizationId,
						),
						inArray(learningFeedbackMeasurements.attributionId, chunk),
					),
				)),
		);
	}

	return summarizeLearningFeedback({
		subjectKind: input.subjectKind,
		subjectId: input.subjectId,
		issueKey: input.issueKey,
		attributions,
		measurements: measurementRows,
	});
}

export function summarizeRecurringLearningIssues(input: {
	events: LearningInteractionEventRow[];
	minimumOccurrences: number;
	limit: number;
}): RecurringLearningIssueResult[] {
	const groups = new Map<
		string,
		{
			issueKey: string;
			tediId: string | null;
			scopeKind: LearningScopeKind;
			scopeId: string;
			events: LearningInteractionEventRow[];
		}
	>();
	for (const event of input.events) {
		if (!event.issueKey) continue;
		const key = JSON.stringify([
			event.tediId,
			event.scopeKind,
			event.scopeId,
			event.issueKey,
		]);
		const group = groups.get(key) ?? {
			issueKey: event.issueKey,
			tediId: event.tediId,
			scopeKind: event.scopeKind,
			scopeId: event.scopeId,
			events: [],
		};
		group.events.push(event);
		groups.set(key, group);
	}

	return [...groups.values()]
		.map((group): RecurringLearningIssueResult => {
			const ordered = group.events.sort((a, b) =>
				a.occurredAt.localeCompare(b.occurredAt),
			);
			const eventKinds: Record<string, number> = {};
			let negativeCount = 0;
			for (const event of ordered) {
				eventKinds[event.eventKind] = (eventKinds[event.eventKind] ?? 0) + 1;
				if (
					event.signalClass === "quality" &&
					NEGATIVE_INTERACTION_KINDS.has(event.eventKind)
				)
					negativeCount++;
			}
			return {
				issueKey: group.issueKey,
				tediId: group.tediId,
				scopeKind: group.scopeKind,
				scopeId: group.scopeId,
				occurrenceCount: ordered.length,
				negativeCount,
				acceptedCount: eventKinds.accepted ?? 0,
				uniqueActorCount: new Set(
					ordered.map((event) => `${event.actorType}:${event.actorId ?? ""}`),
				).size,
				uniqueRunCount: new Set(
					ordered.map((event) => event.runId).filter(Boolean),
				).size,
				eventKinds,
				evidenceEventIds: ordered
					.filter(
						(event) =>
							event.signalClass === "quality" &&
							NEGATIVE_INTERACTION_KINDS.has(event.eventKind),
					)
					.slice(-50)
					.map((event) => event.id),
				firstOccurredAt: ordered[0]!.occurredAt,
				lastOccurredAt: ordered.at(-1)!.occurredAt,
				eligible: negativeCount >= input.minimumOccurrences,
			};
		})
		.sort(
			(a, b) =>
				Number(b.eligible) - Number(a.eligible) ||
				b.negativeCount - a.negativeCount ||
				b.lastOccurredAt.localeCompare(a.lastOccurredAt),
		)
		.slice(0, input.limit);
}

export async function analyzeRecurringLearningIssues(
	db: DbClient,
	input: {
		organizationId: string;
		tediId?: string;
		scopeKind?: LearningScopeKind;
		scopeId?: string;
		since?: string;
		until?: string;
		minimumOccurrences: number;
		personalScopeId?: string | null;
		limit: number;
	},
): Promise<RecurringLearningIssueResult[]> {
	const events = await listLearningInteractions(db, {
		organizationId: input.organizationId,
		tediId: input.tediId,
		scopeKind: input.scopeKind,
		scopeId: input.scopeId,
		since: input.since,
		until: input.until,
		personalScopeId: input.personalScopeId,
		limit: 200,
	});
	return summarizeRecurringLearningIssues({
		events,
		minimumOccurrences: input.minimumOccurrences,
		limit: input.limit,
	});
}

export async function proposeLearningImprovement(
	db: DbClient,
	input: {
		organizationId: string;
		clientProposalId: string;
		tediId: string | null;
		scopeKind: LearningScopeKind;
		scopeId: string;
		issueKey: string;
		subjectKind: LearningSubjectKind;
		subjectId: string;
		recommendation: string;
		evidenceEventIds: string[];
		proposedByType: LearningInteractionEventRow["actorType"];
		proposedById: string | null;
	},
): Promise<{ proposal: LearningImprovementProposalRow; duplicate: boolean }> {
	const values = {
		...input,
		promotionRoute: promotionRouteForSubject(input.subjectKind),
		status: "proposed" as const,
		certificationEvidenceRefs: [],
	};
	const inserted = await db
		.insert(learningImprovementProposals)
		.values(values)
		.onConflictDoNothing({
			target: [
				learningImprovementProposals.organizationId,
				learningImprovementProposals.clientProposalId,
			],
		})
		.returning();
	if (inserted[0]) {
		return { proposal: inserted[0], duplicate: false };
	}
	const existing = await db
		.select()
		.from(learningImprovementProposals)
		.where(
			and(
				eq(learningImprovementProposals.organizationId, input.organizationId),
				eq(
					learningImprovementProposals.clientProposalId,
					input.clientProposalId,
				),
			),
		)
		.limit(1);
	const row = existing[0];
	if (!row)
		throw new Error("Learning proposal conflict did not resolve to a row");
	if (
		row.tediId !== input.tediId ||
		row.scopeKind !== input.scopeKind ||
		row.scopeId !== input.scopeId ||
		row.issueKey !== input.issueKey ||
		row.subjectKind !== input.subjectKind ||
		row.subjectId !== input.subjectId ||
		row.recommendation !== input.recommendation ||
		JSON.stringify(row.evidenceEventIds) !==
			JSON.stringify(input.evidenceEventIds)
	) {
		throw new LearningFeedbackIdempotencyConflictError("proposal");
	}
	return { proposal: row, duplicate: true };
}

export async function getLearningImprovementProposal(
	db: DbClient,
	organizationId: string,
	id: string,
): Promise<LearningImprovementProposalRow | null> {
	const rows = await db
		.select()
		.from(learningImprovementProposals)
		.where(
			and(
				eq(learningImprovementProposals.organizationId, organizationId),
				eq(learningImprovementProposals.id, id),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

export async function updateLearningImprovementProposal(
	db: DbClient,
	input: {
		organizationId: string;
		id: string;
		status: LearningImprovementStatus;
		fromStatuses: LearningImprovementStatus[];
		expectedUpdatedAt: string;
		attributionId?: string | null;
		baselineMeasurementId?: string | null;
		followupMeasurementId?: string | null;
		evaluationNote?: string | null;
		reviewReason?: string | null;
		reviewedById?: string | null;
		reviewedAt?: string | null;
	},
): Promise<LearningImprovementProposalRow | null> {
	const { organizationId, id, fromStatuses, expectedUpdatedAt, ...patch } =
		input;
	const rows = await db
		.update(learningImprovementProposals)
		.set({ ...patch, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(learningImprovementProposals.organizationId, organizationId),
				eq(learningImprovementProposals.id, id),
				// bound-params: CAS guard over the closed proposal-status enum
				inArray(learningImprovementProposals.status, fromStatuses),
				eq(learningImprovementProposals.updatedAt, expectedUpdatedAt),
			),
		)
		.returning();
	return rows[0] ?? null;
}

export async function listLearningImprovementProposals(
	db: DbClient,
	input: {
		organizationId: string;
		tediId?: string;
		issueKey?: string;
		status?: LearningImprovementStatus;
		personalScopeId?: string | null;
		limit: number;
	},
): Promise<LearningImprovementProposalRow[]> {
	const conditions = [
		eq(learningImprovementProposals.organizationId, input.organizationId),
	];
	if (input.tediId) {
		conditions.push(eq(learningImprovementProposals.tediId, input.tediId));
	}
	if (input.issueKey) {
		conditions.push(eq(learningImprovementProposals.issueKey, input.issueKey));
	}
	if (input.status) {
		conditions.push(eq(learningImprovementProposals.status, input.status));
	}
	conditions.push(
		input.personalScopeId
			? or(
					ne(learningImprovementProposals.scopeKind, "personal"),
					eq(learningImprovementProposals.scopeId, input.personalScopeId),
				)!
			: ne(learningImprovementProposals.scopeKind, "personal"),
	);
	const rows = await db
		.select()
		.from(learningImprovementProposals)
		.where(and(...conditions))
		.orderBy(desc(learningImprovementProposals.updatedAt))
		.limit(input.limit);
	return rows;
}
