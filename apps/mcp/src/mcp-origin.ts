import { type McpAccessDenialReason } from "./mcp/security-decision";
import type { ResolvedApp } from "./resolution";
import { buildCorsOrigins } from "./resolution";

/** Origin checks for browser-originated MCP requests. */

export function normalizeOrigin(origin: string): string | null {
	try {
		return new URL(origin).origin;
	} catch {
		return null;
	}
}

export function getAllowedMcpOrigins(
	request: Request,
	env: CloudflareEnv,
	resolvedApp?: ResolvedApp | null,
): string[] {
	const allowed = new Set(buildCorsOrigins(env, resolvedApp?.metadata ?? null));
	allowed.add(new URL(request.url).origin);
	return [...allowed]
		.map((origin) => normalizeOrigin(origin))
		.filter((origin): origin is string => Boolean(origin));
}

export function validateMcpOrigin(
	request: Request,
	env: CloudflareEnv,
	resolvedApp?: ResolvedApp | null,
): { response: Response; reason: McpAccessDenialReason } | null {
	const requestOrigin =
		request.headers.get("Origin") ?? request.headers.get("origin");
	if (!requestOrigin) return null;

	const normalizedOrigin = normalizeOrigin(requestOrigin);
	if (!normalizedOrigin) {
		return {
			response: new Response(
				JSON.stringify({
					error: "forbidden_origin",
					message: "Invalid Origin header",
				}),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			),
			reason: "invalid_origin",
		};
	}

	const allowedOrigins = getAllowedMcpOrigins(request, env, resolvedApp);
	if (allowedOrigins.includes(normalizedOrigin)) return null;

	return {
		response: new Response(
			JSON.stringify({
				error: "forbidden_origin",
				message: "Origin is not allowed for this MCP endpoint",
			}),
			{ status: 403, headers: { "Content-Type": "application/json" } },
		),
		reason: "forbidden_origin",
	};
}
