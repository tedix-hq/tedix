import { and, eq, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
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

function candidates(
	db: DbClient,
	now: Date,
	terminalEventId?: string,
	limit = 20,
) {
	const e = alias(tediRuntimeEvents, "e");
	const done = alias(auditEvents, "done");
	const attempted = alias(auditEvents, "attempted");
	const newer = alias(tediRuntimeEvents, "newer");
	const prior = alias(auditEvents, "prior");
	const one = { one: sql`1` };
	const lastAttempt = db
		.select({ lastAttempt: sql`MAX(${prior.timestamp})` })
		.from(prior)
		.where(
			and(
				eq(prior.organizationId, e.organizationId),
				eq(prior.resourceType, RESOURCE),
				eq(prior.resourceId, e.id),
				eq(prior.action, ATTEMPT_ACTION),
			),
		);
	return db
		.select({
			terminalEventId: sql<string>`${e.id}`.as("terminalEventId"),
			organizationId: sql<string>`${e.organizationId}`.as("organizationId"),
			tediId: sql<string>`${e.tediId}`.as("tediId"),
			runId: sql<string>`${e.runId}`.as("runId"),
			sealedAt: sql<string>`${e.createdAt}`.as("sealedAt"),
		})
		.from(e)
		.where(
			and(
				sql`${e.kind} = 'run.failed'`,
				sql`${e.runtimeBackend} = 'cloudflare-agents'`,
				sql`${e.createdAt} <= ${now.toISOString()}`,
				sql`json_extract(${e.runtimeMetadata}, '$.source') = 'scheduled.sweepOrphanRuns'`,
				sql`json_extract(${e.runtimeMetadata}, '$.reason') = 'runtime_dropped'`,
				sql`${e.runId} LIKE ${e.tediId} || ':mcp:%'`,
				terminalEventId ? eq(e.id, terminalEventId) : undefined,
				notExists(
					db
						.select(one)
						.from(done)
						.where(
							and(
								sql`${done.id} = 'orphan-native-confirmed:' || ${e.id}`,
								eq(done.organizationId, e.organizationId),
								eq(done.action, CONFIRMED_ACTION),
							),
						),
				),
				notExists(
					db
						.select(one)
						.from(attempted)
						.where(
							and(
								eq(attempted.organizationId, e.organizationId),
								eq(attempted.resourceType, RESOURCE),
								eq(attempted.resourceId, e.id),
								eq(attempted.action, ATTEMPT_ACTION),
								sql`${attempted.timestamp} > ${Math.floor((now.getTime() - RETRY_MS) / 1000)}`,
							),
						),
				),
				notExists(
					db
						.select(one)
						.from(newer)
						.where(
							and(
								eq(newer.organizationId, e.organizationId),
								eq(newer.tediId, e.tediId),
								eq(newer.runId, e.runId),
								sql`${newer.createdAt} >= ${e.createdAt}`,
								sql`${newer.kind} IN ('run.started', 'run.completed', 'run.canceled')`,
							),
						),
				),
			),
		)
		.orderBy(sql`COALESCE(${lastAttempt}, 0)`, e.createdAt, e.id)
		.limit(Math.min(Math.max(limit, 1), 20));
}

/** Fleet maintenance uses existing sweep terminal rows as its durable queue. */
export async function listPendingOrphanWorkflowCleanups(
	db: DbClient,
	now = new Date(),
) {
	return candidates(db, now);
}

/** Claim and eligibility recheck are one D1 statement; overlapping ticks cannot double-claim. */
export async function claimOrphanWorkflowCleanup(
	db: DbClient,
	item: OrphanWorkflowCleanup,
	now = new Date(),
) {
	const id = `orphan-native-attempt:${Math.floor(now.getTime() / RETRY_MS)}:${item.terminalEventId}`;
	const c = candidates(db, now, item.terminalEventId, 1).as("c");
	const rows = await db
		.insert(auditEvents)
		.select(
			db
				.select({
					id: sql<string>`${id}`.as("id"),
					organizationId: c.organizationId,
					actorId: sql<string>`'scheduled.orphan-cleanup'`.as("actor_id"),
					actorType: sql<"service">`'service'`.as("actor_type"),
					action: sql<string>`${ATTEMPT_ACTION}`.as("action"),
					resourceType: sql<string>`${RESOURCE}`.as("resource_type"),
					resourceId: c.terminalEventId,
					// Epoch seconds, bound raw like the column's stored form.
					timestamp: sql<Date>`${Math.floor(now.getTime() / 1000)}`.as(
						"timestamp",
					),
				})
				.from(c)
				.where(
					and(
						eq(c.organizationId, item.organizationId),
						eq(c.tediId, item.tediId),
						eq(c.runId, item.runId),
						eq(c.sealedAt, item.sealedAt),
					),
				),
		)
		.onConflictDoNothing({ target: auditEvents.id })
		.returning({ id: auditEvents.id });
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
