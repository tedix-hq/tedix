import { sql } from "drizzle-orm";
import type { DbClient } from "../../client";

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
	return db.all<LastRationale>(
		sql`SELECT id, action, category, confidence, outcome_status as outcomeStatus, created_at as createdAt
			FROM tedi_rationale_records
			WHERE tedi_id = ${access.tediId} AND org_id = ${access.orgId}
			ORDER BY created_at DESC LIMIT 1`,
	);
}

/**
 * Get the most recently learned fact for a tedi (or org-wide).
 */
export async function getLastFact(
	db: DbClient,
	access: FlywheelAccess,
): Promise<LastFact[]> {
	return db.all<LastFact>(
		sql`SELECT id, summary, fact_type as factType, confidence, source, created_at as createdAt
			FROM memory_facts
			WHERE organization_id = ${access.orgId}
				AND (tedi_id = ${access.tediId} OR tedi_id IS NULL)
				AND archived_at IS NULL
			ORDER BY created_at DESC LIMIT 1`,
	);
}

/**
 * Get the most recently updated skill entry for a tedi (or org-wide).
 */
export async function getLastSkill(
	db: DbClient,
	access: FlywheelAccess,
): Promise<LastSkill[]> {
	return db.all<LastSkill>(
		sql`SELECT id, title, revision, updated_at as updatedAt
			FROM skill_entries
			WHERE organization_id = ${access.orgId}
				AND (tedi_id = ${access.tediId} OR tedi_id IS NULL)
			ORDER BY updated_at DESC LIMIT 1`,
	);
}

/**
 * Get the most recently updated muscle memory entry for a tedi.
 */
export async function getLastMuscle(
	db: DbClient,
	access: FlywheelAccess,
): Promise<LastMuscle[]> {
	return db.all<LastMuscle>(
		sql`SELECT id, name, kind, origin, updated_at as updatedAt
			FROM tedi_muscle_memory
			WHERE tedi_id = ${access.tediId} AND organization_id = ${access.orgId}
			ORDER BY updated_at DESC LIMIT 1`,
	);
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
	return db.all<LastToolCall>(
		sql`SELECT json_extract(payload, '$.name') as toolName,
				CASE kind WHEN 'tool.completed' THEN 1 WHEN 'tool.failed' THEN 0 END as success,
				created_at as createdAt
			FROM tedi_runtime_events
			WHERE tedi_id = ${access.tediId}
				AND organization_id = ${access.orgId}
				AND kind IN ('tool.completed', 'tool.failed')
			ORDER BY created_at DESC LIMIT 1`,
	);
}

/**
 * Count rationale records created in the last 24h.
 */
export async function countDecisionsLast24h(
	db: DbClient,
	access: FlywheelAccess,
	since: string,
): Promise<CountRow[]> {
	return db.all<CountRow>(
		sql`SELECT count(*) as cnt FROM tedi_rationale_records
			WHERE tedi_id = ${access.tediId} AND org_id = ${access.orgId}
				AND created_at >= ${since}`,
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
	return db.all<CountRow>(
		sql`SELECT count(*) as cnt FROM memory_facts
			WHERE organization_id = ${access.orgId}
				AND (tedi_id = ${access.tediId} OR tedi_id IS NULL)
				AND archived_at IS NULL AND created_at >= ${since}`,
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
	return db.all<CountRow>(
		sql`SELECT count(*) as cnt FROM skill_usage_events
			WHERE tedi_id = ${access.tediId}
				AND organization_id = ${access.orgId}
				AND created_at >= ${since}`,
	);
}

// ============================================================================
