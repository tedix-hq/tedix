import { and, asc, eq, gte, sql, type SQL } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { createCommitResolver } from "./git-commit-aliases";
import type { DbQueryClient } from "../query-client";
import type { RepositoryObserverConfig } from "@tedix/api-contract/schemas/repository-observer";
import { projects } from "../schema/projects";
import {
	openRepositoryObservation,
	workAttempts,
	workItemComments,
	workItems,
	workItemStoredColumns,
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
	const push =
		input.metadata.repositoryObserver === 1 &&
		(input.metadata.event as { kind?: string } | undefined)?.kind === "push";
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
			disposition: push ? "cancelled" : "proposed",
			cancelledAt: push ? input.now : null,
			priority: input.deadline ? "high" : "low",
			accountableOwnerType: "tedi",
			accountableOwnerId: input.ownerTediId,
			stewardType: "tedi",
			stewardId: input.ownerTediId,
			deadline: input.deadline,
			metadata: push
				? {
						...input.metadata,
						settleReason: "advisory push observation",
						settledAt: input.now,
					}
				: input.metadata,
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
				.select(workItemStoredColumns)
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, orgId),
						eq(workItems.id, id),
						sql`${workItems.repositoryObserver} = 1`,
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
		.select(workItemStoredColumns)
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, orgId),
				eq(workItems.projectId, projectId),
				sql`${workItems.repositoryObserver} = 1`,
				sql`${workItems.report} IS NULL`,
				pendingObservation(),
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
		sql`${workItems.report} IS NULL`,
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
			.set({
				disposition: "proposed",
				cancelledAt: null,
				version: sql`${workItems.version} + 1`,
				metadata: sql`json_remove(${workItems.metadata}, '$.settleReason', '$.settledAt')`,
			})
			.where(
				and(
					eq(workItems.orgId, input.orgId),
					eq(workItems.id, input.id),
					sql`${workItems.disposition} = 'cancelled'`,
					sql`json_extract(${workItems.metadata}, '$.settleReason') = 'advisory push observation'`,
					unappliedLesson(),
				),
			),
		db
			.update(workItems)
			.set(
				settlementValues(
					input.now,
					sql`CASE WHEN json_extract(${workItems.metadata}, '$.event.kind') = 'push' THEN 'push observation reported; diagnosis retained' ELSE 'no action needed: observer reported clear' END`,
				),
			)
			.where(
				and(
					eq(workItems.orgId, input.orgId),
					eq(workItems.id, input.id),
					settleableObservation(input.now),
					sql`NOT (${unappliedLesson()})`,
					sql`(json_extract(${workItems.metadata}, '$.event.kind') = 'push' OR json_extract(${workItems.metadata}, '$.latestReport.stillRed') = 0)`,
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
				sql`${workItems.repositoryObserver} = 1`,
			),
		)
		.returning({ id: workItems.id });
	if (rows.length) return true;
	const existing = await getRepositoryObservation(db, orgId, id);
	return existing?.metadata?.repairKey === recipeKey;
}

/**
 * Claim a small retryable page before doing any external orchestration.
 *
 * Runs on every maintenance tick across all organizations, so it reads only
 * open observations, through their partial index. The unary plus keeps the
 * deadline away from the general deadline index, which holds every Work Item
 * whose deadline has passed.
 */
