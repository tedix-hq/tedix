import { describe, expect, it } from "vite-plus/test";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
} from "./tool-scopes";

describe("platform control-plane tool scopes", () => {
	it("lets OS authors revise workspace resources without app administration", () => {
		for (const name of [
			"revise_os_output",
			"revise_os_gadget",
			"revise_os_blueprint",
		]) {
			expect(
				resolveMcpToolRequiredScopes(
					{ toolId: `os__${name}`, authRequired: true },
					"os",
					{ toolScopes: { "*": ["mcp:apps"] } },
				),
			).toEqual(["mcp:apps.write"]);
		}
		expect(
			resolveMcpToolRequiredScopes(
				{ toolId: "os__revise_unknown_resource", authRequired: true },
				"os",
				{ toolScopes: { "*": ["mcp:apps"] } },
			),
		).toEqual(["mcp:apps.admin"]);
	});

	it("classifies Descope AIH management as explicit platform authority", () => {
		expect(
			resolveMcpToolRequiredScopes(
				{
					toolId: "reconcile_mcp_app_servers",
					authRequired: true,
					visibility: "private",
				},
				"descope",
				{ authMode: "authenticated" },
				{ fallbackOnAuthenticatedAuthMode: true },
			),
		).toEqual(["platform:admin"]);
	});
});

describe("external-agent self lifecycle scopes", () => {
	const bindings = [
		["end_external_agent_session", "externalAgentIdentity/endSession"],
		[
			"record_external_agent_knowledge_checkpoint",
			"externalAgentIdentity/recordKnowledgeCheckpoint",
		],
		[
			"record_external_agent_knowledge_disposition",
			"externalAgentIdentity/recordKnowledgeDisposition",
		],
	] as const;
	it.each(bindings)(
		"allows the canonical %s RPC with Work write authority",
		(name, endpoint) => {
			const tool = {
				toolId: `external__${name}`,
				toolTypeId: "rpc",
				config: { endpoint, _aggregateNamespace: "external" },
				visibility: "private",
				annotations: { destructiveHint: true },
			};
			expect(
				resolveMcpToolRequiredScopes(tool, "external", {
					authMode: "authenticated",
				}),
			).toEqual(["mcp:work.write"]);
			expect(
				isMcpToolVisibleToCaller(tool, "external", undefined, {
					authType: "m2m",
					scopes: ["mcp:work.write"],
				}),
			).toBe(true);
			expect(
				isMcpToolVisibleToCaller(tool, "external", undefined, {
					authType: "m2m",
					scopes: ["mcp:work.read"],
				}),
			).toBe(false);
			for (const forged of [
				{ ...tool, toolTypeId: "rest" },
				{
					...tool,
					config: { endpoint: "externalAgentIdentity/retireAbandonedSession" },
				},
				{ ...tool, toolId: "retire_abandoned_external_agent_session" },
			]) {
				expect(
					isMcpToolVisibleToCaller(forged, "external", undefined, {
						authType: "m2m",
						scopes: ["mcp:work.write"],
					}),
				).toBe(false);
			}
		},
	);
	it.each([
		"retire_abandoned_external_agent_session",
		"revoke_external_agent_mcp_credential",
	])("keeps %s administrative", (toolId) => {
		expect(
			resolveMcpToolRequiredScopes(
				{
					toolId,
					visibility: "private",
					annotations: { destructiveHint: true },
				},
				"external",
				undefined,
			),
		).toEqual(["mcp:settings.admin"]);
	});
});
