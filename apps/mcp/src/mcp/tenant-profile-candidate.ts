import { hasScope } from "@tedix/mcp-shared/auth/scopes";
import {
	humanReservedActionClasses,
	isPlatformCriticalActionType,
} from "@tedix/api-contract/utils/approval-policy";
import { ToolActionTypeSchema } from "@tedix/api-contract/schemas/tools";
import { getApiClient } from "../lib/api-client";
import { getInternalApiClient } from "@tedix/api-client/internal";
import { resolveFreshExternalAgentAihAuthority } from "../auth-helpers";
import { resolveMultiOrgToolTarget } from "./multi-org-tool-target";
import { resolveToolRiskPolicy } from "./tool-risk-policy";
import {
	prepareTenantIdentityProfileMount,
	resolveFreshPolicyMount,
	tenantPolicyCrossMountDigest,
	tenantPolicyDescriptorDigest,
	tenantPolicyEffectiveToolDigest,
} from "./tenant-policy-mount";
import type { AppTool, ServerContext } from "./server-context";

/** Discovery is a possibility only; every invocation still evaluates arguments. */
export async function tenantProfileDiscoveryPotential(
	agent: ServerContext,
	tool: AppTool,
): Promise<boolean> {
	try {
		const caller = agent.callerIdentity;
		const risk = resolveToolRiskPolicy(tool)?.riskTier;
		if (risk === "high_impact_write" || risk === "external_side_effect")
			return false;
		if (
			tool.config?.transport === "mcp" &&
			caller?.authType === "external_agent" &&
			caller.organizationId &&
			caller.externalAgentPrincipalId &&
			caller.externalAgentSessionId &&
			caller.externalAgentClientRecordId &&
			caller.clientId &&
			caller.externalAgentMcpServerId &&
			agent.env.API_SERVICE
		) {
			const identity = {
				organizationId: caller.organizationId,
				principalId: caller.externalAgentPrincipalId,
				sessionId: caller.externalAgentSessionId,
				clientRecordId: caller.externalAgentClientRecordId,
				clientId: caller.clientId,
				mcpServerId: caller.externalAgentMcpServerId,
			};
			const [authority, fresh] = await Promise.all([
				resolveFreshExternalAgentAihAuthority(agent.env, identity),
				resolveFreshPolicyMount({
					organizationId: identity.organizationId,
					rootAppId: agent.appId,
					mountedToolId: tool.toolId,
					env: agent.env,
				}),
			]);
			if (
				!authority ||
				!hasScope(authority.scopes, "connections.execute") ||
				!fresh ||
				fresh.tool.id !== tool.id ||
				(await tenantPolicyEffectiveToolDigest(tool)) !==
					(await tenantPolicyEffectiveToolDigest(fresh.tool))
			)
				return false;
			const client = getInternalApiClient(
				{ API_SERVICE: agent.env.API_SERVICE },
				{
					organizationId: identity.organizationId,
					externalAgent: {
						principalId: identity.principalId,
						sessionId: identity.sessionId,
						clientRecordId: identity.clientRecordId,
					},
					scopes: authority.scopes,
				},
			);
			return (
				await client.mcpGovernance.resolveMachinePolicyDiscovery({
					organizationId: identity.organizationId,
					rootAppId: agent.appId,
					sourceAppId: fresh.sourceAppId,
					sourceToolRowId: fresh.tool.id,
				})
			).potential;
		}
		if (
			tool.config?.transport !== "mcp" ||
			caller?.authType !== "oauth" ||
			!caller.userId ||
			!hasScope(caller.scopes ?? [], "connections.execute") ||
			!agent.env.API_SERVICE
		)
			return false;
		const selected = resolveMultiOrgToolTarget(agent, tool);
		if (!selected) return false;
		const client = getApiClient({
			serviceFetch: agent.env.API_SERVICE,
			orgId: selected.organizationId,
		});
		const gateway = await client.apps.getBySlugWithTools({
			slug: selected.gatewaySlug,
		});
		if (!gateway.app || gateway.app.organizationId !== selected.organizationId)
			return false;
		const result = await client.mcpGovernance.resolveTenantPolicyDiscovery({
			organizationId: selected.organizationId,
			rootAppId: gateway.app.id,
			mountedToolId: tool.toolId,
			actorUserId: caller.userId,
		});
		return result.potential;
	} catch {
		return false;
	}
}

