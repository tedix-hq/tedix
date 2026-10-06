/**
 * Execution drilldown — D1 audit_events lane.
 *
 * The canonical "drill into one Code Mode execution" source is D1 `audit_events`,
 * NOT Analytics Engine. AE is sampled, so its inner `tool_call` rows for a single
 * execution can be silently dropped (observed: drilldown returned the parent
 * `code_exec` but an empty inner array while D1 + R2 both had the inner calls).
 * audit_events is unsampled, has every inner row, AND carries the ACTOR identity
 * (actorId/actorType) — which AE lacks entirely. This module maps audit rows into
 * the drilldown shape; the AE path remains a fallback for executions older than
 * the audit trail.
 *
 * @module execution-drilldown
 */

import type {
	ExecutionDrilldown,
	ExecutionEvent,
} from "@tedix/api-contract/schemas/analytics";

/** Raw audit_events row shape projected by the drilldown SQL. */
export interface AuditDrilldownRow {
	action: string;
	actorId: string | null;
	actorType: string | null;
	resourceId: string | null;
	timestamp: Date | number | string;
	durationMs: number | string | null;
	errorCode: string | null;
	traceId: string | null;
	clientId: string | null;
	subjectUserId?: string | null;
	agentTediId?: string | null;
	oauthClientId?: string | null;
	delegationMode?: string | null;
}

/** Audit timestamps are stored as unix SECONDS (Drizzle `timestamp` mode). */
function auditTimestampToIso(value: Date | number | string): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "number") return new Date(value * 1000).toISOString();
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return new Date(numeric * 1000).toISOString();
	return new Date(value).toISOString();
}

function numberOrZero(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) ? Math.round(n) : 0;
}

function mapRow(row: AuditDrilldownRow): ExecutionEvent {
	const isCode = row.action.startsWith("mcp.code");
	return {
		// Code rows have no tool resourceId; label them "code" for the parent.
		toolName: row.resourceId ?? (isCode ? "code" : ""),
		// Action verb encodes outcome: `.execute` = success, `.error` = failure.
		success: row.action.endsWith(".execute"),
		durationMs: numberOrZero(row.durationMs),
		timestamp: auditTimestampToIso(row.timestamp),
		eventType: isCode ? "code_exec" : "tool_call",
		// appSlug isn't in audit metadata (only appId); the OS drill-down keys on
		// toolName/success here, so an empty slug is acceptable.
		appSlug: "",
		errorCode: row.errorCode ?? null,
	};
}

/**
 * Build a drilldown result from audit_events rows (ordered oldest→newest).
 *
 * Splits the parent `mcp.code.*` row from inner `mcp.tool.*` rows, and lifts the
 * actor / traceId / clientId from whichever row carries them (the parent first,
 * else the first inner row). Returns `source: "audit"`. When `rows` is empty the
 * caller should fall back to the AE lane.
 */
export function buildDrilldownFromAuditRows(
	rows: AuditDrilldownRow[],
): ExecutionDrilldown {
	let execution: ExecutionEvent | null = null;
	const toolCalls: ExecutionEvent[] = [];

	// Prefer the parent code row for actor/trace context, else the first row.
	const contextRow =
		rows.find((r) => r.action.startsWith("mcp.code")) ?? rows[0];

	for (const row of rows) {
		const mapped = mapRow(row);
		if (row.action.startsWith("mcp.code")) {
			execution = mapped;
		} else {
			toolCalls.push(mapped);
		}
	}

	const actor =
		contextRow?.actorId && contextRow.actorType
			? { actorId: contextRow.actorId, actorType: contextRow.actorType }
			: null;

	return {
		execution,
		toolCalls,
		actor,
		traceId: contextRow?.traceId ?? null,
		clientId: contextRow?.clientId ?? null,
		source: "audit",
	};
}
