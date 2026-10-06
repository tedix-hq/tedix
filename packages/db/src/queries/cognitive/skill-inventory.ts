import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	isNotNull,
	ne,
	notExists,
	type SQL,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import {
	type CognitiveVisibility,
	type SkillEntry,
	skillEntries,
} from "../../schema/cognitive";
import type { SkillLifecycleState } from "../skill-lifecycle";
import { readableSkillCondition } from "./skill-crud";

export async function listAllSkillsForOrg(
	db: DbClient,
	orgId: string,
	options?: {
		appId?: string;
		domainId?: string;
		lifecycleState?: SkillLifecycleState;
		limit?: number;
		offset?: number;
		query?: string;
		folderPath?: string | null;
		recursive?: boolean;
		tediId?: string;
		visibility?: CognitiveVisibility;
	},
): Promise<{ entries: SkillEntry[]; total: number }> {
	const conditions = [eq(skillEntries.organizationId, orgId)];
	if (options?.visibility) {
		conditions.push(eq(skillEntries.visibility, options.visibility));
	}
	if (options?.appId) {
		conditions.push(eq(skillEntries.appId, options.appId));
	}
	if (options?.domainId) {
		conditions.push(eq(skillEntries.domainId, options.domainId));
	}
	if (options?.tediId) {
		conditions.push(readableSkillCondition(options.tediId));
		if (!options.lifecycleState)
			conditions.push(ne(skillEntries.lifecycleState, "draft"));
		const override = alias(skillEntries, "tedi_skill_override");
		conditions.push(
			notExists(
				db
					.select({ id: override.id })
					.from(override)
					.where(
						and(
							eq(override.organizationId, orgId),
							eq(override.tediId, options.tediId),
							eq(override.supersedesId, skillEntries.id),
							options.lifecycleState
								? eq(override.lifecycleState, options.lifecycleState)
								: ne(override.lifecycleState, "draft"),
						),
					),
			),
		);
	}
	if (options?.lifecycleState) {
		conditions.push(eq(skillEntries.lifecycleState, options.lifecycleState));
	}
	if (options?.folderPath === null) {
		conditions.push(isNull(skillEntries.folderPath));
	} else if (options?.folderPath !== undefined) {
		const folderPath = options.folderPath;
		conditions.push(
			options.recursive
				? sql`(${skillEntries.folderPath} = ${folderPath} OR ${skillEntries.folderPath} LIKE ${`${escapeLikePattern(folderPath)}/%`} ESCAPE '\\')`
				: eq(skillEntries.folderPath, folderPath),
		);
	}
	const query = options?.query?.trim().toLowerCase();
	if (query) {
		const pattern = `%${escapeLikePattern(query)}%`;
		conditions.push(sql`(
			lower(${skillEntries.title}) LIKE ${pattern} ESCAPE '\\'
			OR lower(coalesce(${skillEntries.slug}, '')) LIKE ${pattern} ESCAPE '\\'
			OR lower(coalesce(${skillEntries.description}, '')) LIKE ${pattern} ESCAPE '\\'
			OR lower(coalesce(${skillEntries.folderPath}, '')) LIKE ${pattern} ESCAPE '\\'
		)`);
	}
	const whereClause = and(...conditions);
	const [entries, total] = await Promise.all([
		db
			.select()
			.from(skillEntries)
			.where(whereClause)
			.orderBy(desc(skillEntries.updatedAt), desc(skillEntries.successCount))
			.limit(Math.min(options?.limit ?? 50, 200))
			.offset(options?.offset ?? 0),
		db.$count(skillEntries, whereClause),
	]);
	return { entries, total };
}

export type ExecutableSkillWorkflowDefinition = Pick<
	SkillEntry,
	| "id"
	| "tediId"
	| "title"
	| "slug"
	| "description"
	| "revision"
	| "lifecycleState"
	| "updatedAt"
>;

/**
 * List only skills that own the canonical executable workflow source.
 *
 * Keep this predicate in SQL: filtering a generic skill page in the API would
 * make dynamic-workflow totals and pagination incorrect for large tenants.
 */
export async function listExecutableSkillWorkflowsForOrg(
	db: DbClient,
	orgId: string,
	options?: {
		lifecycleState?: SkillLifecycleState;
		limit?: number;
		offset?: number;
		query?: string;
	},
): Promise<{
	entries: ExecutableSkillWorkflowDefinition[];
	total: number;
}> {
	const conditions: SQL[] = [
		eq(skillEntries.organizationId, orgId),
		sql`json_type(${skillEntries.files}, '$."scripts/workflow.ts"') = 'text'`,
	];
	if (options?.lifecycleState) {
		conditions.push(eq(skillEntries.lifecycleState, options.lifecycleState));
	}
	const query = options?.query?.trim().toLowerCase();
	if (query) {
		const pattern = `%${escapeLikePattern(query)}%`;
		conditions.push(sql`(
			lower(${skillEntries.title}) LIKE ${pattern} ESCAPE '\\'
			OR lower(coalesce(${skillEntries.slug}, '')) LIKE ${pattern} ESCAPE '\\'
			OR lower(coalesce(${skillEntries.description}, '')) LIKE ${pattern} ESCAPE '\\'
		)`);
	}
	const whereClause = and(...conditions);
	const [entries, total] = await Promise.all([
		db
			.select({
				id: skillEntries.id,
				tediId: skillEntries.tediId,
				title: skillEntries.title,
				slug: skillEntries.slug,
				description: skillEntries.description,
				revision: skillEntries.revision,
				lifecycleState: skillEntries.lifecycleState,
				updatedAt: skillEntries.updatedAt,
			})
			.from(skillEntries)
			.where(whereClause)
			.orderBy(desc(skillEntries.updatedAt), desc(skillEntries.revision))
			.limit(Math.min(options?.limit ?? 50, 200))
			.offset(options?.offset ?? 0),
		db.$count(skillEntries, whereClause),
	]);
	return { entries, total };
}

function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

export async function listSkillPromotionCandidates(
	db: DbClient,
	orgId: string,
	options?: {
		appId?: string;
		lifecycleStates?: SkillLifecycleState[];
		limit?: number;
		minSuccessCount?: number;
		offset?: number;
		tediId?: string;
	},
): Promise<{ entries: SkillEntry[]; total: number }> {
	const lifecycleStates = options?.lifecycleStates?.length
		? options.lifecycleStates
		: (["active", "proven"] satisfies SkillLifecycleState[]);
	const minSuccessCount = Math.max(options?.minSuccessCount ?? 1, 0);
	const conditions = [
		eq(skillEntries.organizationId, orgId),
		isNotNull(skillEntries.tediId),
		// bound-params: subset of the closed SkillLifecycleState enum
		inArray(skillEntries.lifecycleState, lifecycleStates),
		gte(skillEntries.successCount, minSuccessCount),
	];
	if (options?.tediId) {
		conditions.push(eq(skillEntries.tediId, options.tediId));
	}
	if (options?.appId) {
		conditions.push(eq(skillEntries.appId, options.appId));
	}
	const whereClause = and(...conditions);
	const [entries, total] = await Promise.all([
		db
			.select()
			.from(skillEntries)
			.where(whereClause)
			.orderBy(desc(skillEntries.successCount), desc(skillEntries.updatedAt))
			.limit(Math.min(options?.limit ?? 50, 200))
			.offset(options?.offset ?? 0),
		db.$count(skillEntries, whereClause),
	]);
	return { entries, total };
}
