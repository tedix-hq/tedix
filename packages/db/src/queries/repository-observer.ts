import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../query-client";
import type { RepositoryObserverConfig } from "@tedix/api-contract/schemas/repository-observer";
import { projects } from "../schema/projects";
import {
	workItems,
	workItemComments,
	workAttempts,
} from "../schema/work-items";

/** Observation state lives on canonical Work, with one deterministic item per commit/incident. */
export async function createRepositoryObservation(
	db: DbQueryClient,
	input: {
		id: string;
		orgId: string;
		projectId: string;
		objectiveId: string | null;
		ownerTediId: string;
		title: string;
		summary: string;
		deadline: string | null;
		metadata: Record<string, JsonValue>;
		now: string;
	},
) {
	await db
		.insert(workItems)
		.values({
			id: input.id,
			orgId: input.orgId,
			projectId: input.projectId,
			objectiveId: input.objectiveId,
			title: input.title,
			description: input.summary,
			sourceIntentId: `repository-observer:${input.id}`,
			workKind: "stewardship",
			workClass: "objective",
			riskLevel: "medium",
			admissionSpecRevision: sql`lower(hex(randomblob(16)))`,
			disposition: "proposed",
			priority: input.deadline ? "high" : "low",
			accountableOwnerType: "tedi",
			accountableOwnerId: input.ownerTediId,
			stewardType: "tedi",
			stewardId: input.ownerTediId,
			deadline: input.deadline,
			metadata: input.metadata,
			createdAt: input.now,
		})
		.onConflictDoNothing();
	return getRepositoryObservation(db, input.orgId, input.id);
}
export async function getRepositoryObservation(
	db: DbQueryClient,
	orgId: string,
	id: string,
) {
	return (
		(
			await db
				.select()
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, orgId),
						eq(workItems.id, id),
						sql`json_extract(${workItems.metadata}, '$.repositoryObserver') = 1`,
					),
				)
				.limit(1)
		)[0] ?? null
	);
}
export async function pendingRepositoryObservations(
	db: DbQueryClient,
	orgId: string,
	projectId: string,
) {
	return db
		.select()
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, orgId),
				eq(workItems.projectId, projectId),
				sql`json_extract(${workItems.metadata}, '$.repositoryObserver') = 1`,
				sql`json_extract(${workItems.metadata}, '$.report') IS NULL`,
				sql`${workItems.disposition} IN ('proposed','accepted')`,
			),
		)
		.orderBy(workItems.createdAt)
		.limit(100);
}
/** Comment and diagnosis commit together; first report wins even on concurrent delivery. */
export async function reportRepositoryObservation(
	db: DbQueryClient,
	input: {
		orgId: string;
		id: string;
		workItemId: string;
		authorId: string;
		body: string;
		report: JsonValue;
		now: string;
	},
) {
	const predicate = and(
		eq(workItems.orgId, input.orgId),
		eq(workItems.id, input.id),
		sql`json_extract(${workItems.metadata}, '$.report') IS NULL`,
	);
	return db.batch([
		db
			.insert(workItemComments)
			.values({
				id: input.id,
				orgId: input.orgId,
				workItemId: input.workItemId,
				authorType: "tedi",
				authorId: input.authorId,
				body: input.body,
				metadata: { repositoryObservationId: input.id, report: input.report },
				createdAt: input.now,
			})
			.onConflictDoNothing(),
		db
			.update(workItems)
			.set({
				metadata: sql`json_set(${workItems.metadata}, '$.report', json((SELECT json_extract(c.metadata, '$.report') FROM work_item_comments c WHERE c.org_id = ${input.orgId} AND c.id = ${input.id})), '$.diagnosedAt', ${input.now})`,
				updatedAt: input.now,
			})
			.where(predicate),
		db
			.update(workItems)
			.set({
				metadata: sql`json_set(${workItems.metadata}, '$.latestReport', json(${JSON.stringify(input.report)}), '$.lastDiagnosedAt', ${input.now})`,
				updatedAt: input.now,
			})
			.where(and(eq(workItems.orgId, input.orgId), eq(workItems.id, input.id))),
		db
			.update(workItems)
			.set(
				settlementValues(
					input.now,
					"no action needed: observer reported clear",
				),
			)
			.where(
				and(
					eq(workItems.orgId, input.orgId),
					eq(workItems.id, input.id),
					settleableObservation(input.now),
					sql`(json_extract(${workItems.metadata}, '$.latestReport.stillRed') = 0 OR (json_extract(${workItems.metadata}, '$.event.kind') = 'push' AND json_extract(${workItems.metadata}, '$.latestReport.stillRed') IS NULL))`,
				),
			),
	]);
}
/** One repair recipe may win per incident, including overlapping requests for different lessons. */
export async function claimRepositoryRepair(
	db: DbQueryClient,
	orgId: string,
	id: string,
	lessonId: string,
	recipeKey = lessonId,
	kind = "source_patch",
) {
	const rows = await db
		.update(workItems)
		.set({
			metadata: sql`json_set(${workItems.metadata}, '$.repairLessonId', ${lessonId}, '$.repairKey', ${recipeKey}, '$.repairKind', ${kind})`,
		})
		.where(
			and(
				eq(workItems.orgId, orgId),
				eq(workItems.id, id),
				sql`json_extract(${workItems.metadata}, '$.repairLessonId') IS NULL`,
				sql`json_extract(${workItems.metadata}, '$.repositoryObserver') = 1`,
			),
		)
		.returning({ id: workItems.id });
	if (rows.length) return true;
	const existing = await getRepositoryObservation(db, orgId, id);
	return existing?.metadata?.repairKey === recipeKey;
}

