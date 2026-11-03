/**
 * External product tools mounted into a gateway (Notion, Gmail, Calendar)
 * carry provider tool names no Tedix rule knows. Without a namespace key in the
 * gateway's toolScopes they failed closed, so only owner tokens holding
 * platform authority could call them and every standard tedi was locked out.
 */

import { describe, expect, it } from "vite-plus/test";
import { CAPABILITY_PROFILES, hasScope } from "./scopes";
import { resolveMcpToolRequiredScopes } from "./tool-scopes";

const gatewayConfig = {
	enforcePolicies: false,
	authMode: "authenticated",
	toolScopes: { google_docs_tedix: ["mcp:content.write"] },
};

function mounted(
	toolId: string,
	extra: {
		annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
		writeCapability?: "read" | "write" | "destructive";
		transport?: string;
	} = {},
) {
	return {
		toolId,
		toolTypeId: "mcp",
		authRequired: true,
		annotations: extra.annotations,
		writeCapability: extra.writeCapability,
		config: {
			transport: extra.transport ?? "mcp",
			_sourceAppSlug: toolId.split("__")[0]?.replace(/_/g, "-"),
			_aggregateNamespace: toolId.split("__")[0],
		},
	};
}

const standard = [...CAPABILITY_PROFILES.standard];

describe("mounted external product tools", () => {
	it("resolves a declared read to mcp:content.read for a standard tedi", () => {
		const tool = mounted("notion_tedix__notion-search", {
			annotations: { readOnlyHint: true },
			writeCapability: "read",
		});
		const scopes = resolveMcpToolRequiredScopes(
			tool,
			"notion_tedix",
			gatewayConfig,
		);
		expect(scopes).toEqual(["mcp:content.read"]);
		expect(scopes.every((scope) => hasScope(standard, scope))).toBe(true);
	});

	it("resolves a declared write to mcp:content.write", () => {
		const tool = mounted("google_calendar_tedix__create_event", {
			annotations: { readOnlyHint: false },
			writeCapability: "write",
		});
		expect(
			resolveMcpToolRequiredScopes(
				tool,
				"google_calendar_tedix",
				gatewayConfig,
			),
		).toEqual(["mcp:content.write"]);
	});

	it("keeps destructive tools at admin tier", () => {
		const tool = mounted("notion_tedix__notion-delete-page", {
			annotations: { destructiveHint: true },
			writeCapability: "destructive",
		});
		const scopes = resolveMcpToolRequiredScopes(
			tool,
			"notion_tedix",
			gatewayConfig,
		);
		expect(scopes).toEqual(["mcp:content.admin"]);
		expect(hasScope(standard, "mcp:content.admin")).toBe(false);
	});

	it("keeps an unclassified verb at admin tier", () => {
		const tool = mounted("google_gmail_tedix__frobnicate");
		expect(
			resolveMcpToolRequiredScopes(tool, "google_gmail_tedix", gatewayConfig),
		).toEqual(["mcp:content.admin"]);
	});

	it("lets a gateway namespace key win over the default", () => {
		const tool = mounted("google_gmail_tedix__search_threads", {
			annotations: { readOnlyHint: true },
			writeCapability: "read",
		});
		expect(
			resolveMcpToolRequiredScopes(tool, "google_gmail_tedix", {
				...gatewayConfig,
				toolScopes: { google_gmail_tedix: ["mcp:messaging"] },
			}),
		).toEqual(["mcp:messaging.read"]);
	});

	it("still fails closed for an unmounted or internal tool", () => {
		const unmounted = {
			toolId: "third_party__frobnicate",
			toolTypeId: "mcp",
			authRequired: true,
			config: { transport: "mcp" },
		};
		expect(() =>
			resolveMcpToolRequiredScopes(unmounted, "third_party", gatewayConfig),
		).toThrow(/Missing MCP capability mapping/);

		const internal = mounted("third_party__frobnicate", { transport: "rpc" });
		expect(() =>
			resolveMcpToolRequiredScopes(internal, "third_party", gatewayConfig),
		).toThrow(/Missing MCP capability mapping/);
	});
});
