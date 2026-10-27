import { expect, it } from "vite-plus/test";
import { resolveMcpToolRequiredScopes } from "@tedix/mcp-shared/auth/tool-scopes";

it("keeps session source readers in Work read scope through tenant aliases", () => {
	for (const [toolId, endpoint] of [
		["list_agent_session_activity", "workAgentSessions/listActivity"],
		["list_agent_session_events", "workAgentSessions/listEvents"],
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
