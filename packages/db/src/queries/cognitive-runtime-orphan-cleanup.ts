import { and, eq, exists, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { coreStore, jsonRead, unixTime } from "../core-store/dialect";
import { auditEvents as schemaAuditEvents } from "../schema/audit-events";
import { tediRuntimeEvents as schemaTediRuntimeEvents } from "../schema/cognitive-runtime";
import { buildInsertAuditEventStatement } from "./audit";
import { auditWriteTable } from "./audit-delivery";

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
	const tediRuntimeEvents = coreTable(db, schemaTediRuntimeEvents);
	const auditEvents = coreTable(db, schemaAuditEvents);
	const e = alias(tediRuntimeEvents, "e");
	const done = alias(auditEvents, "done");
	const attempted = alias(auditEvents, "attempted");
	const newer = alias(tediRuntimeEvents, "newer");
	const prior = alias(auditEvents, "prior");
	const one = { one: sql`1` };
	const lastAttempt = db
		.select({
			lastAttempt: sql`MAX(${coreStore(db) === "postgres" ? unixTime(db, prior.timestamp) : prior.timestamp})`,
		})
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
				sql`${jsonRead(db, e.runtimeMetadata, ["source"])} = 'scheduled.sweepOrphanRuns'`,
				sql`${jsonRead(db, e.runtimeMetadata, ["reason"])} = 'runtime_dropped'`,
				sql`${e.runId} LIKE ${e.tediId} || ':mcp:%'`,
				terminalEventId ? eq(e.id, terminalEventId) : undefined,
				sql`coalesce(${jsonRead(db, e.runtimeMetadata, ["orphanCleanupConfirmed"], "boolean")}, false) = false`,
				sql`coalesce(${jsonRead(db, e.runtimeMetadata, ["orphanCleanupAttemptedAt"], "number")}, 0) <= ${Math.floor((now.getTime() - RETRY_MS) / 1000)}`,
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
								sql`${coreStore(db) === "postgres" ? unixTime(db, attempted.timestamp) : attempted.timestamp} > ${Math.floor((now.getTime() - RETRY_MS) / 1000)}`,
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
		.orderBy(
			sql`COALESCE(${jsonRead(db, e.runtimeMetadata, ["orphanCleanupAttemptedAt"], "number")}, ${lastAttempt}, 0)`,
			e.createdAt,
			e.id,
		)
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
	const auditEvents = auditWriteTable(db);
	const tediRuntimeEvents = coreTable(db, schemaTediRuntimeEvents);
	const id = `orphan-native-attempt:${Math.floor(now.getTime() / RETRY_MS)}:${item.terminalEventId}`;
	const c = candidates(db, now, item.terminalEventId, 1).as("c");
	const claim = db
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
					// Bind each store's physical timestamp representation.
					timestamp: (coreStore(db) === "postgres"
						? sql<Date>`to_timestamp(${Math.floor(now.getTime() / 1000)})`
						: sql<Date>`${Math.floor(now.getTime() / 1000)}`
					).as("timestamp"),
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
	const attemptedAt = Math.floor(now.getTime() / 1000);
	const [rows] = await db.batch([
		claim,
		db
			.update(tediRuntimeEvents)
			.set({
				runtimeMetadata:
					coreStore(db) === "postgres"
						? sql`coalesce(${tediRuntimeEvents.runtimeMetadata}, '{}'::jsonb) || jsonb_build_object('orphanCleanupAttemptedAt', ${attemptedAt}::bigint)`
						: sql`json_set(coalesce(${tediRuntimeEvents.runtimeMetadata}, '{}'), '$.orphanCleanupAttemptedAt', ${attemptedAt})`,
			})
			.where(
				and(
					eq(tediRuntimeEvents.organizationId, item.organizationId),
					eq(tediRuntimeEvents.id, item.terminalEventId),
					exists(
						db
							.select({ one: sql`1` })
							.from(auditEvents)
							.where(eq(auditEvents.id, id)),
					),
				),
			),
	]);
	return rows.length === 1;
}

export async function confirmOrphanWorkflowCleanup(
	db: DbClient,
	item: OrphanWorkflowCleanup,
	detail: string,
) {
	const tediRuntimeEvents = coreTable(db, schemaTediRuntimeEvents);
	await db.batch([
		db
			.update(tediRuntimeEvents)
			.set({
				runtimeMetadata:
					coreStore(db) === "postgres"
						? sql`coalesce(${tediRuntimeEvents.runtimeMetadata}, '{}'::jsonb) || '{"orphanCleanupConfirmed":true}'::jsonb`
						: sql`json_set(coalesce(${tediRuntimeEvents.runtimeMetadata}, '{}'), '$.orphanCleanupConfirmed', json('true'))`,
			})
			.where(
				and(
					eq(tediRuntimeEvents.organizationId, item.organizationId),
					eq(tediRuntimeEvents.id, item.terminalEventId),
				),
			),
		buildInsertAuditEventStatement(db, {
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
		}).statement,
	]);
}
