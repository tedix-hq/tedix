/**
 * MCP Governance Router
 *
 * Internal, service-binding-only surface for the MCP tool-approval grant
 * layer. See `packages/api-contract/src/contracts/mcp-governance.ts` for the
 * "why not a direct D1 query from apps/mcp" rationale.
 */

import { implement } from "@orpc/server";
import { mcpGovernanceContract } from "@tedix/api-contract/contracts/mcp-governance";
import { parseKernelGovernancePolicy } from "@tedix/api-contract/utils/approval-policy";
import { getPolicyPackById } from "@tedix/db/queries/control-plane/definitions";
import {
	resolveToolApprovalGrant,
	resolveWorkItemAuthorization,
} from "@tedix/db/queries/mcp-governance";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { type BaseContext, withServiceAuth } from "../orpc";

const mcpGovernanceOs = implement(
	mcpGovernanceContract,
).$context<BaseContext>();
const serviceOs = mcpGovernanceOs.use(withServiceAuth);

export const mcpGovernanceContractRouter = mcpGovernanceOs.router({
	resolveAgentTransportPolicy: serviceOs.resolveAgentTransportPolicy.handler(
		async ({ input, context }) => {
			const tedi = await getTediByIdForOrganization(
				context.db,
				input.tediId,
				input.organizationId,
			);
			if (!tedi?.policyPackId) {
				return { requireExplicitApprovalPolicy: false };
			}
			const policyPack = await getPolicyPackById(context.db, tedi.policyPackId);
			if (
				!policyPack ||
				policyPack.status !== "active" ||
				(policyPack.organizationId !== null &&
					policyPack.organizationId !== input.organizationId)
			) {
				return { requireExplicitApprovalPolicy: false };
			}
			const governance = parseKernelGovernancePolicy(
				policyPack.definition?.governancePolicy,
			);
			return {
				requireExplicitApprovalPolicy:
					governance.requireExplicitThirdPartyApprovalPolicy === true,
			};
		},
	),
	resolveToolApprovalGrant: serviceOs.resolveToolApprovalGrant.handler(
		async ({ input, context }) => {
			const result = await resolveToolApprovalGrant(context.db, {
				organizationId: input.organizationId,
				subjectId: input.subjectId,
				appSlug: input.appSlug,
				toolId: input.toolId,
				grantKind: input.grantKind,
			});
			return result;
		},
	),
	resolveWorkItemAuthorization: serviceOs.resolveWorkItemAuthorization.handler(
		async ({ input, context }) => {
			return resolveWorkItemAuthorization(context.db, {
				...input,
				authorizationSigningSecret: context.env.SECRETS_MASTER_KEY,
			});
		},
	),
});
