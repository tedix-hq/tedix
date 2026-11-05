import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	skillEntries,
	skillUsageEvents,
	tediMuscleMemory,
} from "../../schema/cognitive";
import { tediRuntimeEvents } from "../../schema/cognitive-runtime";
import { memoryFacts } from "../../schema/memory-graph";
import { tediRationaleRecords } from "../../schema/rationale-records";

export interface FlywheelAccess {
	tediId: string;
	orgId: string;
}

export interface LastRationale {
	id: string;
	action: string;
	category: string;
	confidence: number;
	outcomeStatus: string;
	createdAt: string;
}

export interface LastFact {
	id: string;
	summary: string | null;
	factType: string;
	confidence: number;
	source: string | null;
	createdAt: string | null;
}

export interface LastSkill {
	id: string;
	title: string;
	revision: number;
	updatedAt: string | null;
}

export interface LastMuscle {
	id: string;
	name: string;
	kind: string;
	origin: string;
	updatedAt: string | null;
}

export interface LastToolCall {
	toolName: string | null;
	success: number | null;
	createdAt: string;
}

export interface CountRow {
	cnt: number;
}

export interface FlywheelPulseData {
	lastRationale: LastRationale | null;
	lastFact: LastFact | null;
	lastSkill: LastSkill | null;
	lastMuscle: LastMuscle | null;
	lastToolCall: LastToolCall | null;
	decisionsLast24h: number;
	factsLast24h: number;
	skillUsagesLast24h: number;
}

export async function getFlywheelPulse(
	db: DbClient,
	access: FlywheelAccess,
): Promise<FlywheelPulseData> {
	const now24hAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	const [
		lastRationaleRow,
		lastFactRow,
		lastSkillRow,
		lastMuscleRow,
		lastToolCallRow,
		decisionsLast24hRow,
		factsLast24hRow,
		skillUsagesLast24hRow,
	] = await Promise.all([
		getLastRationale(db, access),
		getLastFact(db, access),
		getLastSkill(db, access),
		getLastMuscle(db, access),
		getLastToolCall(db, access),
		countDecisionsLast24h(db, access, now24hAgo),
		countFactsLast24h(db, access, now24hAgo),
		countSkillUsagesLast24h(db, access, now24hAgo),
	]);

	return {
		lastRationale: lastRationaleRow[0] ?? null,
		lastFact: lastFactRow[0] ?? null,
		lastSkill: lastSkillRow[0] ?? null,
		lastMuscle: lastMuscleRow[0] ?? null,
		lastToolCall: lastToolCallRow[0] ?? null,
		decisionsLast24h: decisionsLast24hRow[0]?.cnt ?? 0,
		factsLast24h: factsLast24hRow[0]?.cnt ?? 0,
		skillUsagesLast24h: skillUsagesLast24hRow[0]?.cnt ?? 0,
	};
}

/**
 * Get the most recent rationale record for a tedi.
 */
export async function getLastRationale(
	db: DbClient,
	access: FlywheelAccess,
): Promise<LastRationale[]> {
	return db
		.select({
			id: tediRationaleRecords.id,
			action: tediRationaleRecords.action,
			category: tediRationaleRecords.category,
			confidence: tediRationaleRecords.confidence,
			outcomeStatus: tediRationaleRecords.outcomeStatus,
			createdAt: tediRationaleRecords.createdAt,
		})
		.from(tediRationaleRecords)
		.where(
			and(
				eq(tediRationaleRecords.tediId, access.tediId),
				eq(tediRationaleRecords.orgId, access.orgId),
			),
		)
		.orderBy(desc(tediRationaleRecords.createdAt))
		.limit(1);
}

/**
 * Get the most recently learned fact for a tedi (or org-wide).
 */
export async function getLastFact(
	db: DbClient,
	access: FlywheelAccess,
): Promise<LastFact[]> {
	return db
		.select({
			id: memoryFacts.id,
			summary: memoryFacts.summary,
			factType: memoryFacts.factType,
			confidence: memoryFacts.confidence,
			source: memoryFacts.source,
			createdAt: memoryFacts.createdAt,
		})
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, access.orgId),
				or(eq(memoryFacts.tediId, access.tediId), isNull(memoryFacts.tediId)),
				isNull(memoryFacts.archivedAt),
			),
		)
		.orderBy(desc(memoryFacts.createdAt))
		.limit(1);
}

/**
 * Get the most recently updated skill entry for a tedi (or org-wide).
 */