/** Claim a small retryable page before doing any external orchestration. */
export async function overdueRepositoryObservations(
	db: DbQueryClient,
	now: string,
) {
	const candidates = db
		.select({ id: workItems.id })
		.from(workItems)
		.where(
			and(
				sql`json_extract(${workItems.metadata}, '$.repositoryObserver') = 1`,
				sql`json_extract(${workItems.metadata}, '$.event.kind') = 'ship_red'`,
				sql`${workItems.disposition} NOT IN ('completed','cancelled')`,
				sql`${workItems.deadline} <= ${now}`,
				sql`coalesce(json_extract(${workItems.metadata}, '$.latestReport.stillRed'), json_extract(${workItems.metadata}, '$.report.stillRed'), 1) = 1`,
				sql`json_extract(${workItems.metadata}, '$.observerEscalatedAt') IS NULL`,
				sql`coalesce(json_extract(${workItems.metadata}, '$.observerRetryAt'), '') <= ${now}`,
				// Skip deliveries made before durable maintenance progress existed.
				sql`NOT EXISTS (SELECT 1 FROM work_interactions i WHERE i.org_id = ${workItems.orgId} AND i.work_item_id = ${workItems.id} AND i.kind = 'coordination' AND json_extract(i.metadata, '$.reason') = 'Red Ship needs a decision after diagnosis or the single repair attempt')`,
			),
		)
		.orderBy(
			sql`coalesce(json_extract(${workItems.metadata}, '$.observerRetryAt'), '')`,
			workItems.deadline,
			workItems.id,
		)
		.limit(5);
	const retryAt = new Date(Date.parse(now) + 5 * 60_000).toISOString();
	return db
		.update(workItems)
		.set({
			metadata: sql`json_set(${workItems.metadata}, '$.observerRetryAt', ${retryAt}, '$.observerMaintenanceReason', 'in_progress')`,
		})
		.where(sql`${workItems.id} IN (${candidates})`)
		.returning();
}

export async function finishRepositoryObserverEscalation(
	db: DbQueryClient,
	row: { orgId: string; id: string },
	now: string,
	reason: string,
) {
	return db
		.update(workItems)
		.set({
			metadata:
				reason === "delivered"
					? sql`json_set(${workItems.metadata}, '$.observerEscalatedAt', ${now}, '$.observerMaintenanceReason', ${reason})`
					: sql`json_set(${workItems.metadata}, '$.observerMaintenanceReason', ${reason})`,
		})
		.where(and(eq(workItems.orgId, row.orgId), eq(workItems.id, row.id)));
}

