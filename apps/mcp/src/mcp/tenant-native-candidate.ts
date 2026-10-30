import { getInternalApiClient } from "@tedix/api-client/internal";
import { hasScope } from "@tedix/mcp-shared/auth/scopes";
import { resolveMcpToolNamespace } from "@tedix/mcp-shared/auth/tool-scopes";
import { resolveCodeModeInnerToolScopes } from "./codemode-auth";
import { resolveFreshExternalAgentAihAuthority } from "../auth-helpers";
import { getApiClient } from "../lib/api-client";
import { resolveMultiOrgToolTarget } from "./multi-org-tool-target";
import {
	prepareTenantNativePolicyMount,
	resolveFreshPolicyMount,
	tenantPolicyDescriptorDigest,
	tenantPolicyEffectiveToolDigest,
} from "./tenant-policy-mount";
import type { AppTool, ServerContext } from "./server-context";
import { buildHomeSurfaceTools } from "./home-surface-tools";
import { shouldExposeHomeSurface } from "./home-surface";

/** Missing or invalid rules cannot fall through to older autonomy grants. */
export async function tenantMachinePolicyFallbackBlocked(
	agent: ServerContext,
	tool: AppTool,
): Promise<boolean> {
	const caller = agent.callerIdentity;
	const homeTools = buildHomeSurfaceTools();
	const generatedHomeId = homeTools.some((home) => home.id === tool.id);
	if (
		(caller?.authType !== "external_agent" &&
			caller?.authType !== "oauth" &&
			!(
				caller?.authType === "service" &&
				caller.kernel === true &&
				caller.userId
			)) ||
		(tool.config?.transport !== "mcp" &&
			tool.config?.transport !== "rpc" &&
			!generatedHomeId)
	)
		return false;
	if (caller.authType !== "external_agent" && tool.config?.transport !== "mcp")
		return false;
	if (!agent.appId || !tool.id || !agent.env.API_SERVICE) return true;
	try {
		const selected =
			caller.authType === "oauth"
				? resolveMultiOrgToolTarget(agent, tool)
				: null;
		const organizationId = selected?.organizationId ?? caller.organizationId;
		if (!organizationId) return true;
		const client = getApiClient({
			serviceFetch: agent.env.API_SERVICE,
			orgId: organizationId,
		});
		const selectedGateway = selected
			? await client.apps.getBySlugWithTools({ slug: selected.gatewaySlug })
			: null;
		if (
			selected &&
			(!selectedGateway?.app ||
				selectedGateway.app.organizationId !== organizationId)
		)
			return true;
		const rootAppId = selectedGateway?.app?.id ?? agent.appId;
		const fresh = await resolveFreshPolicyMount({
			organizationId,
			rootAppId,
			mountedToolId: tool.toolId,
			env: agent.env,
		});
		let sourceAppId = fresh?.sourceAppId;
		let sourceToolId = fresh?.sourceToolId;
		if (fresh && fresh.tool.id !== tool.id) return true;
		if (generatedHomeId && fresh?.sourceKind !== "home-surface") return true;
		if (
			fresh?.sourceKind === "home-surface" &&
			(await tenantPolicyEffectiveToolDigest(fresh.tool)) !==
				(await tenantPolicyEffectiveToolDigest(tool))
		)
			return true;
		if (!sourceAppId) {
			const source = await client.apps.getByIdWithTools({ appId: rootAppId });
			// A rejected or revoked generated mount must not become a stored-row fallback.
			if (
				source.app &&
				shouldExposeHomeSurface({
					appSlug: source.app.slug,
					metadata: source.app.metadata,
				}) &&
				homeTools.some((home) => home.toolId === tool.toolId)
			)
				return true;
			const row = source.tools.find(
				(item) => item.id === tool.id && item.toolId === tool.toolId,
			);
			if (!source.app || source.app.organizationId !== organizationId || !row)
				return true;
			sourceAppId = rootAppId;
			sourceToolId = row.toolId;
		}
		if (!sourceToolId) return true;
		const input = {
			organizationId,
			sourceAppId,
			sourceToolRowId: tool.id,
			sourceToolId,
		};
		const [exact, any] = await Promise.all([
			client.mcpGovernance.resolveTenantPolicyPresence({
				...input,
				rootAppId,
				mountedToolId: tool.toolId,
			}),
			client.mcpGovernance.resolveTenantPolicyPresence(input),
		]);
		return exact.fenced || any.fenced;
	} catch {
		return true;
	}
}

/** A native rule never grants scopes; it only supplies an approval decision. */
export async function resolveNativePolicyCandidate(
	agent: ServerContext,
	tool: AppTool,
	args: Record<string, unknown>,
) {
	const caller = agent.callerIdentity;
	if (
		tool.config?.transport !== "rpc" ||
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
		const [authority, mount] = await Promise.all([
			resolveFreshExternalAgentAihAuthority(agent.env, identity),
			prepareTenantNativePolicyMount(mountInput),
		]);
		if (
			!authority ||
			!mount ||
			mount.descriptor.sourceToolRowId !== tool.id ||
			mount.descriptor.effectiveToolDigest !==
				(await tenantPolicyEffectiveToolDigest(tool))
		)
			return null;
		const requiredScopes = resolveCodeModeInnerToolScopes(
			tool,
			resolveMcpToolNamespace(
				tool,
				agent.appMetadata?.mcpConfig?.codeModeNamespaces as
					| Record<string, string>
					| undefined,
			),
			agent.appMetadata?.mcpConfig as Record<string, unknown> | undefined,
			{ arguments: inputArgs },
		);
		if (!requiredScopes.every((scope) => hasScope(authority.scopes, scope)))
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
		const { candidate } =
			await client.mcpGovernance.resolveNativeRpcPolicyCandidate({
				organizationId: identity.organizationId,
				rootAppId: agent.appId,
				sourceAppId: mount.descriptor.sourceAppId,
				sourceToolRowId: tool.id,
				args: inputArgs,
			});
		if (
			!candidate ||
			(await tenantPolicyDescriptorDigest(candidate.descriptor.mount)) !==
				mount.descriptorDigest ||
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
		return candidate;
	};
	const candidate = await snapshot();
	if (!candidate || (!candidate.effect && !candidate.defaultAsk)) return null;
	return {
		...candidate,
		effect: candidate.effect ?? {
			disposition: "ask" as const,
			riskTier: "high_impact_write" as const,
			blastRadius: "external_system" as const,
		},
		revalidate: async () => {
			const next = await snapshot();
			return (
				!!next &&
				next.revisionId === candidate.revisionId &&
				next.ruleDigest === candidate.ruleDigest &&
				next.descriptorDigest === candidate.descriptorDigest
			);
		},
	};
}