export async function resolveMachineCandidate(
	agent: ServerContext,
	tool: AppTool,
	args: Record<string, unknown>,
) {
	const caller = agent.callerIdentity;
	if (
		caller?.authType !== "external_agent" ||
		!caller.organizationId ||
		!caller.externalAgentPrincipalId ||
		!caller.externalAgentSessionId ||
		!caller.externalAgentClientRecordId ||
		!caller.clientId ||
		!caller.externalAgentMcpServerId ||
		!agent.env.API_SERVICE
	)
		return null;
	const identity = {
		organizationId: caller.organizationId,
		principalId: caller.externalAgentPrincipalId,
		sessionId: caller.externalAgentSessionId,
		clientRecordId: caller.externalAgentClientRecordId,
		clientId: caller.clientId,
		mcpServerId: caller.externalAgentMcpServerId,
	};
	const mountInput = {
		organizationId: identity.organizationId,
		rootAppId: agent.appId,
		mountedToolId: tool.toolId,
		env: agent.env,
	};
	const inputArgs = JSON.parse(JSON.stringify(args));
	const argsDigest = await tenantPolicyDescriptorDigest(inputArgs);
	const snapshot = async () => {
		if ((await tenantPolicyDescriptorDigest(args)) !== argsDigest) return null;
		const [authority, fresh] = await Promise.all([
			resolveFreshExternalAgentAihAuthority(agent.env, identity),
			resolveFreshPolicyMount(mountInput),
		]);
		if (
			!authority ||
			!hasScope(authority.scopes, "connections.execute") ||
			(fresh &&
				(fresh.tool.id !== tool.id ||
					(await tenantPolicyEffectiveToolDigest(tool)) !==
						(await tenantPolicyEffectiveToolDigest(fresh.tool))))
		)
			return null;
		const client = getInternalApiClient(
			{ API_SERVICE: agent.env.API_SERVICE },
			{
				organizationId: identity.organizationId,
				externalAgent: {
					principalId: identity.principalId,
					sessionId: identity.sessionId,
					clientRecordId: identity.clientRecordId,
				},
				scopes: authority.scopes,
			},
		);
		const source = fresh
			? null
			: await client.apps.getByIdWithTools({ appId: agent.appId });
		const directRow = source?.tools.find(
			(row) => row.id === tool.id && row.toolId === tool.toolId,
		);
		if (
			!fresh &&
			(!source?.app ||
				source.app.organizationId !== identity.organizationId ||
				!directRow ||
				(await tenantPolicyEffectiveToolDigest(
					directRow as unknown as AppTool,
				)) !== (await tenantPolicyEffectiveToolDigest(tool)))
		)
			return null;
		const { candidate } = fresh
			? await client.mcpGovernance.resolveMachinePolicyCandidate({
					organizationId: identity.organizationId,
					rootAppId: agent.appId,
					sourceAppId: fresh.sourceAppId,
					sourceToolRowId: fresh.tool.id,
					args: inputArgs,
				})
			: await client.mcpGovernance.resolveMachinePolicyAnyRoot({
					organizationId: identity.organizationId,
					sourceAppId: agent.appId,
					sourceToolRowId: tool.id,
					args: inputArgs,
				});
		if (
			!candidate ||
			candidate.descriptor.subject.principalId !== identity.principalId ||
			candidate.descriptor.subject.mcpServerId !== identity.mcpServerId
		)
			return null;
		const subject = candidate.descriptor.subject;
		if (
			subject.scope === "session" &&
			(subject.sessionId !== identity.sessionId ||
				subject.clientRecordId !== identity.clientRecordId ||
				subject.clientId !== identity.clientId)
		)
			return null;
		const loaded = await client.mcpGovernance.resolveProviderIdentityProfile({
			organizationId: identity.organizationId,
			id: candidate.descriptor.profileId,
		});
		const profile = loaded.profile;
		if (
			!profile ||
			profile.profileDigest !== candidate.descriptor.profileDigest
		)
			return null;
		const reviewedInput = {
			...mountInput,
			rootAppId: candidate.descriptor.mount.rootAppId,
			mountedToolId: candidate.descriptor.mount.mountedToolId,
		};
		const [mount, probe, reviewed] = await Promise.all([
			prepareTenantIdentityProfileMount(reviewedInput),
			prepareTenantIdentityProfileMount({
				...mountInput,
				rootAppId: profile.probeMount.rootAppId,
				mountedToolId: profile.probeMount.mountedToolId,
			}),
			resolveFreshPolicyMount(reviewedInput),
		]);
		if (
			!mount ||
			!probe ||
			!reviewed ||
			reviewed.sourceAppId !== candidate.descriptor.mount.sourceAppId ||
			reviewed.tool.id !== tool.id ||
			(!fresh &&
				(await tenantPolicyCrossMountDigest(reviewed.tool)) !==
					(await tenantPolicyCrossMountDigest(tool))) ||
			mount.descriptorDigest !==
				(await tenantPolicyDescriptorDigest(candidate.descriptor.mount)) ||
			probe.descriptorDigest !==
				(await tenantPolicyDescriptorDigest(profile.probeMount))
		)
			return null;
		return { candidate, profile };
	};
	const current = await snapshot();
	if (!current || (!current.candidate.effect && !current.candidate.defaultAsk))
		return null;
	return {
		...current.candidate,
		effect: current.candidate.effect ?? {
			disposition: "ask" as const,
			riskTier: "high_impact_write" as const,
			blastRadius: "external_system" as const,
		},
		probe: {
			profile: current.profile.profile,
			binding: JSON.stringify([
				identity.organizationId,
				current.profile.id,
				current.profile.profileDigest,
				{ principalId: identity.principalId },
			]),
			expectedDigest: current.candidate.descriptor.accountRevisionDigest,
			requireTenantCredential: true,
			revalidate: async () => {
				const next = await snapshot();
				return (
					!!next &&
					next.candidate.revisionId === current.candidate.revisionId &&
					next.candidate.ruleDigest === current.candidate.ruleDigest &&
					next.candidate.descriptorDigest === current.candidate.descriptorDigest
				);
			},
		},
	};
}

