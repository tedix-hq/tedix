/**
 * Role Templates Router (reusable role primitive)
 *
 * A config-driven role template provisions the four ingredients a tedi's role
 * is otherwise hand-assembled from — persona (SOUL), standing objectives,
 * app-assignment tags, and capability profile — as one unit.
 *
 * REST Endpoints:
 * POST /role-templates        - Create an org-scoped role template
 * GET  /role-templates        - List org + platform-wide templates
 * POST /role-templates/apply  - Apply a template onto an existing tedi
 *
 * `apply` reuses the canonical writers (updateTedi + createObjective) via the
 * `applyRoleTemplate` query. It does NOT run managed app-assignment reconcile —
 * setting `tedis.tags` is the trigger, and reconcile runs separately.
 */

import { implement } from "@orpc/server";
import { roleTemplatesContract } from "@tedix/api-contract/contracts/role-templates";
import {
	applyRoleTemplate,
	createRoleTemplate,
	getRoleTemplateByKey,
	listRoleTemplates,
	RoleTemplateError,
} from "@tedix/db/queries/role-templates";
import { toJsonRecord } from "@tedix/db/utils/json";
import { requireOrgIdOrInput } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	skipOutputValidation,
	withAuth,
} from "../orpc";
import { hasEarnedDelegationGovernanceAuthority } from "./earned-delegation-access";

const roleTemplatesOs = implement(
	roleTemplatesContract,
).$context<BaseContext>();
const authOs = roleTemplatesOs.use(withAuth);

/** Map a typed `RoleTemplateError` from the query layer onto an oRPC error. */
function rethrowRoleTemplateError(error: unknown): never {
	if (error instanceof RoleTemplateError) {
		if (error.reason === "tedi_out_of_scope") {
			throw createError(ErrorCodes.FORBIDDEN, error.message);
		}
		if (error.reason === "template_not_found") {
			throw createError(ErrorCodes.NOT_FOUND, error.message);
		}
		throw createError(ErrorCodes.BAD_REQUEST, error.message);
	}
	throw error;
}

const createProcedure = authOs.create
	.use(AUTHZ.delegationGovern)
	.handler(async ({ input, context }) => {
		if (!hasEarnedDelegationGovernanceAuthority(context)) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Creating a role template requires earned-delegation governance authority",
			);
		}
		const orgId = requireOrgIdOrInput(context, input.organizationId);

		const existing = await getRoleTemplateByKey(context.db, {
			key: input.key,
			orgId,
		});
		if (existing) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Role template "${input.key}" already exists in this organization`,
			);
		}

		return createRoleTemplate(context.db, {
			orgId,
			key: input.key,
			name: input.name,
			description: input.description,
			persona: input.persona,
			standingObjectives: input.standingObjectives,
			tags: input.tags,
			capabilityProfile: input.capabilityProfile,
			cronTemplateNames: input.cronTemplateNames,
			metadata:
				input.metadata === undefined ? undefined : toJsonRecord(input.metadata),
			createdAt: new Date().toISOString(),
		});
	});

const listProcedure = authOs.list
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgIdOrInput(context, input?.organizationId);
		const limit = input?.limit ?? 50;
		const offset = input?.offset ?? 0;
		const { data, total } = await listRoleTemplates(context.db, {
			orgId,
			includeArchived: input?.includeArchived,
			limit,
			offset,
		});
		return {
			data,
			pagination: { limit, offset, total, hasMore: offset + limit < total },
		};
	});

const applyProcedure = authOs.apply
	.use(AUTHZ.delegationGovern)
	.handler(async ({ input, context }) => {
		if (!hasEarnedDelegationGovernanceAuthority(context)) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Applying a role template requires earned-delegation governance authority",
			);
		}
		const orgId = requireOrgIdOrInput(context, input.organizationId);
		try {
			return await applyRoleTemplate(context.db, {
				tediId: input.tediId,
				templateKey: input.templateKey,
				orgId,
			});
		} catch (error) {
			rethrowRoleTemplateError(error);
		}
	});

export const roleTemplatesContractRouter = roleTemplatesOs.router({
	create: createProcedure,
	list: skipOutputValidation(listProcedure),
	apply: applyProcedure,
});
