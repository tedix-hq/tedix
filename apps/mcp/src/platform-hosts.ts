import { hostSetting, platformDomains } from "@tedix/worker-kit/platform-hosts";

// A type alias, not an interface: the Worker env must stay assignable to
// `Record<string, unknown>`.
export type McpPlatformHostEnv = {
	/** Parent host of app MCP servers (`{app}.<suffix>`). Default `mcp.tedix.dev`. */
	MCP_HOST_SUFFIX?: string;
	/** Public host of the Site Builder MCP server. Default `builder.tedix.dev`. */
	SITE_BUILDER_HOSTNAME?: string;
	/** Public docs site linked from OAuth metadata. Default `https://docs.tedix.dev`. */
	DOCS_URL?: string;
	/** Comma-separated platform domains; docs admin lives at `docs-admin.<domain>`. */
	PLATFORM_DOMAINS?: string;
};

/** The MCP Worker's own hostnames; unset vars keep Tedix Cloud's hosts. */
export function mcpPlatformHosts(env: McpPlatformHostEnv) {
	const mcpHostSuffix = hostSetting(env.MCP_HOST_SUFFIX, "mcp.tedix.dev");
	return {
		mcpHostSuffix,
		connectHostname: `connect.${mcpHostSuffix}`,
		siteBuilderHostname: hostSetting(
			env.SITE_BUILDER_HOSTNAME,
			"builder.tedix.dev",
		),
		docsAdminHostnames: platformDomains(env).map(
			(domain) => `docs-admin.${domain}`,
		),
		docsUrl: (
			env.DOCS_URL?.trim() ||
			`https://${hostSetting(undefined, "docs.tedix.dev")}`
		).replace(/\/+$/, ""),
	};
}
