import type { McpUiResourcePermissions } from "@modelcontextprotocol/ext-apps";

/** Encode the closed permission set for the same-origin sandbox proxy. */
export function widgetSandboxUrl(
	permissions?: McpUiResourcePermissions & {
		translator?: object;
		languageDetector?: object;
	},
): URL {
	const url = new URL("/sandbox_proxy.html", window.location.origin);
	if (permissions && Object.keys(permissions).length > 0) {
		url.searchParams.set("permissions", JSON.stringify(permissions));
	}
	return url;
}
