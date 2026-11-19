import {
	hasScope,
	requiredTediMcpToolScope,
} from "@tedix/mcp-shared/auth/scopes";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";

export const TEDI_MCP_AUTH_CONTEXT_HEADER = "X-Tedix-Mcp-Auth-Context";

export type TediMcpCaller = {
	delegatedToolName?: string;
	method: "api-key" | "gateway-token" | "jwt" | "service";
	principalId: string;
	principalType: "api_key" | "client" | "service" | "tedi" | "user";
	scopes: string[];
};

export function canCallTediMcpTool(
	caller: TediMcpCaller,
	toolName: string,
	readOnly: boolean,
): boolean {
	return hasScope(caller.scopes, requiredTediMcpToolScope(toolName, readOnly));
}

export function encodeTediMcpCaller(caller: TediMcpCaller): string {
	return encodeURIComponent(JSON.stringify(caller));
}

export function decodeTediMcpCaller(request: Request): TediMcpCaller | null {
	const encoded = request.headers.get(TEDI_MCP_AUTH_CONTEXT_HEADER);
	if (!encoded) return null;
	try {
		const value: unknown = JSON.parse(decodeURIComponent(encoded));
		if (!value || typeof value !== "object") return null;
		const candidate = value as Partial<TediMcpCaller>;
		if (
			!candidate.method ||
			!candidate.principalId ||
			!candidate.principalType ||
			(candidate.delegatedToolName !== undefined &&
				typeof candidate.delegatedToolName !== "string") ||
			!Array.isArray(candidate.scopes) ||
			!candidate.scopes.every((scope) => typeof scope === "string")
		)
			return null;
		return candidate as TediMcpCaller;
	} catch {
		return null;
	}
}

/** The member a trusted platform hop names as the person behind a request. */
export const ACTING_USER_HEADER = "X-Tedix-Acting-User";

/**
 * Sign-in subject of the member whose request starts this turn, so their
 * monthly credit cap applies to its model calls. Only edge-derived identity
 * counts: a person authenticated directly at the tedi edge, or the member a
 * service-binding hop (the MCP gateway or apps/api) names. Tedis, API keys,
 * clients and scheduled work have no member, so only the organization and
 * tedi limits apply to them.
 */
export function actingMemberForRequest(request: Request): string | undefined {
	const caller = decodeTediMcpCaller(request);
	const named = () =>
		isServiceBinding(request.headers)
			? request.headers.get(ACTING_USER_HEADER)?.trim().slice(0, 300) ||
				undefined
			: undefined;
	if (!caller) return named();
	if (caller.method === "service") return named();
	return caller.principalType === "user" ? caller.principalId : undefined;
}

/**
 * Skill workflows carry their run identity in gateway-authenticated headers.
 * The runtime edge overwrites the private caller envelope, so a public caller
 * cannot attest a workflow run merely by supplying this header.
 */
export function skillWorkflowRunId(request: Request): string | undefined {
	if (decodeTediMcpCaller(request)?.method !== "service") return undefined;
	return (
		request.headers.get("X-Tedix-Skill-Run-Id")?.trim().slice(0, 512) ||
		undefined
	);
}