export function tenantProfileCandidateIsBounded(
	candidate: NonNullable<
		Awaited<ReturnType<typeof resolveTenantProfileCandidate>>
	>,
	tool: AppTool,
): boolean {
	const action = ToolActionTypeSchema.safeParse(tool.actionType);
	const risk = resolveToolRiskPolicy(tool)?.riskTier;
	return (
		candidate.effect.riskTier === "bounded_write" &&
		candidate.effect.blastRadius === "single_resource" &&
		risk !== "high_impact_write" &&
		risk !== "external_side_effect" &&
		!(action.success && isPlatformCriticalActionType(action.data)) &&
		humanReservedActionClasses(
			`${tool.toolId} ${tool.config?.mcpToolName ?? ""} ${tool.config?.endpoint ?? ""}`,
		).length === 0
	);
}

/** Find a request-bound candidate; the returned probe must run before a write. */
export async function resolveTenantProfileCandidate(
	agent: ServerContext,
	tool: AppTool,
	args: Record<string, unknown>,
) {
	try {
		const caller = agent.callerIdentity;
		if (tool.config?.transport !== "mcp") return null;
		if (caller?.authType === "external_agent")
			return await resolveMachineCandidate(agent, tool, args);
		if (
			caller?.authType !== "oauth" ||
			!caller.userId ||
			!hasScope(caller.scopes ?? [], "connections.execute") ||
			!agent.env.API_SERVICE
		)
			return null;
		const target = resolveMultiOrgToolTarget(agent, tool);
		if (!target) return null;
		const client = getApiClient({
			serviceFetch: agent.env.API_SERVICE,
			orgId: target.organizationId,
		});
		const gateway = await client.apps.getBySlugWithTools({
			slug: target.gatewaySlug,
		});
		if (!gateway.app || gateway.app.organizationId !== target.organizationId)
			return null;
		const input = {
			organizationId: target.organizationId,
			rootAppId: gateway.app.id,
			mountedToolId: tool.toolId,
			actorUserId: caller.userId,
			args: JSON.parse(JSON.stringify(args)),
		};
		const argsDigest = await tenantPolicyDescriptorDigest(input.args);
		const snapshot = async () => {
			if ((await tenantPolicyDescriptorDigest(args)) !== argsDigest)
				return null;
			const { candidate } =
				await client.mcpGovernance.resolveTenantPolicyCandidate(input);
			if (!candidate || candidate.descriptor.actorUserId !== caller.userId)
				return null;
			const loaded = await client.mcpGovernance.resolveProviderIdentityProfile({
				organizationId: target.organizationId,
				id: candidate.descriptor.profileId,
			});
			const profile = loaded.profile;
			if (
				!profile ||
				profile.profileDigest !== candidate.descriptor.profileDigest
			)
				return null;
			const mountInput = {
				organizationId: target.organizationId,
				rootAppId: gateway.app!.id,
				mountedToolId: tool.toolId,
				env: agent.env,
			};
			const [fresh, freshProbe] = await Promise.all([
				prepareTenantIdentityProfileMount(mountInput),
				prepareTenantIdentityProfileMount({
					...mountInput,
					rootAppId: profile.probeMount.rootAppId,
					mountedToolId: profile.probeMount.mountedToolId,
				}),
			]);
			if (
				!fresh ||
				!freshProbe ||
				fresh.descriptorDigest !==
					(await tenantPolicyDescriptorDigest(candidate.descriptor.mount)) ||
				freshProbe.descriptorDigest !==
					(await tenantPolicyDescriptorDigest(profile.probeMount)) ||
				(await tenantPolicyEffectiveToolDigest(tool)) !==
					candidate.descriptor.mount.effectiveToolDigest ||
				tool.id !== candidate.descriptor.mount.sourceToolRowId
			)
				return null;
			return { candidate, profile };
		};
		const current = await snapshot();
		if (!current) return null;
		if (!current.candidate.effect && !current.candidate.defaultAsk) return null;
		return {
			...current.candidate,
			effect: current.candidate.effect ?? {
				disposition: "ask" as const,
				riskTier: "high_impact_write" as const,
				blastRadius: "external_system" as const,
			},
			probe: {
				profile: current.profile.profile,
				binding: JSON.stringify([
					target.organizationId,
					current.profile.id,
					current.profile.profileDigest,
					caller.userId,
				]),
				expectedDigest: current.candidate.descriptor.accountRevisionDigest,
				revalidate: async () => {
					const next = await snapshot();
					return (
						!!next &&
						next.candidate.revisionId === current.candidate.revisionId &&
						next.candidate.ruleDigest === current.candidate.ruleDigest &&
						next.candidate.descriptorDigest ===
							current.candidate.descriptorDigest
					);
				},
			},
		};
	} catch {
		return null;
	}
}
