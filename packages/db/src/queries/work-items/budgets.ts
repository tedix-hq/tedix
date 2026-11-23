import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { tediObjectives } from "../../schema/tedi-objectives";
import { workItems } from "../../schema/work-items";
import {
	CREDIT_BUDGET_CURRENCY,
	workCaseItems,
	workBudgetEnvelopes,
	type WorkBudgetEnvelope,
	type WorkBudgetScope,
} from "../../schema/work-factory";
import {
	WorkControlError,
	requireProject,
	requireWorkCase,
	requireWorkItem,
} from "./factory-validation";

async function validateScope(
	db: DbQueryClient,
	p: { orgId: string; scopeType: WorkBudgetScope; scopeId: string },
) {
	if (p.scopeType === "organization") {
		if (p.scopeId !== p.orgId)
			throw new WorkControlError(
				"NOT_FOUND",
				"Organization budget scope id must equal orgId",
			);
	} else if (p.scopeType === "project")
		await requireProject(db, p.orgId, p.scopeId);
	else if (p.scopeType === "case")
		await requireWorkCase(db, p.orgId, p.scopeId);
	else if (p.scopeType === "objective") {
		const [objective] = await db
			.select({ id: tediObjectives.id })
			.from(tediObjectives)
			.where(
				and(
					eq(tediObjectives.orgId, p.orgId),
					eq(tediObjectives.id, p.scopeId),
				),
			)
			.limit(1);
		if (!objective)
			throw new WorkControlError(
				"NOT_FOUND",
				`Objective ${p.scopeId} was not found`,
			);
	} else await requireWorkItem(db, p.orgId, p.scopeId);
}
export interface CreateWorkBudgetEnvelopeParams {
	id: string;
	orgId: string;
	scopeType: WorkBudgetScope;
	scopeId: string;
	limitMicros: number;
	reservationMicros: number;
	currency?: string;
	now: string;
}
export async function createWorkBudgetEnvelope(
	db: DbQueryClient,
	p: CreateWorkBudgetEnvelopeParams,
): Promise<WorkBudgetEnvelope> {
	await validateScope(db, p);
	const create = db
		.insert(workBudgetEnvelopes)
		.values({
			...p,
			currency: p.currency ?? "USD",
			enabled: true,
			createdAt: p.now,
			updatedAt: null,
			version: 1,
		})
		.returning();
	if (p.scopeType !== "work_item") return (await create)[0]!;
	const item = await requireWorkItem(db, p.orgId, p.scopeId);
	const bump = db
		.update(workItems)
		.set({
			admissionSpecRevision: sql`lower(hex(randomblob(16)))`,
			updatedAt: p.now,
			version: sql`${workItems.version}+1`,
		})
		.where(
			and(
				eq(workItems.orgId, p.orgId),
				eq(workItems.id, p.scopeId),
				eq(workItems.version, item.version),
				eq(workItems.admissionSpecRevision, item.admissionSpecRevision),
			),
		)
		.returning({ id: workItems.id });
	try {
		const [rows, bumped] = await db.batch([create, bump]);
		if (!rows[0] || !bumped[0]) throw new Error("stale");
		return rows[0];
	} catch {
		throw new WorkControlError(
			"CONFLICT",
			"Budget envelope or Work Item admission specification changed",
		);
	}
}
export async function updateWorkBudgetEnvelope(
	db: DbQueryClient,
	p: {
		orgId: string;
		envelopeId: string;
		expectedVersion: number;
		limitMicros?: number;
		reservationMicros?: number;
		enabled?: boolean;
		now: string;
	},
) {
	const prior = (
		await db
			.select()
			.from(workBudgetEnvelopes)
			.where(
				and(
					eq(workBudgetEnvelopes.orgId, p.orgId),
					eq(workBudgetEnvelopes.id, p.envelopeId),
					eq(workBudgetEnvelopes.version, p.expectedVersion),
				),
			)
			.limit(1)
	)[0];
	if (!prior) throw new WorkControlError("CONFLICT", "Budget envelope changed");
	const mutate = db
		.update(workBudgetEnvelopes)
		.set({
			limitMicros: p.limitMicros,
			reservationMicros: p.reservationMicros,
			enabled: p.enabled,
			updatedAt: p.now,
			version: sql`${workBudgetEnvelopes.version}+1`,
		})
		.where(
			and(
				eq(workBudgetEnvelopes.orgId, p.orgId),
				eq(workBudgetEnvelopes.id, p.envelopeId),
				eq(workBudgetEnvelopes.version, p.expectedVersion),
				p.limitMicros !== undefined
					? sql`${p.limitMicros}>=(SELECT COALESCE(SUM(CASE WHEN r.state='consumed' THEN COALESCE(r.consumed_micros,r.amount_micros) ELSE r.amount_micros END),0) FROM work_budget_reservations r WHERE r.org_id=${p.orgId} AND r.envelope_id=${p.envelopeId} AND (r.state='consumed' OR (r.state='active' AND r.expires_at>${p.now})))`
					: undefined,
			),
		)
		.returning();
	if (prior.scopeType !== "work_item") {
		const row = (await mutate)[0];
		if (!row)
			throw new WorkControlError(
				"CONFLICT",
				"Budget envelope changed or limit is below committed spend",
			);
		return row;
	}
	const item = await requireWorkItem(db, p.orgId, prior.scopeId);
	const bump = db
		.update(workItems)
		.set({
			admissionSpecRevision: sql`lower(hex(randomblob(16)))`,
			updatedAt: p.now,
			version: sql`${workItems.version}+1`,
		})
		.where(
			and(
				eq(workItems.orgId, p.orgId),
				eq(workItems.id, prior.scopeId),
				eq(workItems.version, item.version),
				eq(workItems.admissionSpecRevision, item.admissionSpecRevision),
			),
		)
		.returning({ id: workItems.id });
	try {
		const [rows, bumped] = await db.batch([mutate, bump]);
		if (!rows[0] || !bumped[0]) throw new Error("stale");
		return rows[0];
	} catch {
		throw new WorkControlError(
			"CONFLICT",
			"Budget envelope or Work Item admission specification changed",
		);
	}
}
export async function getWorkBudgetEnvelopeByScope(
	db: DbQueryClient,
	p: {
		orgId: string;
		scopeType: WorkBudgetScope;
		scopeId: string;
		includeDisabled?: boolean;
	},
) {
	return (
		(
			await db
				.select()
				.from(workBudgetEnvelopes)
				.where(
					and(
						eq(workBudgetEnvelopes.orgId, p.orgId),
						eq(workBudgetEnvelopes.scopeType, p.scopeType),
						eq(workBudgetEnvelopes.scopeId, p.scopeId),
						p.includeDisabled
							? undefined
							: eq(workBudgetEnvelopes.enabled, true),
					),
				)
				.limit(1)
		)[0] ?? null
	);
}
export async function listWorkBudgetEnvelopes(
	db: DbQueryClient,
	p: {
		orgId: string;
		scopeType?: WorkBudgetScope;
		scopeId?: string;
		includeDisabled?: boolean;
		at: string;
		cursor?: string;
		limit?: number;
	},
) {
	const limit = Math.min(p.limit ?? 100, 500);
	const rows = await db
		.select({
			id: workBudgetEnvelopes.id,
			orgId: workBudgetEnvelopes.orgId,
			scopeType: workBudgetEnvelopes.scopeType,
			scopeId: workBudgetEnvelopes.scopeId,
			limitMicros: workBudgetEnvelopes.limitMicros,
			reservationMicros: workBudgetEnvelopes.reservationMicros,
			currency: workBudgetEnvelopes.currency,
			enabled: workBudgetEnvelopes.enabled,
			createdAt: workBudgetEnvelopes.createdAt,
			updatedAt: workBudgetEnvelopes.updatedAt,
			version: workBudgetEnvelopes.version,
			committedMicros:
				sql<number>`COALESCE((SELECT SUM(CASE WHEN r.state='consumed' THEN COALESCE(r.consumed_micros,r.amount_micros) ELSE r.amount_micros END) FROM work_budget_reservations r WHERE r.org_id="work_budget_envelopes"."org_id" AND r.envelope_id="work_budget_envelopes"."id" AND (r.state='consumed' OR (r.state='active' AND r.expires_at>${p.at}))),0)`.as(
					"committed_micros",
				),
		})
		.from(workBudgetEnvelopes)
		.where(
			and(
				eq(workBudgetEnvelopes.orgId, p.orgId),
				p.scopeType
					? eq(workBudgetEnvelopes.scopeType, p.scopeType)
					: undefined,
				p.scopeId ? eq(workBudgetEnvelopes.scopeId, p.scopeId) : undefined,
				p.includeDisabled ? undefined : eq(workBudgetEnvelopes.enabled, true),
				p.cursor ? gt(workBudgetEnvelopes.id, p.cursor) : undefined,
			),
		)
		.orderBy(asc(workBudgetEnvelopes.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);
	return {
		data,
		nextCursor: hasMore ? data.at(-1)!.id : null,
		observedAt: p.at,
	};
}

/** Parent links followed when collecting a Work Item's budgets; deeper trees are cut off. */
const CREDIT_BUDGET_ANCESTOR_DEPTH = 16;

export interface CreditBudget {
	id: string;
	scopeType: WorkBudgetScope;
	scopeId: string;
	/** Millionths of a credit. */
	limitMicros: number;
}

/**
 * Every enabled credit budget that spend on `workItemId` counts against: the
 * item and its parents, their projects, cases and objectives, and the
 * organization. One read; the wallet caches the result briefly.
 */
export async function getCreditBudgetsForWorkItem(
	db: DbQueryClient,
	p: { orgId: string; workItemId: string },
): Promise<CreditBudget[]> {
	const items: string[] = [];
	const projects = new Set<string>();
	const objectives = new Set<string>();
	let next: string | null = p.workItemId;
	while (next && items.length <= CREDIT_BUDGET_ANCESTOR_DEPTH) {
		if (items.includes(next)) break;
		const [row] = await db
			.select({
				parentId: workItems.parentWorkItemId,
				projectId: workItems.projectId,
				objectiveId: workItems.objectiveId,
			})
			.from(workItems)
			.where(and(eq(workItems.orgId, p.orgId), eq(workItems.id, next)))
			.limit(1);
		if (!row) break;
		items.push(next);
		if (row.projectId) projects.add(row.projectId);
		if (row.objectiveId) objectives.add(row.objectiveId);
		next = row.parentId;
	}
	const scope = (type: WorkBudgetScope, ids: string[]) =>
		ids.length
			? and(
					eq(workBudgetEnvelopes.scopeType, type),
					// bound-params: at most CREDIT_BUDGET_ANCESTOR_DEPTH + 1 ids
					inArray(workBudgetEnvelopes.scopeId, ids),
				)
			: undefined;
	return db
		.select({
			id: workBudgetEnvelopes.id,
			scopeType: workBudgetEnvelopes.scopeType,
			scopeId: workBudgetEnvelopes.scopeId,
			limitMicros: workBudgetEnvelopes.limitMicros,
		})
		.from(workBudgetEnvelopes)
		.where(
			and(
				eq(workBudgetEnvelopes.orgId, p.orgId),
				eq(workBudgetEnvelopes.enabled, true),
				eq(workBudgetEnvelopes.currency, CREDIT_BUDGET_CURRENCY),
				or(
					scope("organization", [p.orgId]),
					scope("work_item", items),
					scope("project", [...projects]),
					scope("objective", [...objectives]),
					items.length
						? and(
								eq(workBudgetEnvelopes.scopeType, "case"),
								// bound-params: a subquery over the bounded ancestor chain
								inArray(
									workBudgetEnvelopes.scopeId,
									db
										.select({ caseId: workCaseItems.caseId })
										.from(workCaseItems)
										.where(
											and(
												eq(workCaseItems.orgId, p.orgId),
												// bound-params: at most CREDIT_BUDGET_ANCESTOR_DEPTH + 1 ids
												inArray(workCaseItems.workItemId, items),
											),
										),
								),
							)
						: undefined,
				),
			),
		);
}
