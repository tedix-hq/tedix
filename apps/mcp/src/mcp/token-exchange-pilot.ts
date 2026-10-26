/**
 * Internal token exchange pilot for the tedi → MCP → API hop. Off unless the
 * Worker variable TOKEN_EXCHANGE_PILOT is "on". With it on, a tedi's RPC tool
 * call first asks the API broker for a one-call token that carries only the
 * scopes this tool requires, then forwards it beside the usual headers; the
 * API narrows the call to that token. A refused exchange refuses the call.
 */
import {
	EXCHANGED_TOKEN_HEADER,
	TOKEN_EXCHANGE_API_AUDIENCE,
} from "@tedix/api-contract/schemas/token-exchange";
import {
	resolveMcpToolNamespace,
	resolveMcpToolRequiredScopes,
} from "@tedix/mcp-shared/auth/tool-scopes";
import { callApiRpc } from "../lib/rpc";

type PilotEnv = Parameters<typeof callApiRpc>[0] & {
	TOKEN_EXCHANGE_PILOT?: string;
};

export function tokenExchangePilotEnabled(env: PilotEnv): boolean {
	return env.TOKEN_EXCHANGE_PILOT === "on";
}

export class TokenExchangePilotError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TokenExchangePilotError";
	}
}

/**
 * Exchange and attach a token when the pilot is on and this is a tedi's
 * service-binding RPC call. Returns whether a token was attached.
 */
export async function attachExchangedToken(input: {
	env: PilotEnv;
	endpoint: string;
	toolId: string;
	config: Record<string, unknown>;
	/** The served app's MCP config, so configured tool scopes apply. */
	mcpConfig?: Record<string, unknown>;
	readOnlyHint?: boolean;
	/** The caller's own organization; a cross-organization call is not exchanged. */
	callerOrganizationId?: string;
	headers: Record<string, string>;
	serviceBinding: boolean;
}): Promise<boolean> {
	if (
		!tokenExchangePilotEnabled(input.env) ||
		!input.serviceBinding ||
		!input.headers["X-Tedix-Tedi-Id"] ||
		input.headers["X-Tedix-Caller-Type"] ||
		// The pilot covers a tedi acting in its own organization with forwarded
		// scopes; platform cross-organization calls and scope-less bridges keep
		// the existing path.
		!input.headers["X-Tedix-Tedi-Scopes"] ||
		!input.callerOrganizationId ||
		input.headers["X-Tedix-Org-Id"] !== input.callerOrganizationId
	)
		return false;
	const tool = {
		toolId: input.toolId,
		config: input.config,
		toolTypeId: "rpc",
		...(input.readOnlyHint !== undefined
			? { annotations: { readOnlyHint: input.readOnlyHint } }
			: {}),
	};
	let scopes: string[];
	try {
		scopes = resolveMcpToolRequiredScopes(
			tool,
			resolveMcpToolNamespace(tool),
			input.mcpConfig,
			{ fallbackOnAuthenticatedAuthMode: true },
		);
	} catch {
		throw new TokenExchangePilotError("Tool scope could not be resolved");
	}
	if (scopes.length === 0 || scopes.length > 8)
		throw new TokenExchangePilotError("Tool scope could not be resolved");
	const { [EXCHANGED_TOKEN_HEADER]: _ignored, ...forwarded } = input.headers;
	const { data, status } = await callApiRpc(
		input.env,
		"tokenExchange/exchange",
		{ endpoint: input.endpoint, scopes },
		{ headers: forwarded, serviceBinding: true },
	);
	// The API side of the pilot is off: send no token rather than fail.
	if (status === 404) return false;
	const token =
		status < 400 &&
		data &&
		typeof data === "object" &&
		typeof (data as { accessToken?: unknown }).accessToken === "string"
			? (data as { accessToken: string }).accessToken
			: null;
	if (!token)
		throw new TokenExchangePilotError(
			`Token exchange for ${TOKEN_EXCHANGE_API_AUDIENCE} was refused`,
		);
	input.headers[EXCHANGED_TOKEN_HEADER] = token;
	return true;
}
