import { hasScope } from "@tedix/mcp-shared/auth/scopes";
import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { resolveFreshExternalAgentAihAuthority } from "../auth-helpers";
import { getApiClient } from "../lib/api-client";
import { fetchConnectionToken } from "./handler-connection-credentials";
import { executeMcpTransport } from "./handler-mcp-transport";
import type { ToolExecutionContext } from "./handler";
import {
	prepareTenantIdentityProfileMount,
	resolveFreshPolicyMount,
	tenantPolicyDescriptorDigest,
	tenantPolicyEffectiveToolDigest,
} from "./tenant-policy-mount";
import type { ServerContext } from "./server-context";

/** Only a redeemed service receipt may reconstruct the initiating machine. */
export async function redeemAndPrepareMachineProviderProof(input: {
	organizationId: string;
	receiptId: string;
	exampleArgs: Record<string, unknown>;
	env: CloudflareEnv;
}): Promise<{ receiptId: string }> {
	const client = getApiClient({
		serviceFetch: input.env.API_SERVICE,
		orgId: input.organizationId,
	});
	const receipt = await client.mcpGovernance.redeemMachineIdentityProbe({
		organizationId: input.organizationId,
		receiptId: input.receiptId,
		exampleArgs: input.exampleArgs,
	});
	const identity = {
		organizationId: input.organizationId,
		principalId: receipt.principalId,
		sessionId: receipt.sessionId,
		clientRecordId: receipt.clientRecordId,
		clientId: receipt.clientId,
		mcpServerId: receipt.mcpServerId,
	};
	const authority = await resolveFreshExternalAgentAihAuthority(
		input.env,
		identity,
	);
	if (!authority || !hasScope(authority.scopes, "connections.execute"))
		throw new Error("Machine authority unavailable.");
	const result = await client.mcpGovernance.resolveProviderIdentityProfile({
		organizationId: input.organizationId,
		id: receipt.profileId,
	});
	if (!result.profile) throw new Error("Reviewed profile unavailable.");
	const agent = {
		env: input.env,
		appId: result.profile.mount.rootAppId,
		callerIdentity: {
			authType: "external_agent",
			organizationId: input.organizationId,
			externalAgentPrincipalId: identity.principalId,
			externalAgentSessionId: identity.sessionId,
			externalAgentClientRecordId: identity.clientRecordId,
			externalAgentMcpServerId: identity.mcpServerId,
			clientId: identity.clientId,
			scopes: authority.scopes,
		},
	} as unknown as ServerContext;
	return prepareMachineProviderProof(agent, {
		profileId: receipt.profileId,
		exampleArgs: receipt.exampleArgs,
	});
}

