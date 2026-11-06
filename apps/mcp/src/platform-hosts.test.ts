import { describe, expect, it } from "vite-plus/test";
import { mcpPlatformHosts } from "./platform-hosts";

describe("mcpPlatformHosts", () => {
	it("keeps Tedix Cloud's hosts when no var is set", () => {
		expect(mcpPlatformHosts({})).toEqual({
			mcpHostSuffix: "mcp.tedix.dev",
			connectHostname: "connect.mcp.tedix.dev",
			siteBuilderHostname: "builder.tedix.dev",
			docsAdminHostnames: ["docs-admin.tedix.dev", "docs-admin.tedix.tech"],
			docsUrl: "https://docs.tedix.dev",
		});
	});

	it("uses a self-hosted installation's hosts", () => {
		expect(
			mcpPlatformHosts({
				MCP_HOST_SUFFIX: "mcp.example.com",
				SITE_BUILDER_HOSTNAME: "builder.example.com",
				DOCS_URL: "https://docs.example.com/",
				PLATFORM_DOMAINS: "example.com",
			}),
		).toEqual({
			mcpHostSuffix: "mcp.example.com",
			connectHostname: "connect.mcp.example.com",
			siteBuilderHostname: "builder.example.com",
			docsAdminHostnames: ["docs-admin.example.com"],
			docsUrl: "https://docs.example.com",
		});
	});
});