/** At-most-once delivery to the independently authenticated ops workflow. A lost response escalates. */
export async function claimRepositoryRetryDelivery(
	db: DbQueryClient,
	orgId: string,
	id: string,
) {
	const rows = await db
		.update(workItems)
		.set({
			metadata: sql`json_set(${workItems.metadata}, '$.repairDeliveredAt', ${new Date().toISOString()})`,
		})
		.where(
			and(
				eq(workItems.orgId, orgId),
				eq(workItems.id, id),
				sql`json_extract(${workItems.metadata}, '$.repairKind') = 'retry'`,
				sql`json_extract(${workItems.metadata}, '$.repairDeliveredAt') IS NULL`,
				sql`coalesce(json_extract(${workItems.metadata}, '$.latestReport.stillRed'), json_extract(${workItems.metadata}, '$.report.stillRed')) = 1`,
			),
		)
		.returning({
			evidenceUrl:
				sql<string>`json_extract(${workItems.metadata}, '$.event.evidenceUrl')`.as(
					"evidence_url",
				),
		});
	return rows[0]?.evidenceUrl ?? null;
}

/** Dedicated human-authorized route; generic project metadata edits preserve this key atomically. */
export async function configureRepositoryObserver(
	db: DbQueryClient,
	orgId: string,
	projectId: string,
	config: RepositoryObserverConfig,
	now: string,
) {
	const rows = await db
		.update(projects)
		.set({
			metadata: sql`json_set(coalesce(${projects.metadata}, '{}'), '$.repositoryObserver', json(${JSON.stringify(config)}))`,
			updatedAt: now,
		})
		.where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
		.returning({ id: projects.id });
	return rows.length === 1;
}

const PUSH_OBSERVATION_RETENTION_HOURS = 24;

function settleableObservation(now: string) {
	return and(
		sql`json_extract(${workItems.metadata}, '$.repositoryObserver') = 1`,
		sql`${workItems.disposition} IN ('proposed','accepted')`,
		sql`NOT EXISTS (SELECT 1 FROM ${workAttempts} active_attempt WHERE active_attempt.org_id = ${workItems.orgId} AND active_attempt.work_item_id = ${workItems.id} AND active_attempt.runtime_state IN ('queued','running','waiting','retrying') AND (active_attempt.expires_at IS NULL OR active_attempt.expires_at > ${now}))`,
	);
}
function settlementValues(now: string, reason: string) {
	return {
		disposition: "cancelled" as const,
		cancelledAt: now,
		updatedAt: now,
		version: sql`${workItems.version} + 1`,
		metadata: sql`json_set(${workItems.metadata}, '$.settleReason', ${reason}, '$.settledAt', ${now})`,
	};
}
export async function settleRecoveredRepositoryObservation(
	db: DbQueryClient,
	orgId: string,
	id: string,
	now: string,
) {
	return db
		.update(workItems)
		.set(settlementValues(now, "no action needed: ship_green recovery"))
		.where(
			and(
				eq(workItems.orgId, orgId),
				eq(workItems.id, id),
				settleableObservation(now),
			),
		)
		.returning({ id: workItems.id });
}

export async function settleRecoveredRepositoryCiObservations(
	db: DbQueryClient,
	p: {
		orgId: string;
		projectId: string;
		repository: string;
		branch: string;
		surface: string;
		occurredAt?: string;
		now: string;
	},
) {
	const scope = and(
		eq(workItems.orgId, p.orgId),
		eq(workItems.projectId, p.projectId),
		sql`json_extract(${workItems.metadata}, '$.repositoryObserver')=1`,
		sql`json_extract(${workItems.metadata}, '$.event.kind')='ci_red'`,
		sql`json_extract(${workItems.metadata}, '$.event.repository')=${p.repository}`,
		sql`json_extract(${workItems.metadata}, '$.event.branch')=${p.branch}`,
		sql`json_extract(${workItems.metadata}, '$.event.surface')=${p.surface}`,
		sql`julianday(coalesce(json_extract(${workItems.metadata}, '$.event.occurredAt'), ${workItems.createdAt})) <= julianday(${p.occurredAt ?? p.now})`,
	);
	return db.batch([
		// Active attempts keep their lifecycle, but their late reports cannot reopen alerts.
		db
			.update(workItems)
			.set({
				metadata: sql`json_set(${workItems.metadata}, '$.ciRecoveredAt', ${p.now})`,
			})
			.where(scope),
		db
			.update(workItems)
			.set(settlementValues(p.now, "no action needed: ci_green recovery"))
			.where(and(scope, settleableObservation(p.now)))
			.returning({ id: workItems.id }),
	]);
}

