/**
 * MCP Governance Router
 *
 * Internal, service-binding-only surface for the MCP tool-approval grant
 * layer. See `packages/api-contract/src/contracts/mcp-governance.ts` for the
 * "why not a direct D1 query from apps/mcp" rationale.
 */

import { resolveAgentLifecycleAuthorization } from "@tedix/db/queries/mcp-agent-lifecycle";
import { implement } from "@orpc/server";
import { mcpGovernanceContract } from "@tedix/api-contract/contracts/mcp-governance";
import { parseKernelGovernancePolicy } from "@tedix/api-contract/utils/approval-policy";
import {
	isMethodAllowed,
	readPinnedCapabilityManifest,
} from "@tedix/api-contract/utils/skill-manifest";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { resolveSkillMcpNamespaceSlugs } from "@tedix/db/queries/cognitive/skill-mcp-bindings";
import { getPolicyPackById } from "@tedix/db/queries/control-plane/definitions";
import { getActivePolicyPackDefinition } from "@tedix/db/queries/kernel-runtime-support";
import {
	resolveToolApprovalGrant,
	resolveWorkItemAuthorization,
} from "@tedix/db/queries/mcp-governance";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { readDelegationAutonomyLessons } from "@tedix/db/queries/work-items/delegation-autonomy";
import { type BaseContext, withServiceAuth } from "../orpc";

const mcpGovernanceOs = implement(
	mcpGovernanceContract,
).$context<BaseContext>();
const serviceOs = mcpGovernanceOs.use(withServiceAuth);

export const mcpGovernanceContractRouter = mcpGovernanceOs.router({
	resolveSkillManifestAuthorization:
		serviceOs.resolveSkillManifestAuthorization.handler(
			async ({ input, context }) => {
				const environment =
					context.env.ENVIRONMENT === "development"
						? "development"
						: "production";
				const run = await getSkillRun(
					context.db,
					input.runId,
					input.organizationId,
					environment,
				);
				if (
					!run ||
					run.skillId !== input.skillId ||
					run.tediId !== input.tediId ||
					run.executionEpoch !== input.executionEpoch ||
					run.workflowRetiredAt ||
					!["queued", "running"].includes(run.status) ||
					!run.skillRevision
				)
					return { approved: false };
				const skill = await getSkillEntry(
					context.db,
					input.skillId,
					input.organizationId,
				);
				if (
					!skill ||
					!["active", "proven", "crystallized"].includes(
						skill.lifecycleState ?? "",
					)
				)
					return { approved: false };
				const manifest = readPinnedCapabilityManifest(run.capabilityManifest);
				if (!manifest) return { approved: false };
				const namespaces = Object.keys(manifest.mcp ?? {});
				const { namespaceToSlug } = await resolveSkillMcpNamespaceSlugs(
					context.db,
					{
						organizationId: input.organizationId,
						skillId: input.skillId,
						namespaces,
					},
				);
				const declared = namespaces.some((namespace) => {
					if (!isMethodAllowed(manifest, namespace, input.method)) return false;
					// The target comes from the gateway's resolved tool, never call arguments.
					if (input.targetTediId)
						return input.targetTediId === run.tediId && namespace === "tedi";
					if (namespace === "tedi") return false;
					if (namespaceToSlug[namespace])
						return namespaceToSlug[namespace] === input.sourceAppSlug;
					return namespace === input.namespace;
				});
				return declared
					? { approved: true, skillId: skill.id, revision: run.skillRevision }
					: { approved: false };
			},
		),
	resolveAgentLifecycleAuthorization:
		serviceOs.resolveAgentLifecycleAuthorization.handler(
			async ({ input, context }) => ({
				approved: await resolveAgentLifecycleAuthorization(context.db, input),
			}),
		),
	resolveAgentTransportPolicy: serviceOs.resolveAgentTransportPolicy.handler(
		async ({ input, context }) => {
			const tedi = input.tediId
				? await getTediByIdForOrganization(
						context.db,
						input.tediId,
						input.organizationId,
					)
				: null;
			if (input.tediId && !tedi)
				return { requireExplicitApprovalPolicy: false };
			const organizationPolicy = await getActivePolicyPackDefinition(
				context.db,
				input.organizationId,
			);
			const autonomy = parseKernelGovernancePolicy(
				organizationPolicy?.governancePolicy,
			).autonomy;
			if (autonomy)
				autonomy.askForClasses = [
					...(autonomy.askForClasses ?? []),
					...(await readDelegationAutonomyLessons(
						context.db,
						input.organizationId,
					)),
				];
			if (!tedi?.policyPackId) {
				return {
					requireExplicitApprovalPolicy: false,
					...(autonomy ? { autonomy } : {}),
				};
			}
			const policyPack = await getPolicyPackById(context.db, tedi.policyPackId);
			if (
				!policyPack ||
				policyPack.status !== "active" ||
				(policyPack.organizationId !== null &&
					policyPack.organizationId !== input.organizationId)
			) {
				return {
					requireExplicitApprovalPolicy: false,
					...(autonomy ? { autonomy } : {}),
				};
			}
			const governance = parseKernelGovernancePolicy(
				policyPack.definition?.governancePolicy,
			);
			return {
				...(autonomy ? { autonomy } : {}),
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
