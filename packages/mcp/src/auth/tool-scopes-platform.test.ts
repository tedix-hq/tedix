import { describe, expect, it } from "vite-plus/test";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
} from "./tool-scopes";

describe("platform control-plane tool scopes", () => {
	it.each(["preview", "check", "run"])(
		"keeps catalog schema %s behind explicit platform authority",
		(operation) => {
			const tool = {
				toolId: "operator__schema_sync",
				toolTypeId: "rpc",
				config: { endpoint: `toolSchemaSync/${operation}` },
				authRequired: true,
			};
			expect(resolveMcpToolRequiredScopes(tool, "operator", undefined)).toEqual(
				["platform:admin"],
			);
			expect(
				isMcpToolVisibleToCaller(tool, "operator", undefined, {
					authType: "oauth",
					scopes: ["platform:admin"],
				}),
			).toBe(true);
			for (const scope of [
				"mcp:apps.read",
				"mcp:apps.write",
				"mcp:apps.admin",
			]) {
				expect(
					isMcpToolVisibleToCaller(tool, "operator", undefined, {
						authType: "oauth",
						scopes: [scope],
					}),
				).toBe(false);
			}
		},
	);
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

describe("owner-host session start scope", () => {
	it("keeps Work write authority under an organization aggregate alias", () => {
		const tool = {
			toolId: "example_org__start_external_agent_session_for_host",
			toolTypeId: "rpc",
			authRequired: true,
			config: {
				endpoint: "externalAgentIdentity/openOwnerHostSession",
				_aggregateNamespace: "example_org",
			},
			annotations: { readOnlyHint: false, destructiveHint: false },
		};
		expect(
			resolveMcpToolRequiredScopes(
				tool,
				"example_org",
				{ authMode: "authenticated" },
				{ fallbackOnAuthenticatedAuthMode: true },
			),
		).toEqual(["mcp:work.write"]);
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
		[
			"start_external_agent_session_for_host",
			"externalAgentIdentity/openOwnerHostSession",
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
