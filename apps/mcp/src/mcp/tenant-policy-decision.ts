import { getApiClient } from "../lib/api-client";
import { SelectedConnectionCredentialSchema } from "@tedix/api-contract/schemas/connections";
import { resolveMultiOrgToolTarget } from "./multi-org-tool-target";
import { matchesTenantPolicyCredential } from "./tenant-policy-credential";
import {
	prepareTenantPolicyMount,
	tenantPolicyDescriptorDigest,
	tenantPolicyMountDescriptor,
} from "./tenant-policy-mount";
import type { AppTool, ServerContext } from "./server-context";

/**
 * Re-resolve the trusted mount and compare it to the tool about to execute.
 * No caller metadata or stale catalog projection can supply this decision.
 */
export async function resolveTenantPolicyForCall(
	agent: ServerContext,
	tool: AppTool,
	args: Record<string, unknown>,
	selectedCredential: unknown,
) {
	try {
		const selected =
			SelectedConnectionCredentialSchema.safeParse(selectedCredential);
		if (!selected.success || !selected.data.accountRevisionDigest) return null;
		const target = resolveMultiOrgToolTarget(agent, tool);
		if (!target || !agent.env.API_SERVICE) return null;
		const client = getApiClient({
			serviceFetch: agent.env.API_SERVICE,
			orgId: target.organizationId,
		});
		const gateway = await client.apps.getBySlugWithTools({
			slug: target.gatewaySlug,
		});
		if (!gateway.app || gateway.app.organizationId !== target.organizationId)
			return null;
		const fresh = await prepareTenantPolicyMount({
			organizationId: target.organizationId,
			rootAppId: gateway.app.id,
			mountedToolId: tool.toolId,
			env: agent.env,
		});
		if (!fresh) return null;
		const sourceAppId = tool.config?._sourceAppId;
		if (typeof sourceAppId !== "string") return null;
		const actual = await tenantPolicyMountDescriptor({
			organizationId: target.organizationId,
			rootAppId: gateway.app.id,
			sourceAppId,
			sourceToolId: fresh.descriptor.sourceToolId,
			mountAppIds: fresh.descriptor.mountAppIds,
			tool,
		});
		if (
			!actual ||
			(await tenantPolicyDescriptorDigest(actual)) !== fresh.descriptorDigest
		)
			return null;
		const expectedCredential = {
			organizationId: actual.organizationId,
			providerId: actual.providerId,
			scope: "tenant" as const,
			connectionInstanceId: actual.connectionInstanceId,
		};
		if (
			!matchesTenantPolicyCredential(
				expectedCredential,
				selected.data,
				selected.data.accountRevisionDigest,
			)
		)
			return null;
		const descriptor = {
			...fresh.descriptor,
			accountRevisionDigest: selected.data.accountRevisionDigest,
		};
		const descriptorDigest = await tenantPolicyDescriptorDigest(descriptor);
		const result = await client.mcpGovernance.resolveTenantToolPolicy({
			organizationId: target.organizationId,
			descriptor,
			descriptorDigest,
			args: JSON.parse(JSON.stringify(args)),
		});
		return result.matched &&
			result.revisionId &&
			result.ruleDigest &&
			result.effect
			? {
					...result,
					revisionId: result.revisionId,
					ruleDigest: result.ruleDigest,
					effect: result.effect,
					descriptorDigest,
				}
			: null;
	} catch {
		return null;
	}
}
