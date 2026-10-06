import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	type NewOsApprovalRuleRow,
	type OsApprovalRuleRow,
	osApprovalRules,
} from "../schema/os-approval-rules";
import { getAffectedRows } from "../utils/d1-result";

export interface OsApprovalRuleScopeParams {
	organizationId: string;
	ruleId: string;
}

export interface ListOsApprovalRulesOptions {
	limit?: number;
}

/** Keep `IN (...)` well under the 100-bound-parameter D1 cap. */
const KIND_CHUNK_SIZE = 50;

export async function createOsApprovalRule(
	db: DbQueryClient,
	rule: NewOsApprovalRuleRow,
): Promise<OsApprovalRuleRow> {
	const [row] = await db.insert(osApprovalRules).values(rule).returning();
	if (!row) {
		throw new Error("OS approval rule insert returned no row");
	}
	return row;
}

export async function listOsApprovalRules(
	db: DbQueryClient,
	organizationId: string,
	options: ListOsApprovalRulesOptions = {},
): Promise<OsApprovalRuleRow[]> {
	return db
		.select()
		.from(osApprovalRules)
		.where(eq(osApprovalRules.organizationId, organizationId))
		.orderBy(desc(osApprovalRules.createdAt), desc(osApprovalRules.id))
		.limit(Math.min(Math.max(options.limit ?? 200, 1), 500));
}

export async function getOsApprovalRule(
	db: DbQueryClient,
	params: OsApprovalRuleScopeParams,
): Promise<OsApprovalRuleRow | undefined> {
	const [row] = await db
		.select()
		.from(osApprovalRules)
		.where(
			and(
				eq(osApprovalRules.organizationId, params.organizationId),
				eq(osApprovalRules.id, params.ruleId),
			),
		)
		.limit(1);
	return row;
}

/**
 * Enable or disable a rule inside its organization. Disabling stamps
 * `disabled_at`; re-enabling clears it.
 */
export async function setOsApprovalRuleEnabled(
	db: DbQueryClient,
	params: OsApprovalRuleScopeParams,
	enabled: boolean,
): Promise<OsApprovalRuleRow | undefined> {
	const [row] = await db
		.update(osApprovalRules)
		.set({
			enabled,
			disabledAt: enabled ? null : new Date().toISOString(),
		})
		.where(
			and(
				eq(osApprovalRules.organizationId, params.organizationId),
				eq(osApprovalRules.id, params.ruleId),
			),
		)
		.returning();
	return row;
}

export async function deleteOsApprovalRule(
	db: DbQueryClient,
	params: OsApprovalRuleScopeParams,
): Promise<boolean> {
	const result = await db
		.delete(osApprovalRules)
		.where(
			and(
				eq(osApprovalRules.organizationId, params.organizationId),
				eq(osApprovalRules.id, params.ruleId),
			),
		);
	return getAffectedRows(result) > 0;
}

/**
 * The enabled rules matching any of the given action kinds — the sweep's
 * match set. Kinds are deduplicated and chunked to stay under the D1
 * bound-parameter cap.
 */
export async function findEnabledOsApprovalRulesByKind(
	db: DbQueryClient,
	organizationId: string,
	kinds: readonly string[],
): Promise<OsApprovalRuleRow[]> {
	const unique = [...new Set(kinds)];
	if (unique.length === 0) return [];
	const rows: OsApprovalRuleRow[] = [];
	for (let start = 0; start < unique.length; start += KIND_CHUNK_SIZE) {
		const chunk = unique.slice(start, start + KIND_CHUNK_SIZE);
		rows.push(
			...(await db
				.select()
				.from(osApprovalRules)
				.where(
					and(
						eq(osApprovalRules.organizationId, organizationId),
						eq(osApprovalRules.enabled, true),
						inArray(osApprovalRules.actionKind, chunk),
					),
				)
				.orderBy(desc(osApprovalRules.createdAt), desc(osApprovalRules.id))),
		);
	}
	return rows;
}
