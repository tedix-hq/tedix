import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { isRecord } from "@tedix/api-contract/utils/is-record";
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

/** Redeems a user-initiated exact-call receipt; no caller-supplied actor or profile. */
export async function probeReviewedProviderIdentity(input: {
	organizationId: string;
	receiptId: string;
	exampleArgs: Record<string, unknown>;
	env: CloudflareEnv;
	ctx?: ExecutionContext;
	onCredentialSummary?: (summary: {
		scope: "user" | "tenant";
		connectionInstanceId?: string;
	}) => void;
}): Promise<string | null> {
	try {
		const client = getApiClient({
			serviceFetch: input.env.API_SERVICE,
			orgId: input.organizationId,
		});
		const receipt = await client.mcpGovernance.redeemProviderIdentityProbe({
			organizationId: input.organizationId,
			receiptId: input.receiptId,
			exampleArgs: JSON.parse(JSON.stringify(input.exampleArgs)),
		});
		if (
			!receipt.actorUserId ||
			!receipt.profileId ||
			!receipt.verifiedScopes.includes("connections.execute")
		)
			return null;
		const first = await client.mcpGovernance.resolveProviderIdentityProfile({
			organizationId: input.organizationId,
			id: receipt.profileId,
		});
		const profile = first.profile;
		if (
			!profile ||
			profile.organizationId !== input.organizationId ||
			profile.revokedAt
		)
			return null;
		const mountInput = {
			organizationId: input.organizationId,
			rootAppId: profile.mount.rootAppId,
			mountedToolId: profile.mount.mountedToolId,
			env: input.env,
			ctx: input.ctx,
		};
		const probeInput = {
			...mountInput,
			rootAppId: profile.probeMount.rootAppId,
			mountedToolId: profile.probeMount.mountedToolId,
		};
		const revalidate = async () => {
			const [current, mount, probe] = await Promise.all([
				client.mcpGovernance.resolveProviderIdentityProfile({
					organizationId: input.organizationId,
					id: profile.id,
				}),
				prepareTenantIdentityProfileMount(mountInput),
				prepareTenantIdentityProfileMount(probeInput),
			]);
			return (
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
		if (!(await revalidate())) return null;
		const [resolved, root] = await Promise.all([
			resolveFreshPolicyMount(mountInput),
			client.apps.getByIdWithTools({ appId: profile.mount.rootAppId }),
		]);
		if (
			!resolved ||
			!root.app ||
			root.app.organizationId !== input.organizationId ||
			resolved.sourceAppId !== profile.mount.sourceAppId ||
			resolved.tool.id !== profile.mount.sourceToolRowId ||
			(await tenantPolicyEffectiveToolDigest(resolved.tool)) !==
				profile.mount.effectiveToolDigest
		)
			return null;
		const metadata = isRecord(root.app.metadata) ? root.app.metadata : null;
		const mcpConfig = isRecord(metadata?.mcpConfig) ? metadata.mcpConfig : null;
		const config = resolved.tool.config as unknown as ToolConfig;
		const ctx = {
			appId: profile.mount.rootAppId,
			app: root.app,
			appCapabilities: {},
			env: input.env,
			config,
			toolId: resolved.tool.toolId,
			toolInputSchema: resolved.tool.inputSchema,
			requestId: crypto.randomUUID(),
			callerIdentity: {
				authType: "service",
				kernel: true,
				userId: receipt.actorUserId,
				organizationId: input.organizationId,
				scopes: receipt.verifiedScopes,
			},
			connectionLabel:
				typeof mcpConfig?.connectionLabel === "string"
					? mcpConfig.connectionLabel
					: undefined,
			prepareIdentityProbe: {
				profile: profile.profile,
				binding: JSON.stringify([
					input.organizationId,
					profile.id,
					profile.profileDigest,
					receipt.actorUserId,
				]),
				revalidate,
			},
		} as unknown as ToolExecutionContext<ToolConfig>;
		const result = await executeMcpTransport(receipt.exampleArgs, ctx, config, {
			fetchConnectionToken,
		});
		if (
			result.status !== 200 ||
			!isRecord(result.data) ||
			typeof result.data.accountRevisionDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(result.data.accountRevisionDigest)
		)
			return null;
		const summary = result.data.credentialSummary;
		if (
			isRecord(summary) &&
			(summary.scope === "user" || summary.scope === "tenant") &&
			(summary.connectionInstanceId === undefined ||
				(typeof summary.connectionInstanceId === "string" &&
					/^[0-9a-f-]{36}$/i.test(summary.connectionInstanceId)))
		)
			input.onCredentialSummary?.({
				scope: summary.scope,
				...(typeof summary.connectionInstanceId === "string"
					? { connectionInstanceId: summary.connectionInstanceId }
					: {}),
			});
		return result.data.accountRevisionDigest;
	} catch {
		return null;
	}
}