/** The subquery bounds the mutation without binding a page of IDs or racing a prior read. */
export async function settleAgedRepositoryPushObservations(
	db: DbQueryClient,
	now: string,
) {
	const cutoff = new Date(
		Date.parse(now) - PUSH_OBSERVATION_RETENTION_HOURS * 60 * 60_000,
	).toISOString();
	const candidates = db
		.select({ id: workItems.id })
		.from(workItems)
		.where(
			and(
				settleableObservation(now),
				sql`json_extract(${workItems.metadata}, '$.event.kind') = 'push'`,
				sql`julianday(${workItems.createdAt}) < julianday(${cutoff})`,
				sql`coalesce(json_extract(${workItems.metadata}, '$.latestReport.stillRed'), json_extract(${workItems.metadata}, '$.report.stillRed'), 0) = 0`,
				sql`NOT EXISTS (SELECT 1 FROM work_items red WHERE red.org_id = ${workItems.orgId} AND red.project_id = ${workItems.projectId} AND json_extract(red.metadata, '$.repositoryObserver') = 1 AND json_extract(red.metadata, '$.event.kind') IN ('ship_red','ci_red') AND json_extract(red.metadata, '$.event.repository') = json_extract(${workItems.metadata}, '$.event.repository') AND json_extract(red.metadata, '$.event.branch') = json_extract(${workItems.metadata}, '$.event.branch') AND json_extract(red.metadata, '$.event.sha') = json_extract(${workItems.metadata}, '$.event.sha'))`,
			),
		)
		.orderBy(workItems.createdAt, workItems.id)
		.limit(100);
	return db
		.update(workItems)
		.set(
			settlementValues(
				now,
				`no action needed: push observation older than ${PUSH_OBSERVATION_RETENTION_HOURS} hours with no red follow-up`,
			),
		)
		.where(sql`${workItems.id} IN (${candidates})`)
		.returning({ id: workItems.id });
}

export interface RepositoryPushRecord {
	id: string;
	createdAt: string;
	sha: string;
	beforeSha: string | null;
	commitShas: string[];
	evidenceUrl: string | null;
}

/**
 * Recorded pushes to the observed branch whose head or carried commits include
 * any of `shas`, oldest first. Main is fast-forward only, so a later push
 * contains every earlier one.
 */
export async function findRepositoryPushObservations(
	db: DbQueryClient,
	p: { orgId: string; projectId: string; shas: string[]; since: string },
): Promise<RepositoryPushRecord[]> {
	const shas = [...new Set(p.shas)].slice(0, 30);
	if (!shas.length) return [];
	const list = sql.join(
		shas.map((sha) => sql`${sha}`),
		sql`, `,
	);
	const rows = await db
		.select({
			id: workItems.id,
			createdAt: workItems.createdAt,
			metadata: workItems.metadata,
		})
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, p.orgId),
				eq(workItems.projectId, p.projectId),
				gte(workItems.createdAt, p.since),
				sql`json_extract(${workItems.metadata}, '$.repositoryObserver') = 1`,
				sql`json_extract(${workItems.metadata}, '$.event.kind') = 'push'`,
				sql`(json_extract(${workItems.metadata}, '$.event.sha') IN (${list}) OR EXISTS (SELECT 1 FROM json_each(${workItems.metadata}, '$.event.commitShas') c WHERE c.value IN (${list})))`,
			),
		)
		.orderBy(asc(workItems.createdAt), asc(workItems.id))
		.limit(100);
	return rows.flatMap((row) => {
		const event = row.metadata?.event as
			| {
					sha?: unknown;
					beforeSha?: unknown;
					commitShas?: unknown;
					evidenceUrl?: unknown;
			  }
			| undefined;
		if (typeof event?.sha !== "string") return [];
		return [
			{
				id: row.id,
				createdAt: row.createdAt,
				sha: event.sha,
				beforeSha: typeof event.beforeSha === "string" ? event.beforeSha : null,
				commitShas: Array.isArray(event.commitShas)
					? event.commitShas.filter((s): s is string => typeof s === "string")
					: [],
				evidenceUrl:
					typeof event.evidenceUrl === "string" ? event.evidenceUrl : null,
			},
		];
	});
}
