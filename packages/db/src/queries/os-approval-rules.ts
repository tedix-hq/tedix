import { and, desc, eq, isNull } from "drizzle-orm";
import { coreTable } from "../core-store/client";
import { anyIds, changedRows } from "../core-store/dialect";
import type { DbQueryClient } from "../query-client";
import {
	type NewOsApprovalRuleRow,
	type OsApprovalRuleRow,
	osApprovalRules as d1OsApprovalRules,
} from "../schema/os-approval-rules";

export interface OsApprovalRuleScopeParams {
	organizationId: string;
	ruleId: string;
}

export interface ListOsApprovalRulesOptions {
	limit?: number;
}

export async function createOsApprovalRule(
	db: DbQueryClient,
	rule: NewOsApprovalRuleRow,
): Promise<OsApprovalRuleRow> {
	const osApprovalRules = coreTable(db, d1OsApprovalRules);
	const [row] = await db.insert(osApprovalRules).values(rule).returning();
	if (!row) {
		throw new Error("OS approval rule insert returned no row");
	}
	return row;
}

/** Reuse only the same scope; a broad kind rule cannot mask a tool rule. */
export async function findEnabledOsApprovalRuleByScope(
	db: DbQueryClient,
	organizationId: string,
	scope: { actionKind: string; toolSlug?: string; verb?: string },
): Promise<OsApprovalRuleRow | undefined> {
	const osApprovalRules = coreTable(db, d1OsApprovalRules);
	const [row] = await db
		.select()
		.from(osApprovalRules)
		.where(
			and(
				eq(osApprovalRules.organizationId, organizationId),
				eq(osApprovalRules.enabled, true),
				eq(osApprovalRules.actionKind, scope.actionKind),
				scope.toolSlug == null
					? isNull(osApprovalRules.toolSlug)
					: eq(osApprovalRules.toolSlug, scope.toolSlug),
				scope.verb == null
					? isNull(osApprovalRules.verb)
					: eq(osApprovalRules.verb, scope.verb),
			),
		)
		.orderBy(desc(osApprovalRules.createdAt), desc(osApprovalRules.id))
		.limit(1);
	return row;
}

export async function listOsApprovalRules(
	db: DbQueryClient,
	organizationId: string,
	options: ListOsApprovalRulesOptions = {},
): Promise<OsApprovalRuleRow[]> {
	const osApprovalRules = coreTable(db, d1OsApprovalRules);
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
	const osApprovalRules = coreTable(db, d1OsApprovalRules);
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
	const osApprovalRules = coreTable(db, d1OsApprovalRules);
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
	const osApprovalRules = coreTable(db, d1OsApprovalRules);
	const result = await db
		.delete(osApprovalRules)
		.where(
			and(
				eq(osApprovalRules.organizationId, params.organizationId),
				eq(osApprovalRules.id, params.ruleId),
			),
		)
		.returning({ id: osApprovalRules.id });
	return changedRows(result) > 0;
}

/**
 * The enabled rules matching any of the given action kinds — the sweep's
 * match set. One bound set keeps both stores under their parameter limits.
 */
export async function findEnabledOsApprovalRulesByKind(
	db: DbQueryClient,
	organizationId: string,
	kinds: readonly string[],
): Promise<OsApprovalRuleRow[]> {
	const osApprovalRules = coreTable(db, d1OsApprovalRules);
	const unique = [...new Set(kinds)];
	if (unique.length === 0) return [];
	return db
		.select()
		.from(osApprovalRules)
		.where(
			and(
				eq(osApprovalRules.organizationId, organizationId),
				eq(osApprovalRules.enabled, true),
				anyIds(db, osApprovalRules.actionKind, unique),
			),
		)
		.orderBy(desc(osApprovalRules.createdAt), desc(osApprovalRules.id));
}
