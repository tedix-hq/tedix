import { sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { insertAuditEvent } from "./audit";

const ATTEMPT_ACTION = "tedi.runtime.orphan_cleanup_attempt";
const CONFIRMED_ACTION = "tedi.runtime.orphan_cleanup_confirmed";
const RESOURCE = "orphan_runtime_event";
const RETRY_MS = 10 * 60_000;

export type OrphanWorkflowCleanup = {
	terminalEventId: string;
	organizationId: string;
	tediId: string;
	runId: string;
	sealedAt: string;
};
const receiptId = (id: string) => `orphan-native-confirmed:${id}`;

function candidates(now: Date, terminalEventId?: string, limit = 20) {
	return sql`
 SELECT e.id AS terminalEventId, e.organization_id AS organizationId,
 e.tedi_id AS tediId, e.run_id AS runId, e.created_at AS sealedAt
 FROM tedi_runtime_events e
 WHERE e.kind = 'run.failed' AND e.runtime_backend = 'cloudflare-agents'
 AND e.created_at <= ${now.toISOString()}
 AND json_extract(e.runtime_metadata, '$.source') = 'scheduled.sweepOrphanRuns'
 AND json_extract(e.runtime_metadata, '$.reason') = 'runtime_dropped'
 AND e.run_id LIKE e.tedi_id || ':mcp:%'
 ${terminalEventId ? sql`AND e.id = ${terminalEventId}` : sql``}
 AND NOT EXISTS (SELECT 1 FROM audit_events done
   WHERE done.id = 'orphan-native-confirmed:' || e.id
   AND done.organization_id = e.organization_id AND done.action = ${CONFIRMED_ACTION})
 AND NOT EXISTS (SELECT 1 FROM audit_events attempted
   WHERE attempted.organization_id = e.organization_id AND attempted.resource_type = ${RESOURCE}
   AND attempted.resource_id = e.id AND attempted.action = ${ATTEMPT_ACTION}
   AND attempted.timestamp > ${Math.floor((now.getTime() - RETRY_MS) / 1000)})
 AND NOT EXISTS (SELECT 1 FROM tedi_runtime_events newer
   WHERE newer.organization_id = e.organization_id AND newer.tedi_id = e.tedi_id
   AND newer.run_id = e.run_id AND newer.created_at >= e.created_at
   AND newer.kind IN ('run.started', 'run.completed', 'run.canceled'))
 ORDER BY COALESCE((SELECT MAX(prior.timestamp) FROM audit_events prior
   WHERE prior.organization_id = e.organization_id AND prior.resource_type = ${RESOURCE}
   AND prior.resource_id = e.id AND prior.action = ${ATTEMPT_ACTION}), 0),
 e.created_at, e.id LIMIT ${Math.min(Math.max(limit, 1), 20)}`;
}

/** Fleet maintenance uses existing sweep terminal rows as its durable queue. */
export async function listPendingOrphanWorkflowCleanups(
	db: DbClient,
	now = new Date(),
) {
	return db.all<OrphanWorkflowCleanup>(candidates(now));
}

/** Claim and eligibility recheck are one D1 statement; overlapping ticks cannot double-claim. */
export async function claimOrphanWorkflowCleanup(
	db: DbClient,
	item: OrphanWorkflowCleanup,
	now = new Date(),
) {
	const id = `orphan-native-attempt:${Math.floor(now.getTime() / RETRY_MS)}:${item.terminalEventId}`;
	const rows = await db.all<{ id: string }>(sql`
 INSERT INTO audit_events (id, organization_id, actor_id, actor_type, action, resource_type, resource_id, timestamp)
 SELECT ${id}, c.organizationId, 'scheduled.orphan-cleanup', 'service', ${ATTEMPT_ACTION}, ${RESOURCE}, c.terminalEventId, ${Math.floor(now.getTime() / 1000)}
 FROM (${candidates(now, item.terminalEventId, 1)}) c
 WHERE c.organizationId = ${item.organizationId} AND c.tediId = ${item.tediId} AND c.runId = ${item.runId} AND c.sealedAt = ${item.sealedAt}
 ON CONFLICT(id) DO NOTHING RETURNING id`);
	return rows.length === 1;
}

export async function confirmOrphanWorkflowCleanup(
	db: DbClient,
	item: OrphanWorkflowCleanup,
	detail: string,
) {
	await insertAuditEvent(db, {
		id: receiptId(item.terminalEventId),
		organizationId: item.organizationId,
		actorId: "scheduled.orphan-cleanup",
		actorType: "service",
		action: CONFIRMED_ACTION,
		resourceType: RESOURCE,
		resourceId: item.terminalEventId,
		ignoreDuplicates: true,
		metadata: {
			runId: item.runId,
			tediId: item.tediId,
			sealedAt: item.sealedAt,
			detail,
		},
	});
}
