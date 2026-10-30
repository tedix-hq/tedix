import { getInternalApiClient } from "@tedix/api-client/internal";
import { hasScope } from "@tedix/mcp-shared/auth/scopes";
import { probeReviewedProviderIdentity } from "./tenant-profile-probe";
import {
	prepareTenantIdentityProfileMount,
	resolveFreshPolicyMount,
	tenantPolicyCrossMountDigest,
	tenantPolicyDescriptorDigest,
	tenantPolicyEffectiveToolDigest,
} from "./tenant-policy-mount";
import type { AppTool, ServerContext } from "./server-context";

/** Recover a policy-bound owner replay only from a verified kernel request. */
export async function resolveHumanPolicyReplay(
	agent: ServerContext,
	tool: AppTool,
	args: Record<string, unknown>,
	approvalRequestId: unknown,
) {
	const caller = agent.callerIdentity;
	if (
		caller?.authType !== "service" ||
		caller.kernel !== true ||
		!caller.userId ||
		!caller.organizationId ||
		!hasScope(caller.scopes ?? [], "connections.execute") ||
		typeof approvalRequestId !== "string" ||
		!agent.env.API_SERVICE
	)
		return null;
	const client = getInternalApiClient(
		{ API_SERVICE: agent.env.API_SERVICE },
		{
			organizationId: caller.organizationId,
			headers: {
				"X-Tedix-Kernel": "true",
				"X-Tedix-End-User-Id": caller.userId,
			},
			scopes: ["connections.execute"],
		},
	);
	const inputArgs = JSON.parse(JSON.stringify(args));
	const argsDigest = await tenantPolicyDescriptorDigest(inputArgs);
	const { binding, probeReceiptId } =
		await client.mcpGovernance.prepareOwnerPolicyReplay({
			organizationId: caller.organizationId,
			approvalRequestId,
			args: inputArgs,
		});
	if (
		binding.descriptor.actorUserId !== caller.userId ||
		binding.descriptor.mount.sourceToolRowId !== tool.id
	)
		return null;
	const mountInput = {
		organizationId: caller.organizationId,
		rootAppId: binding.descriptor.mount.rootAppId,
		mountedToolId: binding.descriptor.mount.mountedToolId,
		env: agent.env,
	};
	const snapshot = async () => {
		if ((await tenantPolicyDescriptorDigest(args)) !== argsDigest) return null;
		const [decision, profileResult, reviewed, mount] = await Promise.all([
			client.mcpGovernance.resolveTenantToolPolicy({
				organizationId: caller.organizationId!,
				descriptor: binding.descriptor,
				descriptorDigest: binding.descriptorDigest,
				args: inputArgs,
			}),
			client.mcpGovernance.resolveProviderIdentityProfile({
				organizationId: caller.organizationId!,
				id: binding.descriptor.profileId,
			}),
			resolveFreshPolicyMount(mountInput),
			prepareTenantIdentityProfileMount(mountInput),
		]);
		const profile = profileResult.profile;
		if (
			!decision.matched ||
			decision.revisionId !== binding.revisionId ||
			decision.ruleDigest !== binding.ruleDigest ||
			!profile ||
			profile.profileDigest !== binding.descriptor.profileDigest ||
			!reviewed ||
			reviewed.sourceAppId !== binding.descriptor.mount.sourceAppId ||
			reviewed.tool.id !== tool.id ||
			!mount ||
			mount.descriptorDigest !==
				(await tenantPolicyDescriptorDigest(binding.descriptor.mount))
		)
			return null;
		const actual = await resolveFreshPolicyMount({
			...mountInput,
			rootAppId: agent.appId,
			mountedToolId: tool.toolId,
		});
		if (actual) {
			if (
				actual.sourceAppId !== reviewed.sourceAppId ||
				actual.tool.id !== tool.id ||
				(await tenantPolicyEffectiveToolDigest(actual.tool)) !==
					(await tenantPolicyEffectiveToolDigest(tool))
			)
				return null;
		} else {
			const direct = await client.apps.getByIdWithTools({ appId: agent.appId });
			const row = direct.tools.find(
				(item) => item.id === tool.id && item.toolId === tool.toolId,
			);
			if (
				!direct.app ||
				direct.app.organizationId !== caller.organizationId ||
				!row ||
				(await tenantPolicyEffectiveToolDigest(row as unknown as AppTool)) !==
					(await tenantPolicyEffectiveToolDigest(tool))
			)
				return null;
		}
		if (
			(await tenantPolicyCrossMountDigest(reviewed.tool)) !==
			(await tenantPolicyCrossMountDigest(tool))
		)
			return null;
		const probe = await prepareTenantIdentityProfileMount({
			...mountInput,
			rootAppId: profile.probeMount.rootAppId,
			mountedToolId: profile.probeMount.mountedToolId,
		});
		if (
			!probe ||
			probe.descriptorDigest !==
				(await tenantPolicyDescriptorDigest(profile.probeMount))
		)
			return null;
		return { decision, profile };
	};
	const current = await snapshot();
	if (
		!current ||
		(!current.decision.defaultAsk &&
			current.decision.effect?.disposition !== "ask")
	)
		return null;
	const accountDigest = await probeReviewedProviderIdentity({
		organizationId: caller.organizationId,
		receiptId: probeReceiptId,
		exampleArgs: inputArgs,
		env: agent.env,
	});
	if (
		accountDigest !== binding.descriptor.accountRevisionDigest ||
		!(await snapshot())
	)
		return null;
	return {
		...binding,
		effect: current.decision.effect ?? {
			disposition: "ask" as const,
			riskTier: "high_impact_write" as const,
			blastRadius: "external_system" as const,
		},
		probe: {
			profile: current.profile.profile,
			binding: JSON.stringify([
				caller.organizationId,
				current.profile.id,
				current.profile.profileDigest,
				caller.userId,
			]),
			expectedDigest: accountDigest,
			revalidate: async () => !!(await snapshot()),
		},
	};
}
