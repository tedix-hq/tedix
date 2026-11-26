/**
 * Tedi Objectives Query Helpers
 * CRUD operations for tedi_objectives
 *
 * Used by the tedi-objectives router and Tedix OS UI.
 */

import { DEFAULT_STANDING_OBJECTIVE_GATE_CONFIG } from "@tedix/api-contract/contracts/tedi-objectives";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, getColumns } from "drizzle-orm";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import {
	type OrganizationPurposeCharter,
	organizationPurposeCharters,
} from "../schema/organization-purpose";
import {
	type ObjectiveRiskLevel,
	type ObjectiveStatus,
	type ObjectiveType,
	type TediObjective,
	tediObjectives,
} from "../schema/tedi-objectives";

// The column remains in storage until its historical values can be reviewed.
const { linkedDomains: _linkedDomains, ...objectiveColumns } =
	getColumns(tediObjectives);

// ============================================================================
// Types — Objectives
// ============================================================================

export interface CreateObjectiveParams {
	id: string;
	tediId: string;
	orgId: string;
	purposeCharterId?: string | null;
	title: string;
	description?: string;
	approach?: string;
	successCriteria?: string;
	constraints?: string;
	type: ObjectiveType;
	riskLevel?: ObjectiveRiskLevel;
	priority?: number;
	gateConfig?: Record<string, JsonValue>;
	budgetConfig?: Record<string, JsonValue>;
	createdAt: string;
}

export interface ListObjectivesOptions {
	orgId?: string;
	tediId?: string;
	status?: ObjectiveStatus;
	type?: ObjectiveType;
	riskLevel?: ObjectiveRiskLevel;
	limit?: number;
	offset?: number;
}

export interface UpdateObjectiveParams {
	purposeCharterId?: string | null;
	title?: string;
	description?: string;
	approach?: string;
	successCriteria?: string;
	constraints?: string;
	status?: ObjectiveStatus;
	riskLevel?: ObjectiveRiskLevel;
	priority?: number;
	gateConfig?: Record<string, JsonValue>;
	budgetConfig?: Record<string, JsonValue>;
	progress?: Record<string, JsonValue>;
	updatedAt: string;
	completedAt?: string;
}

// ============================================================================
// Objectives — Read
// ============================================================================

export async function listObjectives(
	db: DbClient,
	options: ListObjectivesOptions,
): Promise<{ data: TediObjective[]; total: number }> {
	const { limit = 50, offset = 0 } = options;

	const conditions: ReturnType<typeof eq>[] = [];
	if (options.orgId) {
		conditions.push(eq(tediObjectives.orgId, options.orgId));
	}
	if (options.tediId) {
		conditions.push(eq(tediObjectives.tediId, options.tediId));
	}
	if (options.status) {
		conditions.push(eq(tediObjectives.status, options.status));
	}
	if (options.type) {
		conditions.push(eq(tediObjectives.type, options.type));
	}
	if (options.riskLevel) {
		conditions.push(eq(tediObjectives.riskLevel, options.riskLevel));
	}

	const whereClause = and(...conditions);

	const data = await db
		.select(objectiveColumns)
		.from(tediObjectives)
		.where(whereClause)
		.orderBy(tediObjectives.priority, desc(tediObjectives.createdAt))
		.limit(limit)
		.offset(offset);

	const total = await db.$count(tediObjectives, whereClause);

	return { data, total };
}

/**
 * The organization's most important active objective (lowest priority
 * number, then id), as a one-row query that can also run as a subquery.
 */
export function topActiveObjectiveQuery(db: DbQueryClient, orgId: string) {
	return db
		.select({ id: tediObjectives.id })
		.from(tediObjectives)
		.where(
			and(eq(tediObjectives.orgId, orgId), eq(tediObjectives.status, "active")),
		)
		.orderBy(tediObjectives.priority, tediObjectives.id)
		.limit(1);
}

export async function getObjectiveById(
	db: DbClient,
	id: string,
): Promise<TediObjective | undefined> {
	const results = await db
		.select(objectiveColumns)
		.from(tediObjectives)
		.where(eq(tediObjectives.id, id));
	return results[0];
}

// ============================================================================
// Objectives — Write
// ============================================================================

