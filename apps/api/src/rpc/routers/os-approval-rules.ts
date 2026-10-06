/**
 * oRPC Tedix OS Auto-Approval Rules Router
 *
 * Per-organization rules that auto-resolve pending tedi approval requests
 * matching an action kind. Nothing runs in the background: the explicit,
 * idempotent `apply` sweep is the only application path, it resolves each
 * matching approval through the SAME canonical resolution procedure a human
 * `tediApprovals.resolve` call uses (audit event, Home tool-write settlement,
 * learning signal included), and every auto-resolution records the rule id in
 * its resolution note.
 */

import { call, implement, ORPCError } from "@orpc/server";
import { osApprovalRulesContract } from "@tedix/api-contract/contracts/os-approval-rules";
import type {
	OsApprovalRule,
	OsApprovalRuleMatch,
} from "@tedix/api-contract/contracts/os-approval-rules";
import { listApprovalRequests } from "@tedix/db/queries/approvals";
import {
	createOsApprovalRule,
	deleteOsApprovalRule,
	findEnabledOsApprovalRulesByKind,
	getOsApprovalRule,
	listOsApprovalRules,
	setOsApprovalRuleEnabled,
} from "@tedix/db/queries/os-approval-rules";
import { createDbQueryClient } from "@tedix/db/query-client";
import type { OsApprovalRuleRow } from "@tedix/db/schema/os-approval-rules";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";
import { OS_APPROVAL_RULES_AUDIT, osAudit } from "../os-audit";
import { resolveCreator } from "./os-workspaces-shared";

const rulesOs = implement(osApprovalRulesContract).$context<BaseContext>();
const authed = rulesOs.use(withAuth).use(osAudit(OS_APPROVAL_RULES_AUDIT));
// Reading rules mirrors reading the approval queue (`tediApprovals.list`,
// human plane tedis:read) and additionally admits the Tedix OS read verb;
// mutating rules and sweeping mirror `tediApprovals.resolve` — the sweep MUST
// carry the exact resolve guard, because it invokes that procedure per match.
// Both now share the interned `AUTHZ.osApprove` middleware, which keeps the
// approval domain's mcp:memory.admin machine plane and accepts os:approve or
// settings:manage on the human plane.
const readRules = authed.use(
	withAuthorization(
		{ anyOf: ["os:read", "tedis:read", "settings:manage"] },
		"mcp:memory.read",
	),
);
const manageRules = authed.use(AUTHZ.osApprove);
const adminRules = authed.use(AUTHZ.osAdmin);

/** How many pending approvals one sweep considers. */
const APPLY_SWEEP_LIMIT = 200;

function queryDb(context: BaseContext) {
	return createDbQueryClient(context.env.DB);
}

function mapRule(row: OsApprovalRuleRow): OsApprovalRule {
	return {
		id: row.id,
		organizationId: row.organizationId,
		actionKind: row.actionKind,
		decision: row.decision,
		enabled: row.enabled,
		createdByKind: row.createdByKind,
		createdById: row.createdById,
		createdAt: row.createdAt,
		disabledAt: row.disabledAt,
	};
}

const createProcedure = manageRules.create.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const db = queryDb(context);
		// Idempotent per kind: repeated "Always approve <kind>" clicks return the
		// standing rule instead of accumulating duplicates.
		const [existing] = await findEnabledOsApprovalRulesByKind(
			db,
			organizationId,
			[input.actionKind],
		);
		if (existing) {
			return { rule: mapRule(existing) };
		}
		const creator = resolveCreator(context);
		const row = await createOsApprovalRule(db, {
			id: crypto.randomUUID(),
			organizationId,
			actionKind: input.actionKind,
			decision: "approve",
			enabled: true,
			createdByKind: creator.kind,
			createdById: creator.id,
			createdAt: new Date().toISOString(),
		});
		return { rule: mapRule(row) };
	},
);

