import { MCP_STRUCTURED_CALL_META_KEY } from "@tedix/api-contract/schemas/mcp-native-transport";
import { sidebarAppConfig } from "./sidebar-app";

/** Outer Code Mode auth describes the app, not the union of inner tools.
 * Inner capability checks request additional access only when needed.
 */
export function codeModeSecurityMeta(
	config: Record<string, unknown> | null | undefined,
): {
	securitySchemes: Array<{ type: string; scopes?: string[] }>;
} {
	const mode = config?.authMode;
	const toolScopes = config?.toolScopes as Record<string, string[]> | undefined;
	const scopes = toolScopes?.code;
	const oauth = {
		type: "oauth2",
		...(scopes?.length ? { scopes } : {}),
	};
	return {
		securitySchemes:
			mode === "authenticated"
				? [oauth]
				: mode === "hybrid"
					? [{ type: "noauth" }, oauth]
					: [{ type: "noauth" }],
	};
}

export function codeModeToolMeta(
	config: Record<string, unknown> | null | undefined,
) {
	return {
		...codeModeSecurityMeta(config),
		[MCP_STRUCTURED_CALL_META_KEY]: { version: 1 },
		...(sidebarAppConfig(config)
			? { ui: { visibility: ["model", "app"] } }
			: {}),
	};
}