export async function overdueRepositoryObservations(
	db: DbQueryClient,
	now: string,
) {
	const candidates = db
		.select({ id: workItems.id })
		.from(workItems)
		.where(
			and(
				openRepositoryObservation,
				sql`json_extract(${workItems.metadata}, '$.event.kind') = 'ship_red'`,
				sql`+${workItems.deadline} <= ${now}`,
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
		.returning(workItemStoredColumns);
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

/** Record that the owner tedi was woken for an observation. */
export async function claimRepositoryObserverWake(
	db: DbQueryClient,
	p: { orgId: string; id: string; now: string },
): Promise<boolean> {
	const rows = await db
		.update(workItems)
		.set({
			metadata: sql`json_set(${workItems.metadata}, '$.observerWokenAt', ${p.now})`,
		})
		.where(
			and(
				eq(workItems.orgId, p.orgId),
				eq(workItems.id, p.id),
				sql`${workItems.repositoryObserver} = 1`,
			),
		)
		.returning({ id: workItems.id });
	return rows.length === 1;
}

/** Forget a wake that never reached the owner, so the retried event wakes it again. */
export async function releaseRepositoryObserverWake(
	db: DbQueryClient,
	p: { orgId: string; id: string },
) {
	await db
		.update(workItems)
		.set({
			metadata: sql`json_remove(${workItems.metadata}, '$.observerWokenAt')`,
		})
		.where(and(eq(workItems.orgId, p.orgId), eq(workItems.id, p.id)));
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

function unappliedLesson() {
	return sql`EXISTS (SELECT 1 FROM json_each(${workItems.metadata}, '$.latestReport.lessons') lesson WHERE json_extract(lesson.value, '$.verdict') = 'not_applied')`;
}

/** Settled advisory records can still receive bounded reviews for one day. */
function pendingObservation() {
	return sql`(${workItems.disposition} IN ('proposed','accepted') OR (${workItems.disposition} = 'cancelled' AND json_extract(${workItems.metadata}, '$.settleReason') = 'advisory push observation' AND julianday(${workItems.createdAt}) >= julianday('now', '-24 hours')))`;
}

function settleableObservation(now: string) {
	return and(
		sql`${workItems.repositoryObserver} = 1`,
		sql`${workItems.disposition} IN ('proposed','accepted')`,
		sql`NOT EXISTS (SELECT 1 FROM ${workAttempts} active_attempt WHERE active_attempt.org_id = ${workItems.orgId} AND active_attempt.work_item_id = ${workItems.id} AND active_attempt.runtime_state IN ('queued','running','waiting','retrying') AND (active_attempt.expires_at IS NULL OR active_attempt.expires_at > ${now}))`,
	);
}
function settlementValues(now: string, reason: string | SQL) {
	return {
		disposition: "cancelled" as const,
		cancelledAt: now,
		updatedAt: now,
		version: sql`${workItems.version} + 1`,
		metadata: sql`json_set(${workItems.metadata}, '$.settleReason', ${reason}, '$.settledAt', ${now})`,
	};
}
export async function settleRecoveredRepositoryShipObservations(
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
	return db
		.update(workItems)
		.set(settlementValues(p.now, "no action needed: ship_green recovery"))
		.where(
			and(
				eq(workItems.orgId, p.orgId),
				eq(workItems.projectId, p.projectId),
				sql`json_extract(${workItems.metadata}, '$.event.kind')='ship_red'`,
				sql`json_extract(${workItems.metadata}, '$.event.repository')=${p.repository}`,
				sql`json_extract(${workItems.metadata}, '$.event.branch')=${p.branch}`,
				sql`json_extract(${workItems.metadata}, '$.event.surface')=${p.surface}`,
				sql`julianday(coalesce(json_extract(${workItems.metadata}, '$.event.occurredAt'), ${workItems.createdAt})) <= julianday(${p.occurredAt ?? p.now})`,
				settleableObservation(p.now),
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
		sql`${workItems.repositoryObserver}=1`,
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
				// Implied by the settleable check; stated so SQLite may use the
				// open-observation index instead of walking every Work Item.
				openRepositoryObservation,
				settleableObservation(now),
				sql`json_extract(${workItems.metadata}, '$.event.kind') = 'push'`,
				sql`NOT (${unappliedLesson()})`,
				sql`julianday(${workItems.createdAt}) < julianday(${cutoff})`,
				sql`coalesce(json_extract(${workItems.metadata}, '$.latestReport.stillRed'), json_extract(${workItems.metadata}, '$.report.stillRed'), 0) = 0`,
				sql`NOT EXISTS (SELECT 1 FROM work_items red WHERE red.org_id = ${workItems.orgId} AND red.project_id = ${workItems.projectId} AND red.repository_observer = 1 AND red.disposition IN ('proposed','accepted') AND json_extract(red.metadata, '$.event.kind') IN ('ship_red','ci_red') AND json_extract(red.metadata, '$.event.repository') = json_extract(${workItems.metadata}, '$.event.repository') AND json_extract(red.metadata, '$.event.branch') = json_extract(${workItems.metadata}, '$.event.branch') AND json_extract(red.metadata, '$.event.sha') = json_extract(${workItems.metadata}, '$.event.sha'))`,
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
	const resolver = createCommitResolver(db);
	const shas = [
		...new Set(
			(
				await Promise.all(
					[...new Set(p.shas)].slice(0, 30).map(resolver.aliasesFor),
				)
			).flat(),
		),
	];
	if (!shas.length) return [];
	const list = sql`SELECT value FROM json_each(${JSON.stringify(shas)})`;
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
				sql`${workItems.repositoryObserver} = 1`,
				sql`json_extract(${workItems.metadata}, '$.event.kind') = 'push'`,
				sql`(json_extract(${workItems.metadata}, '$.event.sha') IN (${list}) OR EXISTS (SELECT 1 FROM json_each(${workItems.metadata}, '$.event.commitShas') c WHERE c.value IN (${list})))`,
			),
		)
		.orderBy(asc(workItems.createdAt), asc(workItems.id))
		.limit(100);
	const records = rows.flatMap((row) => {
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
	return Promise.all(
		records.map(async (row) => ({
			...row,
			sha: await resolver.canonicalCommit(row.sha),
			beforeSha: row.beforeSha
				? await resolver.canonicalCommit(row.beforeSha)
				: null,
			commitShas: await Promise.all(
				row.commitShas.map(resolver.canonicalCommit),
			),
		})),
	);
}

/** Exact head pushes whose commit trailer identifies the Work they delivered. */
export async function findWorkImplementationPushes(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		commitShas: string[];
		since: string;
	},
) {
	const resolver = createCommitResolver(db);
	const shas = [
		...new Set(
			(
				await Promise.all(
					[...new Set(params.commitShas)].slice(0, 30).map(resolver.aliasesFor),
				)
			).flat(),
		),
	];
	if (!shas.length) return [];
	const list = sql`SELECT value FROM json_each(${JSON.stringify(shas)})`;
	return db
		.select({
			id: workItems.id,
			projectId: workItems.projectId,
			metadata: workItems.metadata,
		})
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				gte(workItems.createdAt, params.since),
				sql`${workItems.repositoryObserver} = 1`,
				sql`json_extract(${workItems.metadata}, '$.event.kind') = 'push'`,
				sql`json_extract(${workItems.metadata}, '$.event.branch') = 'main'`,
				sql`json_extract(${workItems.metadata}, '$.event.workItemId') = ${params.workItemId}`,
				sql`json_extract(${workItems.metadata}, '$.event.sha') IN (${list})`,
			),
		)
		.limit(30);
}