const listProcedure = readRules.list.handler(async ({ context }) => {
	const organizationId = requireOrgId(context);
	const rows = await listOsApprovalRules(queryDb(context), organizationId);
	return { items: rows.map(mapRule) };
});

const setEnabledProcedure = manageRules.setEnabled.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const row = await setOsApprovalRuleEnabled(
			queryDb(context),
			{ organizationId, ruleId: input.ruleId },
			input.enabled,
		);
		if (!row) {
			throw createError(ErrorCodes.NOT_FOUND, "Approval rule not found");
		}
		return { rule: mapRule(row) };
	},
);

const deleteProcedure = adminRules.delete.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const row = await getOsApprovalRule(queryDb(context), {
			organizationId,
			ruleId: input.ruleId,
		});
		if (!row)
			throw createError(ErrorCodes.NOT_FOUND, "Approval rule not found");
		if (row.enabled) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Disable the approval rule before permanently deleting it",
			);
		}
		const removed = await deleteOsApprovalRule(queryDb(context), {
			organizationId,
			ruleId: row.id,
		});
		if (!removed)
			throw createError(ErrorCodes.NOT_FOUND, "Approval rule not found");
		return { deleted: true as const };
	},
);

const applyProcedure = manageRules.apply.handler(async ({ context }) => {
	const organizationId = requireOrgId(context);

	const pending = await listApprovalRequests(context.db, {
		orgId: organizationId,
		status: "pending",
		limit: APPLY_SWEEP_LIMIT,
	});
	if (pending.data.length === 0) {
		return { resolved: 0, ruleMatches: [] };
	}

	const rules = await findEnabledOsApprovalRulesByKind(
		queryDb(context),
		organizationId,
		pending.data.map((approval) => approval.actionType),
	);
	if (rules.length === 0) {
		return { resolved: 0, ruleMatches: [] };
	}
	// One deciding rule per kind: the newest enabled rule wins (the query
	// returns newest first), so the recorded rule id is deterministic.
	const ruleByKind = new Map<string, OsApprovalRuleRow>();
	for (const rule of rules) {
		if (!ruleByKind.has(rule.actionKind)) {
			ruleByKind.set(rule.actionKind, rule);
		}
	}

	// The canonical resolution procedure. Imported dynamically so the
	// approvalRules namespace does not eagerly evaluate the tedi-approvals →
	// kernel-runtime graph on requests that never sweep.
	const { tediApprovalsContractRouter } = await import("./tedi-approvals");

	const ruleMatches: OsApprovalRuleMatch[] = [];
	for (const approval of pending.data) {
		const rule = ruleByKind.get(approval.actionType);
		if (!rule) continue;
		try {
			// The SAME resolution path a human resolve uses — pending→resolved CAS,
			// audit event, Home tool-write settlement, learning signal — never a
			// parallel write. Its middleware runs against this caller's context,
			// which the `manageRules` guard above already proved sufficient.
			await call(
				tediApprovalsContractRouter.resolve,
				{
					id: approval.id,
					status: "approved",
					resolution: `auto-approved by rule ${rule.id}`,
				},
				{ context },
			);
		} catch (error) {
			// Idempotency: an approval that resolved or expired between the listing
			// and this call fails the canonical path's pending/TTL checks as
			// BAD_REQUEST — skip it cleanly instead of failing the sweep.
			if (error instanceof ORPCError && error.code === "BAD_REQUEST") {
				continue;
			}
			throw error;
		}
		ruleMatches.push({ approvalId: approval.id, ruleId: rule.id });
	}

	return { resolved: ruleMatches.length, ruleMatches };
});

export const osApprovalRulesContractRouter = rulesOs.router({
	create: createProcedure,
	list: listProcedure,
	setEnabled: setEnabledProcedure,
	delete: deleteProcedure,
	apply: applyProcedure,
});

export type OsApprovalRulesContractRouter =
	typeof osApprovalRulesContractRouter;