export async function getLastSkill(
	db: DbClient,
	access: FlywheelAccess,
): Promise<LastSkill[]> {
	return db
		.select({
			id: skillEntries.id,
			title: skillEntries.title,
			revision: skillEntries.revision,
			updatedAt: skillEntries.updatedAt,
		})
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.organizationId, access.orgId),
				or(eq(skillEntries.tediId, access.tediId), isNull(skillEntries.tediId)),
			),
		)
		.orderBy(desc(skillEntries.updatedAt))
		.limit(1);
}

/**
 * Get the most recently updated muscle memory entry for a tedi.
 */
export async function getLastMuscle(
	db: DbClient,
	access: FlywheelAccess,
): Promise<LastMuscle[]> {
	return db
		.select({
			id: tediMuscleMemory.id,
			name: tediMuscleMemory.name,
			kind: tediMuscleMemory.kind,
			origin: tediMuscleMemory.origin,
			updatedAt: tediMuscleMemory.updatedAt,
		})
		.from(tediMuscleMemory)
		.where(
			and(
				eq(tediMuscleMemory.tediId, access.tediId),
				eq(tediMuscleMemory.organizationId, access.orgId),
			),
		)
		.orderBy(desc(tediMuscleMemory.updatedAt))
		.limit(1);
}

/**
 * Get the most recent MCP tool call for a tedi from the canonical D1 runtime
 * ledger (`tedi_runtime_events`), replacing the dead `mcp_telemetry_events`
 * plane. `payload` is stored as json text, so `json_extract` reads `name`;
 * `success` maps completed→1 / failed→0 to preserve the integer contract
 * downstream reads (`success === 1`). Uses idx_tedi_runtime_events_kind_created.
 */
export async function getLastToolCall(
	db: DbClient,
	access: FlywheelAccess,
): Promise<LastToolCall[]> {
	return db
		.select({
			toolName: sql<
				string | null
			>`json_extract(${tediRuntimeEvents.payload}, '$.name')`.as("toolName"),
			success: sql<
				number | null
			>`CASE ${tediRuntimeEvents.kind} WHEN 'tool.completed' THEN 1 WHEN 'tool.failed' THEN 0 END`.as(
				"success",
			),
			createdAt: tediRuntimeEvents.createdAt,
		})
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.tediId, access.tediId),
				eq(tediRuntimeEvents.organizationId, access.orgId),
				inArray(tediRuntimeEvents.kind, ["tool.completed", "tool.failed"]),
			),
		)
		.orderBy(desc(tediRuntimeEvents.createdAt))
		.limit(1);
}

/**
 * Count rationale records created in the last 24h.
 */
export async function countDecisionsLast24h(
	db: DbClient,
	access: FlywheelAccess,
	since: string,
): Promise<CountRow[]> {
	return db
		.select({ cnt: sql<number>`count(*)`.as("cnt") })
		.from(tediRationaleRecords)
		.where(
			and(
				eq(tediRationaleRecords.tediId, access.tediId),
				eq(tediRationaleRecords.orgId, access.orgId),
				gte(tediRationaleRecords.createdAt, since),
			),
		);
}

/**
 * Count non-archived facts created in the last 24h.
 */
export async function countFactsLast24h(
	db: DbClient,
	access: FlywheelAccess,
	since: string,
): Promise<CountRow[]> {
	return db
		.select({ cnt: sql<number>`count(*)`.as("cnt") })
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, access.orgId),
				or(eq(memoryFacts.tediId, access.tediId), isNull(memoryFacts.tediId)),
				isNull(memoryFacts.archivedAt),
				gte(memoryFacts.createdAt, since),
			),
		);
}

/**
 * Count skill executions in the last 24h from the canonical usage ledger
 * (`skill_usage_events` — stamped by every workflow run, muscle invocation,
 * and direct usage report). Counts both success and failure outcomes: the
 * metric is "the skill loop is exercised", not "the skill loop succeeds".
 */
export async function countSkillUsagesLast24h(
	db: DbClient,
	access: FlywheelAccess,
	since: string,
): Promise<CountRow[]> {
	return db
		.select({ cnt: sql<number>`count(*)`.as("cnt") })
		.from(skillUsageEvents)
		.where(
			and(
				eq(skillUsageEvents.tediId, access.tediId),
				eq(skillUsageEvents.organizationId, access.orgId),
				gte(skillUsageEvents.createdAt, since),
			),
		);
}

// ============================================================================
