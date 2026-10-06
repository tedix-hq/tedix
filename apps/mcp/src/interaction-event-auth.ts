import { getInternalApiClient } from "@tedix/api-client/internal";
import {
	validateAuth,
	validateHumanMcpSelection,
	resolveMcpExpectedAudience,
} from "./auth-helpers";
import { resolveConnectOrganization } from "./connect-organization";
import { extractAppFromHostname } from "./hostname";
import { resolveAppFromHostname } from "./resolution";

export type InteractionEventCredential = {
	// Private subscription storage only; never return or log this credential.
	authorization: string;
	mcpUrl: string;
	organizationId: string;
	requestId: string;
};

/** Recheck the original credential, live grant and exact resource on EVERY delivery. */
export async function authorizeInteractionEvent(
	env: CloudflareEnv,
	credential: InteractionEventCredential,
): Promise<{ owner: string; expiresAt: number }> {
	const url = new URL(credential.mcpUrl);
	if (
		url.protocol !== "https:" ||
		url.pathname !== "/mcp" ||
		url.search ||
		url.username ||
		url.password
	)
		throw new Error("Invalid MCP resource");
	const app = await resolveAppFromHostname(
		extractAppFromHostname(url.hostname, env),
		env,
	);
	const config = app?.metadata?.mcpConfig;
	if (!app || config?.interactionEvents !== true || !config.descopeResourceId)
		throw new Error("Interaction events unavailable");
	const audience = resolveMcpExpectedAudience({
		hostname: url.hostname,
		authMode: config.authMode,
		configuredAudience: config.expectedAudience,
	});
	if (!audience) throw new Error("OAuth resource unavailable");
	// Deliberately exclude all forwarded/service headers. Only the original
	// human bearer can establish a fresh grant; stale scopes are not authority.
	const auth = await validateAuth(
		new Request(url, { headers: { Authorization: credential.authorization } }),
		env,
		{
			hostname: url.hostname,
			expectedAudience: audience,
			mcpServerId: config.descopeResourceId,
		},
	);
	if (
		!auth ||
		auth instanceof Response ||
		auth.type !== "oauth" ||
		auth.localDemo === true ||
		auth.payload.entityType === "tedi" ||
		typeof auth.payload.sub !== "string" ||
		typeof auth.payload.exp !== "number"
	)
		throw new Error("Human OAuth required");
	if (!auth.scopes?.includes("mcp:messaging.read"))
		throw new Error("Messaging read consent required");
	const selection = await validateHumanMcpSelection(auth.payload, env, {
		audience,
		mcpServerId: config.descopeResourceId,
		multiOrganization: config.multiOrgConsent === true,
	});
	if (!selection) throw new Error("Current consent unavailable");
	const org = resolveConnectOrganization(selection, credential.organizationId);
	if (
		org.organizationId !== credential.organizationId ||
		(config.multiOrgConsent !== true &&
			app.app.organizationId !== org.organizationId)
	)
		throw new Error("Organization not selected");
	const client = getInternalApiClient(env, {
		organizationId: org.organizationId,
		headers: {
			"X-Forwarded-Authorization": credential.authorization,
			"X-Tedix-Caller-Type": "mcp-edge-user",
			"X-Tedix-Mcp-Caller-Scopes": auth.scopes.join(" "),
		},
	});
	const result = await client.workInteractions.get({
		requestId: credential.requestId,
		responseLimit: 1,
	});
	if (
		result.request.orgId !== org.organizationId ||
		result.request.id !== credential.requestId
	)
		throw new Error("Interaction scope mismatch");
	return { owner: auth.payload.sub, expiresAt: auth.payload.exp * 1000 };
}
