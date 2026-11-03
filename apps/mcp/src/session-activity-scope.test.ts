import { expect, it } from "vite-plus/test";
import { resolveMcpToolRequiredScopes } from "@tedix/mcp-shared/auth/tool-scopes";

it("keeps session source readers in Work read scope through tenant aliases", () => {
	for (const [toolId, endpoint] of [
		["list_agent_session_activity", "workAgentSessions/listActivity"],
		["list_agent_session_events", "workAgentSessions/listEvents"],
		["list_office_operations", "workAgentSessions/listOperations"],
	] as const)
		for (const namespace of ["work", "example_org"])
			expect(
				resolveMcpToolRequiredScopes(
					{
						toolId,
						toolTypeId: "rpc",
						authRequired: true,
						config: { endpoint },
					},
					namespace,
					{ authMode: "authenticated", enforcePolicies: false },
				),
			).toEqual(["mcp:work.read"]);
});

it("keeps Office reporting in Work write scope through tenant aliases", () => {
	for (const namespace of ["work", "example_org"])
		expect(
			resolveMcpToolRequiredScopes(
				{
					toolId: "record_office_operation",
					toolTypeId: "rpc",
					authRequired: true,
					config: { endpoint: "workAgentSessions/recordOperation" },
				},
				namespace,
				{ authMode: "authenticated", enforcePolicies: false },
			),
		).toEqual(["mcp:work.write"]);
});
