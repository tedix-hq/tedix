import {
	and,
	asc,
	eq,
	getColumns,
	gte,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { createCommitResolver } from "./git-commit-aliases";
import type { DbQueryClient } from "../query-client";
import type { RepositoryObserverConfig } from "@tedix/api-contract/schemas/repository-observer";
import { projects as d1Projects } from "../schema/projects";
import {
	openRepositoryObservation,
	workAttempts as d1WorkAttempts,
	workItemComments as d1WorkItemComments,
	workItems as d1WorkItems,
	workItemStoredColumns as d1StoredColumns,
} from "../schema/work-items";
import { coreTable } from "../core-store/client";
import { anyIds, coreStore, jsonRead, jsonWrite } from "../core-store/dialect";

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
	const workItems = coreTable(db, d1WorkItems);
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
			admissionSpecRevision: crypto.randomUUID(),
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
	const workItems = coreTable(db, d1WorkItems);
	return (
		(
			await db
				.select(storedColumns(db))
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, orgId),
						eq(workItems.id, id),
						sql`${observerFlag(db)} = 1`,
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
	const workItems = coreTable(db, d1WorkItems);
	return db
		.select(storedColumns(db))
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, orgId),
				eq(workItems.projectId, projectId),
				sql`${observerFlag(db)} = 1`,
				sql`${observationReport(db)} IS NULL`,
				pendingObservation(db),
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
	const workItems = coreTable(db, d1WorkItems);
	const workItemComments = coreTable(db, d1WorkItemComments);
	const predicate = and(
		eq(workItems.orgId, input.orgId),
		eq(workItems.id, input.id),
		sql`${observationReport(db)} IS NULL`,
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
				metadata:
					coreStore(db) === "d1"
						? sql`json_set(${workItems.metadata}, '$.report', json((SELECT json_extract(c.metadata, '$.report') FROM work_item_comments c WHERE c.org_id = ${input.orgId} AND c.id = ${input.id})), '$.diagnosedAt', ${input.now})`
						: sql`${workItems.metadata} || jsonb_build_object('report', (SELECT c.metadata -> 'report' FROM work_item_comments c WHERE c.org_id = ${input.orgId} AND c.id = ${input.id}), 'diagnosedAt', ${input.now}::text)`,
				updatedAt: input.now,
			})
			.where(predicate),
		db
			.update(workItems)
			.set({
				metadata: jsonWrite(
					db,
					jsonWrite(db, workItems.metadata, ["latestReport"], input.report),
					["lastDiagnosedAt"],
					input.now,
				),
				updatedAt: input.now,
			})
			.where(and(eq(workItems.orgId, input.orgId), eq(workItems.id, input.id))),
		db
			.update(workItems)
			.set({
				disposition: "proposed",
				cancelledAt: null,
				version: sql`${workItems.version} + 1`,
				metadata:
					coreStore(db) === "d1"
						? sql`json_remove(${workItems.metadata}, '$.settleReason', '$.settledAt')`
						: sql`${workItems.metadata} - 'settleReason' - 'settledAt'`,
			})
			.where(
				and(
					eq(workItems.orgId, input.orgId),
					eq(workItems.id, input.id),
					sql`${workItems.disposition} = 'cancelled'`,
					sql`${jsonRead(db, workItems.metadata, ["settleReason"])} = 'advisory push observation'`,
					unappliedLesson(db),
				),
			),
		db
			.update(workItems)
			.set(
				settlementValues(
					db,
					input.now,
					sql`CASE WHEN ${jsonRead(db, workItems.metadata, ["event", "kind"])} = 'push' THEN 'push observation reported; diagnosis retained' ELSE 'no action needed: observer reported clear' END`,
				),
			)
			.where(
				and(
					eq(workItems.orgId, input.orgId),
					eq(workItems.id, input.id),
					settleableObservation(db, input.now),
					sql`NOT (${unappliedLesson(db)})`,
					sql`(${jsonRead(db, workItems.metadata, ["event", "kind"])} = 'push' OR ${reportFlag(db, workItems.metadata, ["latestReport", "stillRed"])} = 0)`,
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
	const workItems = coreTable(db, d1WorkItems);
	const rows = await db
		.update(workItems)
		.set({
			metadata: jsonWrite(
				db,
				jsonWrite(
					db,
					jsonWrite(db, workItems.metadata, ["repairLessonId"], lessonId),
					["repairKey"],
					recipeKey,
				),
				["repairKind"],
				kind,
			),
		})
		.where(
			and(
				eq(workItems.orgId, orgId),
				eq(workItems.id, id),
				sql`${jsonRead(db, workItems.metadata, ["repairLessonId"])} IS NULL`,
				sql`${observerFlag(db)} = 1`,
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
 * Scheduled calls restrict discovery to the organization and IDs claimed from
 * work_due. The partial index still supports explicit on-demand maintenance.
 */
export async function overdueRepositoryObservations(
	db: DbQueryClient,
	now: string,
	scope?: { orgId: string; ids: string[] },
) {
	const workItems = coreTable(db, d1WorkItems);
	const candidates = db
		.select({ id: workItems.id })
		.from(workItems)
		.where(
			and(
				scope
					? and(
							eq(workItems.orgId, scope.orgId),
							anyIds(db, workItems.id, scope.ids),
						)
					: undefined,
				openObservation(db),
				sql`${jsonRead(db, workItems.metadata, ["event", "kind"])} = 'ship_red'`,
				coreStore(db) === "d1"
					? sql`+${workItems.deadline} <= ${now}`
					: sql`${workItems.deadline} <= ${now}`,
				sql`coalesce(${reportFlag(db, workItems.metadata, ["latestReport", "stillRed"])}, ${reportFlag(db, workItems.metadata, ["report", "stillRed"])}, 1) = 1`,
				sql`${jsonRead(db, workItems.metadata, ["observerEscalatedAt"])} IS NULL`,
				sql`coalesce(${jsonRead(db, workItems.metadata, ["observerRetryAt"])}, '') <= ${now}`,
				// Skip deliveries made before durable maintenance progress existed.
				sql`NOT EXISTS (SELECT 1 FROM work_interactions i WHERE i.org_id = ${workItems.orgId} AND i.work_item_id = ${workItems.id} AND i.kind = 'coordination' AND ${jsonRead(db, sql`i.metadata`, ["reason"])} = 'Red Ship needs a decision after diagnosis or the single repair attempt')`,
			),
		)
		.orderBy(
			sql`coalesce(${jsonRead(db, workItems.metadata, ["observerRetryAt"])}, '')`,
			workItems.deadline,
			workItems.id,
		)
		.limit(5);
	const retryAt = new Date(Date.parse(now) + 5 * 60_000).toISOString();
	return db
		.update(workItems)
		.set({
			metadata: jsonWrite(
				db,
				jsonWrite(db, workItems.metadata, ["observerRetryAt"], retryAt),
				["observerMaintenanceReason"],
				"in_progress",
			),
		})
		.where(sql`${workItems.id} IN (${candidates})`)
		.returning(storedColumns(db));
}

export async function finishRepositoryObserverEscalation(
	db: DbQueryClient,
	row: { orgId: string; id: string },
	now: string,
	reason: string,
) {
	const workItems = coreTable(db, d1WorkItems);
	return db
		.update(workItems)
		.set({
			metadata:
				reason === "delivered"
					? jsonWrite(
							db,
							jsonWrite(db, workItems.metadata, ["observerEscalatedAt"], now),
							["observerMaintenanceReason"],
							reason,
						)
					: jsonWrite(
							db,
							workItems.metadata,
							["observerMaintenanceReason"],
							reason,
						),
		})
		.where(and(eq(workItems.orgId, row.orgId), eq(workItems.id, row.id)));
}

/** At-most-once delivery to the independently authenticated ops workflow. A lost response escalates. */
export async function claimRepositoryRetryDelivery(
	db: DbQueryClient,
	orgId: string,
	id: string,
) {
	const workItems = coreTable(db, d1WorkItems);
	const rows = await db
		.update(workItems)
		.set({
			metadata: jsonWrite(
				db,
				workItems.metadata,
				["repairDeliveredAt"],
				new Date().toISOString(),
			),
		})
		.where(
			and(
				eq(workItems.orgId, orgId),
				eq(workItems.id, id),
				sql`${jsonRead(db, workItems.metadata, ["repairKind"])} = 'retry'`,
				sql`${jsonRead(db, workItems.metadata, ["repairDeliveredAt"])} IS NULL`,
				sql`coalesce(${reportFlag(db, workItems.metadata, ["latestReport", "stillRed"])}, ${reportFlag(db, workItems.metadata, ["report", "stillRed"])}) = 1`,
			),
		)
		.returning({
			evidenceUrl:
				sql<string>`${jsonRead(db, workItems.metadata, ["event", "evidenceUrl"])}`.as(
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
	const workItems = coreTable(db, d1WorkItems);
	const rows = await db
		.update(workItems)
		.set({
			metadata: jsonWrite(db, workItems.metadata, ["observerWokenAt"], p.now),
		})
		.where(
			and(
				eq(workItems.orgId, p.orgId),
				eq(workItems.id, p.id),
				sql`${observerFlag(db)} = 1`,
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
	const workItems = coreTable(db, d1WorkItems);
	await db
		.update(workItems)
		.set({
			metadata:
				coreStore(db) === "d1"
					? sql`json_remove(${workItems.metadata}, '$.observerWokenAt')`
					: sql`${workItems.metadata} - 'observerWokenAt'`,
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
	const projects = coreTable(db, d1Projects);
	const rows = await db
		.update(projects)
		.set({
			metadata: jsonWrite(
				db,
				projects.metadata,
				["repositoryObserver"],
				config,
			),
			updatedAt: now,
		})
		.where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
		.returning({ id: projects.id });
	return rows.length === 1;
}

const PUSH_OBSERVATION_RETENTION_HOURS = 24;

function unappliedLesson(db: DbQueryClient) {
	const workItems = coreTable(db, d1WorkItems);
	return coreStore(db) === "d1"
		? sql`EXISTS (SELECT 1 FROM json_each(${workItems.metadata}, '$.latestReport.lessons') lesson WHERE json_extract(lesson.value, '$.verdict') = 'not_applied')`
		: sql`EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(${jsonRead(db, workItems.metadata, ["latestReport", "lessons"], "json")}, '[]'::jsonb)) lesson(value) WHERE lesson.value ->> 'verdict' = 'not_applied')`;
}

/** Settled advisory records can still receive bounded reviews for one day. */
function pendingObservation(db: DbQueryClient) {
	const workItems = coreTable(db, d1WorkItems);
	return sql`(${workItems.disposition} IN ('proposed','accepted') OR (${workItems.disposition} = 'cancelled' AND ${jsonRead(db, workItems.metadata, ["settleReason"])} = 'advisory push observation' AND ${observationTime(db, sql`${workItems.createdAt}`)} >= ${observationTime(db, sql`${new Date(Date.now() - 24 * 60 * 60_000).toISOString()}`)}))`;
}

function settleableObservation(db: DbQueryClient, now: string) {
	const workItems = coreTable(db, d1WorkItems);
	const workAttempts = coreTable(db, d1WorkAttempts);
	return and(
		sql`${observerFlag(db)} = 1`,
		sql`${workItems.disposition} IN ('proposed','accepted')`,
		sql`NOT EXISTS (SELECT 1 FROM ${workAttempts} active_attempt WHERE active_attempt.org_id = ${workItems.orgId} AND active_attempt.work_item_id = ${workItems.id} AND active_attempt.runtime_state IN ('queued','running','waiting','retrying') AND (active_attempt.expires_at IS NULL OR active_attempt.expires_at > ${now}))`,
	);
}
function settlementValues(
	db: DbQueryClient,
	now: string,
	reason: string | SQL,
) {
	const workItems = coreTable(db, d1WorkItems);
	return {
		disposition: "cancelled" as const,
		cancelledAt: now,
		updatedAt: now,
		version: sql`${workItems.version} + 1`,
		metadata:
			coreStore(db) === "d1"
				? sql`json_set(${workItems.metadata}, '$.settleReason', ${reason}, '$.settledAt', ${now})`
				: sql`${workItems.metadata} || jsonb_build_object('settleReason', ${reason}::text, 'settledAt', ${now}::text)`,
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
	const workItems = coreTable(db, d1WorkItems);
	return db
		.update(workItems)
		.set(settlementValues(db, p.now, "no action needed: ship_green recovery"))
		.where(
			and(
				eq(workItems.orgId, p.orgId),
				eq(workItems.projectId, p.projectId),
				sql`${jsonRead(db, workItems.metadata, ["event", "kind"])}='ship_red'`,
				sql`${jsonRead(db, workItems.metadata, ["event", "repository"])}=${p.repository}`,
				sql`${jsonRead(db, workItems.metadata, ["event", "branch"])}=${p.branch}`,
				sql`${jsonRead(db, workItems.metadata, ["event", "surface"])}=${p.surface}`,
				sql`${observationTime(db, sql`coalesce(${jsonRead(db, workItems.metadata, ["event", "occurredAt"])}, ${workItems.createdAt})`)} <= ${observationTime(db, sql`${p.occurredAt ?? p.now}`)}`,
				settleableObservation(db, p.now),
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
	const workItems = coreTable(db, d1WorkItems);
	const scope = and(
		eq(workItems.orgId, p.orgId),
		eq(workItems.projectId, p.projectId),
		sql`${observerFlag(db)}=1`,
		sql`${jsonRead(db, workItems.metadata, ["event", "kind"])}='ci_red'`,
		sql`${jsonRead(db, workItems.metadata, ["event", "repository"])}=${p.repository}`,
		sql`${jsonRead(db, workItems.metadata, ["event", "branch"])}=${p.branch}`,
		sql`${jsonRead(db, workItems.metadata, ["event", "surface"])}=${p.surface}`,
		sql`${observationTime(db, sql`coalesce(${jsonRead(db, workItems.metadata, ["event", "occurredAt"])}, ${workItems.createdAt})`)} <= ${observationTime(db, sql`${p.occurredAt ?? p.now}`)}`,
	);
	return db.batch([
		// Active attempts keep their lifecycle, but their late reports cannot reopen alerts.
		db
			.update(workItems)
			.set({
				metadata: jsonWrite(db, workItems.metadata, ["ciRecoveredAt"], p.now),
			})
			.where(scope),
		db
			.update(workItems)
			.set(settlementValues(db, p.now, "no action needed: ci_green recovery"))
			.where(and(scope, settleableObservation(db, p.now)))
			.returning({ id: workItems.id }),
	]);
}

/** The subquery bounds the mutation without binding a page of IDs or racing a prior read. */
export async function settleAgedRepositoryPushObservations(
	db: DbQueryClient,
	now: string,
	scope?: { orgId: string; ids: string[] },
) {
	const workItems = coreTable(db, d1WorkItems);
	const cutoff = new Date(
		Date.parse(now) - PUSH_OBSERVATION_RETENTION_HOURS * 60 * 60_000,
	).toISOString();
	const candidates = db
		.select({ id: workItems.id })
		.from(workItems)
		.where(
			and(
				scope
					? and(
							eq(workItems.orgId, scope.orgId),
							anyIds(db, workItems.id, scope.ids),
						)
					: undefined,
				// Implied by the settleable check; stated so SQLite may use the
				// open-observation index instead of walking every Work Item.
				openObservation(db),
				settleableObservation(db, now),
				sql`${jsonRead(db, workItems.metadata, ["event", "kind"])} = 'push'`,
				sql`NOT (${unappliedLesson(db)})`,
				sql`${observationTime(db, sql`${workItems.createdAt}`)} < ${observationTime(db, sql`${cutoff}`)}`,
				sql`coalesce(${reportFlag(db, workItems.metadata, ["latestReport", "stillRed"])}, ${reportFlag(db, workItems.metadata, ["report", "stillRed"])}, 0) = 0`,
				sql`NOT EXISTS (SELECT 1 FROM work_items red WHERE red.org_id = ${workItems.orgId} AND red.project_id = ${workItems.projectId} AND ${coreStore(db) === "d1" ? sql`red.repository_observer` : jsonRead(db, sql`red.metadata`, ["repositoryObserver"], "number")} = 1 AND red.disposition IN ('proposed','accepted') AND ${jsonRead(db, sql`red.metadata`, ["event", "kind"])} IN ('ship_red','ci_red') AND ${jsonRead(db, sql`red.metadata`, ["event", "repository"])} = ${jsonRead(db, workItems.metadata, ["event", "repository"])} AND ${jsonRead(db, sql`red.metadata`, ["event", "branch"])} = ${jsonRead(db, workItems.metadata, ["event", "branch"])} AND ${jsonRead(db, sql`red.metadata`, ["event", "sha"])} = ${jsonRead(db, workItems.metadata, ["event", "sha"])})`,
			),
		)
		.orderBy(workItems.createdAt, workItems.id)
		.limit(100);
	return db
		.update(workItems)
		.set(
			settlementValues(
				db,
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
	const workItems = coreTable(db, d1WorkItems);
	const resolver = createCommitResolver(db);
	const requested = [...new Set(p.shas)].slice(0, 30);
	await resolver.resolveMany(requested);
	const shas = [
		...new Set((await Promise.all(requested.map(resolver.aliasesFor))).flat()),
	];
	if (!shas.length) return [];

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
				sql`${observerFlag(db)} = 1`,
				sql`${jsonRead(db, workItems.metadata, ["event", "kind"])} = 'push'`,
				sql`(${anyIds(db, jsonRead(db, workItems.metadata, ["event", "sha"]), shas)} OR EXISTS (SELECT 1 FROM ${coreStore(db) === "d1" ? sql`json_each(${workItems.metadata}, '$.event.commitShas')` : sql`jsonb_array_elements_text(coalesce(${jsonRead(db, workItems.metadata, ["event", "commitShas"], "json")}, '[]'::jsonb))`} c WHERE ${anyIds(db, sql`c.value`, shas)}))`,
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
	await resolver.resolveMany(
		records.flatMap((row) => [
			row.sha,
			...(row.beforeSha ? [row.beforeSha] : []),
			...row.commitShas,
		]),
	);
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
	const workItems = coreTable(db, d1WorkItems);
	const resolver = createCommitResolver(db);
	const requested = [...new Set(params.commitShas)].slice(0, 30);
	await resolver.resolveMany(requested);
	const shas = [
		...new Set((await Promise.all(requested.map(resolver.aliasesFor))).flat()),
	];
	if (!shas.length) return [];

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
				sql`${observerFlag(db)} = 1`,
				sql`${jsonRead(db, workItems.metadata, ["event", "kind"])} = 'push'`,
				sql`${jsonRead(db, workItems.metadata, ["event", "branch"])} = 'main'`,
				sql`${jsonRead(db, workItems.metadata, ["event", "workItemId"])} = ${params.workItemId}`,
				anyIds(db, jsonRead(db, workItems.metadata, ["event", "sha"]), shas),
			),
		)
		.limit(30);
}

function storedColumns(db: DbQueryClient): typeof d1StoredColumns {
	const columns = getColumns(coreTable(db, d1WorkItems));
	return Object.fromEntries(
		Object.keys(d1StoredColumns).map((key) => [
			key,
			columns[key as keyof typeof columns],
		]),
	) as typeof d1StoredColumns;
}
function observerFlag(db: DbQueryClient) {
	const workItems = coreTable(db, d1WorkItems);
	return coreStore(db) === "d1"
		? sql`${workItems.repositoryObserver}`
		: jsonRead(db, workItems.metadata, ["repositoryObserver"], "number");
}
function observationReport(db: DbQueryClient) {
	const workItems = coreTable(db, d1WorkItems);
	return coreStore(db) === "d1"
		? sql`${workItems.report}`
		: jsonRead(db, workItems.metadata, ["report"]);
}
function openObservation(db: DbQueryClient) {
	const workItems = coreTable(db, d1WorkItems);
	return coreStore(db) === "d1"
		? openRepositoryObservation
		: sql`${observerFlag(db)} = 1 AND ${workItems.disposition} IN ('proposed','accepted')`;
}
function reportFlag(
	db: DbQueryClient,
	column: SQLWrapper,
	path: readonly string[],
) {
	return coreStore(db) === "d1"
		? jsonRead(db, column, path)
		: sql`coalesce(${jsonRead(db, column, path, "number")}, CASE ${jsonRead(db, column, path, "boolean")} WHEN true THEN 1 WHEN false THEN 0 END)`;
}
function observationTime(db: DbQueryClient, value: SQL) {
	return coreStore(db) === "d1"
		? sql`julianday(${value})`
		: sql`${value}::timestamptz`;
}