/** True for a missing or `{}` gate config (both mean "ungated"). */
function isEmptyGateConfig(
	gateConfig: Record<string, JsonValue> | undefined,
): boolean {
	return !gateConfig || Object.keys(gateConfig).length === 0;
}

export async function createObjective(
	db: DbClient,
	data: CreateObjectiveParams,
): Promise<TediObjective> {
	// WS6 gate↔objective coupling: standing objectives are gated by default.
	// An explicit gateConfig always wins; an omitted/empty one gets the
	// first_n(3) default so processGateGraduation governs real work.
	const gateConfig =
		data.type === "standing" && isEmptyGateConfig(data.gateConfig)
			? { ...DEFAULT_STANDING_OBJECTIVE_GATE_CONFIG }
			: (data.gateConfig ?? {});
	let purposeCharter: OrganizationPurposeCharter | undefined;
	if (data.purposeCharterId) {
		const rows = await db
			.select()
			.from(organizationPurposeCharters)
			.where(
				and(
					eq(organizationPurposeCharters.id, data.purposeCharterId),
					eq(organizationPurposeCharters.orgId, data.orgId),
				),
			)
			.limit(1);
		purposeCharter = rows[0];
		if (!purposeCharter) {
			throw new Error("Purpose Charter is outside the objective organization");
		}
	} else {
		const rows = await db
			.select()
			.from(organizationPurposeCharters)
			.where(
				and(
					eq(organizationPurposeCharters.orgId, data.orgId),
					eq(organizationPurposeCharters.status, "active"),
				),
			)
			.limit(1);
		purposeCharter = rows[0];
	}
	const results = await db
		.insert(tediObjectives)
		.values({
			id: data.id,
			tediId: data.tediId,
			orgId: data.orgId,
			purposeCharterId: purposeCharter?.id ?? null,
			title: data.title,
			description: data.description ?? null,
			approach: data.approach ?? null,
			successCriteria: data.successCriteria ?? null,
			constraints: data.constraints ?? null,
			type: data.type,
			riskLevel: data.riskLevel ?? "medium",
			priority: data.priority ?? 0,
			gateConfig,
			budgetConfig: data.budgetConfig ?? {},
			createdAt: data.createdAt,
		})
		.returning(objectiveColumns);
	return results[0]!;
}

export async function updateObjective(
	db: DbClient,
	id: string,
	params: UpdateObjectiveParams,
): Promise<TediObjective | undefined> {
	const set: Record<string, unknown> = { updatedAt: params.updatedAt };
	if (params.purposeCharterId !== undefined) {
		set.purposeCharterId = params.purposeCharterId;
	}
	if (params.title !== undefined) set.title = params.title;
	if (params.description !== undefined) set.description = params.description;
	if (params.approach !== undefined) set.approach = params.approach;
	if (params.successCriteria !== undefined) {
		set.successCriteria = params.successCriteria;
	}
	if (params.constraints !== undefined) set.constraints = params.constraints;
	if (params.status !== undefined) set.status = params.status;
	if (params.riskLevel !== undefined) set.riskLevel = params.riskLevel;
	if (params.priority !== undefined) set.priority = params.priority;
	if (params.gateConfig !== undefined) set.gateConfig = params.gateConfig;
	if (params.budgetConfig !== undefined) set.budgetConfig = params.budgetConfig;
	if (params.progress !== undefined) set.progress = params.progress;
	if (params.completedAt !== undefined) set.completedAt = params.completedAt;

	const results = await db
		.update(tediObjectives)
		.set(set)
		.where(eq(tediObjectives.id, id))
		.returning(objectiveColumns);
	return results[0];
}

export async function deleteObjective(
	db: DbClient,
	id: string,
	retiredAt: string,
): Promise<boolean> {
	// Objectives are audit/purpose anchors. A hard delete would invoke legacy
	// ON DELETE SET NULL references and turn objective-class Work Items into
	// invalid, purpose-less rows. Preserve the anchor and retire it instead.
	const results = await db
		.update(tediObjectives)
		.set({
			status: "failed",
			updatedAt: retiredAt,
			completedAt: retiredAt,
		})
		.where(eq(tediObjectives.id, id))
		.returning(objectiveColumns);
	return results.length > 0;
}