/** The caller identity is supplied only by the authenticated MCP ingress. */
export async function prepareMachineProviderProof(
	agent: ServerContext,
	input: unknown,
	expectedDigest?: string,
): Promise<{ receiptId: string }> {
	const caller = agent.callerIdentity;
	if (
		!isRecord(input) ||
		typeof input.profileId !== "string" ||
		!input.profileId ||
		!isRecord(input.exampleArgs) ||
		caller?.authType !== "external_agent" ||
		!caller.organizationId ||
		!caller.externalAgentPrincipalId ||
		!caller.externalAgentSessionId ||
		!caller.externalAgentClientRecordId ||
		!caller.externalAgentMcpServerId ||
		!caller.clientId ||
		!agent.env.API_SERVICE
	)
		throw new Error(
			"A verified external-agent session and profile are required.",
		);
	const identity = {
		organizationId: caller.organizationId,
		principalId: caller.externalAgentPrincipalId,
		sessionId: caller.externalAgentSessionId,
		clientRecordId: caller.externalAgentClientRecordId,
		clientId: caller.clientId,
		mcpServerId: caller.externalAgentMcpServerId,
	};
	const client = getApiClient({
		serviceFetch: agent.env.API_SERVICE,
		orgId: identity.organizationId,
		externalAgent: {
			principalId: identity.principalId,
			sessionId: identity.sessionId,
			clientRecordId: identity.clientRecordId,
		},
	});
	const first = await client.mcpGovernance.resolveProviderIdentityProfile({
		organizationId: identity.organizationId,
		id: input.profileId,
	});
	const profile = first.profile;
	if (
		!profile ||
		profile.organizationId !== identity.organizationId ||
		profile.mount.rootAppId !== agent.appId ||
		profile.mount.connectionScope === "user"
	)
		throw new Error(
			"The reviewed profile is unavailable for this organization connection.",
		);
	const mountInput = {
		organizationId: identity.organizationId,
		rootAppId: profile.mount.rootAppId,
		mountedToolId: profile.mount.mountedToolId,
		env: agent.env,
	};
	const probeInput = {
		...mountInput,
		rootAppId: profile.probeMount.rootAppId,
		mountedToolId: profile.probeMount.mountedToolId,
	};
	const revalidate = async () => {
		const [authority, current, mount, probe] = await Promise.all([
			resolveFreshExternalAgentAihAuthority(agent.env, identity),
			client.mcpGovernance.resolveProviderIdentityProfile({
				organizationId: identity.organizationId,
				id: profile.id,
			}),
			prepareTenantIdentityProfileMount(mountInput),
			prepareTenantIdentityProfileMount(probeInput),
		]);
		return (
			!!authority &&
			hasScope(authority.scopes, "connections.execute") &&
			!!current.profile &&
			current.profile.profileDigest === profile.profileDigest &&
			!!mount &&
			mount.descriptorDigest ===
				(await tenantPolicyDescriptorDigest(profile.mount)) &&
			!!probe &&
			probe.descriptorDigest ===
				(await tenantPolicyDescriptorDigest(profile.probeMount))
		);
	};
	if (!(await revalidate()))
		throw new Error("External-agent access or the reviewed profile changed.");
	const [resolved, root] = await Promise.all([
		resolveFreshPolicyMount(mountInput),
		client.apps.getByIdWithTools({ appId: agent.appId }),
	]);
	if (
		!resolved ||
		!root.app ||
		root.app.organizationId !== identity.organizationId ||
		resolved.sourceAppId !== profile.mount.sourceAppId ||
		resolved.tool.id !== profile.mount.sourceToolRowId ||
		(await tenantPolicyEffectiveToolDigest(resolved.tool)) !==
			profile.mount.effectiveToolDigest
	)
		throw new Error("The reviewed tool changed.");
	const config = resolved.tool.config as unknown as ToolConfig;
	// Account identity is stable across sessions; each session is separately
	// authenticated and revalidated before and after the probe.
	const machineSubject = { principalId: identity.principalId };
	const metadata = isRecord(root.app.metadata) ? root.app.metadata : null;
	const mcpConfig = isRecord(metadata?.mcpConfig) ? metadata.mcpConfig : null;
	const ctx = {
		appId: agent.appId,
		app: root.app,
		appCapabilities: {},
		env: agent.env,
		config,
		toolId: resolved.tool.toolId,
		toolInputSchema: resolved.tool.inputSchema,
		requestId: crypto.randomUUID(),
		callerIdentity: caller,
		connectionLabel:
			typeof mcpConfig?.connectionLabel === "string"
				? mcpConfig.connectionLabel
				: undefined,
		prepareIdentityProbe: {
			profile: profile.profile,
			binding: JSON.stringify([
				identity.organizationId,
				profile.id,
				profile.profileDigest,
				machineSubject,
			]),
			revalidate,
			requireTenantCredential: true,
		},
	} as unknown as ToolExecutionContext<ToolConfig>;
	const args = JSON.parse(JSON.stringify(input.exampleArgs));
	const result = await executeMcpTransport(args, ctx, config, {
		fetchConnectionToken,
	});
	if (
		result.status !== 200 ||
		!isRecord(result.data) ||
		typeof result.data.accountRevisionDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(result.data.accountRevisionDigest) ||
		!(await revalidate())
	)
		throw new Error(
			"Provider identity proof is unavailable or access changed.",
		);
	if (expectedDigest !== undefined) {
		if (result.data.accountRevisionDigest !== expectedDigest)
			throw new Error("Provider identity changed.");
		return { receiptId: "" };
	}
	return client.mcpGovernance.recordMachineProviderProbe({
		...identity,
		profileId: profile.id,
		profileDigest: profile.profileDigest,
		exampleArgs: args,
		accountRevisionDigest: result.data.accountRevisionDigest,
	});
}
