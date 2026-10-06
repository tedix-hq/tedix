import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { callApiRpc } from "../lib/rpc";
import type { ToolExecutionContext } from "./handler";

/** Original signed browser token is private request metadata, never a tool argument. */
export async function resolveEmbeddedHostDelegation(
	ctx: ToolExecutionContext<ToolConfig>,
	config: ToolConfig,
): Promise<
	| {
			token: string;
			providerOrganizationId: string;
			connectionProviderId: string;
			connectionScopes: string[];
			authHeader: string;
			authTemplate: string;
			audience: string;
			expiresAt: number;
	  }
	| undefined
> {
	const token = ctx.requestMeta?.["tedix/embedded-session"];
	if (token === undefined) return undefined;
	const caller = ctx.callerIdentity;
	if (
		typeof token !== "string" ||
		!token ||
		!ctx.env.API_SERVICE ||
		!caller?.tediId ||
		!caller.organizationId ||
		!["tedi", "service"].includes(caller.authType) ||
		!ctx.callable ||
		!config.baseUrl ||
		config.auth?.type !== "connection"
	) {
		throw new Error("Embedded host delegation denied");
	}
	const source = (config as unknown as Record<string, unknown>)._sourceAppId;
	const sourceAppId = typeof source === "string" ? source : ctx.app.id;
	const audience = new URL(config.baseUrl).origin;
	if (!audience.startsWith("https://"))
		throw new Error("Embedded host delegation denied");
	const { data, status } = await callApiRpc(
		ctx.env,
		"tedis/resolveEmbeddedHostDelegation",
		{
			token,
			tediId: caller.tediId,
			organizationId: caller.organizationId,
			sourceAppId,
			callable: ctx.callable,
			audience,
		},
		{
			serviceBinding: true,
			headers: {
				"X-Tedix-Org-Id": caller.organizationId,
				"X-Tedix-Tedi-Id": caller.tediId,
				"X-Tedix-Mcp-Tool-Id": ctx.toolId,
			},
		},
	);
	if (status !== 200 || !data || typeof data !== "object")
		throw new Error("Embedded host delegation denied");
	const result = data as Record<string, unknown>;
	if (
		typeof result.token !== "string" ||
		!result.token ||
		typeof result.providerOrganizationId !== "string" ||
		!result.providerOrganizationId ||
		typeof result.connectionProviderId !== "string" ||
		!result.connectionProviderId ||
		!Array.isArray(result.connectionScopes) ||
		!result.connectionScopes.every((scope) => typeof scope === "string") ||
		typeof result.authHeader !== "string" ||
		!/^[A-Za-z0-9-]+$/.test(result.authHeader) ||
		result.authHeader.toLowerCase() === "x-tedix-host-delegation" ||
		typeof result.authTemplate !== "string" ||
		!result.authTemplate.includes("{token}") ||
		/[\r\n]/.test(result.authTemplate) ||
		result.audience !== audience ||
		typeof result.expiresAt !== "number" ||
		result.expiresAt <= Date.now() / 1000
	)
		throw new Error("Embedded host delegation denied");
	return {
		token: result.token,
		providerOrganizationId: result.providerOrganizationId,
		connectionProviderId: result.connectionProviderId,
		connectionScopes: result.connectionScopes as string[],
		authHeader: result.authHeader,
		authTemplate: result.authTemplate,
		audience,
		expiresAt: result.expiresAt,
	};
}

/** An upstream echo must not expose the private provider assertion to the model. */
export function redactDelegationResponse(
	value: unknown,
	token: string,
): unknown {
	if (typeof value === "string") return value.split(token).join("<redacted>");
	if (Array.isArray(value))
		return value.map((item) => redactDelegationResponse(item, token));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key.split(token).join("<redacted>"),
				redactDelegationResponse(item, token),
			]),
		);
	return value;
}
