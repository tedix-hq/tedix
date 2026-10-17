import { expect, it } from "vite-plus/test";
import { resolveMcpToolRequiredScopes } from "@tedix/mcp-shared/auth/tool-scopes";

it("keeps the session activity reader in Work read scope through tenant aliases", () => {
	for (const namespace of ["work", "example_org"]) {
		expect(
			resolveMcpToolRequiredScopes(
				{
					toolId: "list_agent_session_activity",
					toolTypeId: "rpc",
					authRequired: true,
					config: { endpoint: "workAgentSessions/listActivity" },
				},
				namespace,
				{ authMode: "authenticated", enforcePolicies: false },
			),
		).toEqual(["mcp:work.read"]);
	}
});
