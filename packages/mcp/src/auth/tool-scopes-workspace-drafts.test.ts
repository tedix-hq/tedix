import { describe, expect, it } from "vite-plus/test";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
} from "./tool-scopes";

const operations = [
	[
		"getWorkspaceDraftGrant",
		"get_workspace_draft_grant",
		"mcp:apps.read",
		true,
	],
	[
		"getWorkspaceDraftProposal",
		"get_workspace_draft_proposal",
		"mcp:apps.read",
		true,
	],
	[
		"listWorkspaceDraftProposals",
		"list_workspace_draft_proposals",
		"mcp:apps.read",
		true,
	],
	[
		"proposeWorkspaceRevision",
		"propose_workspace_revision",
		"mcp:skills.write",
		false,
	],
	[
		"setWorkspaceDraftGrant",
		"set_workspace_draft_grant",
		"mcp:settings.admin",
		false,
	],
	[
		"withdrawWorkspaceDraftProposal",
		"withdraw_workspace_draft_proposal",
		"mcp:skills.write",
		false,
	],
] as const;

describe("workspace skill draft MCP scope floors", () => {
	it.each(["tedix_unified", "skills", "os"])(
		"retains exact endpoint authority in the %s namespace",
		(namespace) => {
			for (const [operation, name, scope, readOnlyHint] of operations) {
				const tool = {
					toolId: `${namespace}__${name}`,
					toolTypeId: "rpc",
					authRequired: true,
					config: { endpoint: `skills/${operation}` },
					annotations: { readOnlyHint },
				};
				expect(
					resolveMcpToolRequiredScopes(
						tool,
						namespace,
						{ enforcePolicies: false, authMode: "authenticated" },
						{ fallbackOnAuthenticatedAuthMode: true },
					),
				).toEqual([scope]);
			}
		},
	);

	it.each(["tedix_unified", "skills"])(
		"never exposes access changes to a skills writer in the %s namespace",
		(namespace) => {
			const tool = {
				toolId: `${namespace}__set_workspace_draft_grant`,
				toolTypeId: "rpc",
				authRequired: true,
				config: { endpoint: "skills/setWorkspaceDraftGrant" },
				annotations: { readOnlyHint: false },
			};
			for (const [scopes, allowed] of [
				[["mcp:skills.write"], false],
				[["mcp:settings.write"], false],
				[["mcp:settings.admin"], true],
			] as const) {
				expect(
					isMcpToolVisibleToCaller(
						tool,
						namespace,
						{},
						{ authType: "oauth", scopes: [...scopes] },
					),
				).toBe(allowed);
			}
		},
	);
});
