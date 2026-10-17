import { and, eq, sql } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../query-client";
import type { RepositoryObserverConfig } from "@tedix/api-contract/schemas/repository-observer";
import { projects } from "../schema/projects";
import { workItems, workItemComments } from "../schema/work-items";

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

/** Global scheduler scan of configured observer incidents only; tenant is carried on each row. */
export async function overdueRepositoryObservations(
	db: DbQueryClient,
	now: string,
) {
	return db
		.select()
		.from(workItems)
		.where(
			and(
				sql`json_extract(${workItems.metadata}, '$.repositoryObserver') = 1`,
				sql`json_extract(${workItems.metadata}, '$.event.kind') = 'ship_red'`,
				sql`${workItems.disposition} NOT IN ('completed','cancelled')`,
				sql`${workItems.deadline} <= ${now}`,
				sql`coalesce(json_extract(${workItems.metadata}, '$.latestReport.stillRed'), json_extract(${workItems.metadata}, '$.report.stillRed'), 1) = 1`,
			),
		)
		.orderBy(workItems.deadline)
		.limit(100);
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
