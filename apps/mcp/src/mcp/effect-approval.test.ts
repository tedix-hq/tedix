import { resolveCodeModeInnerToolScopes } from "./codemode-auth";
import { resolveWireAnnotations } from "./tool-registration-policy";
import { toolApprovalMetadata } from "./tool-risk-policy";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	callToolResultText,
	requireDestructiveToolApproval,
} from "./governance";
import type { AppTool, ServerContext } from "./server-context";

import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_TASKS_EXTENSION,
} from "@tedix/mcp-shared/protocol";
const extra = {
	_meta: {
		[MCP_CLIENT_CAPABILITIES_META_KEY]: {
			extensions: { [MCP_TASKS_EXTENSION]: {} },
		},
	},
};
function context() {
	return {
		server: { server: { elicitInput: vi.fn() } },
		appSlug: "example",
		app: { organizationId: "org-1" },
		callerIdentity: { authType: "oauth", userId: "owner-1" },
		apiClient: {
			mcpGovernance: {
				resolveAgentTransportPolicy: vi.fn(async () => ({
					autonomy: { version: 1, maxRisk: "medium" },
				})),
				requestOwnerToolApproval: vi.fn(async () => ({
					approved: false,
					approvalRequestId: "approval-1",
					url: "https://os.example/work/approvals",
				})),
			},
		},
	} as unknown as ServerContext;
}
function tool(config: AppTool["config"]): AppTool {
	return {
		toolId: "example__action",
		title: "Action",
		config,
		meta: {},
		annotations: { destructiveHint: true },
	} as AppTool;
}
const gmail = tool({
	transport: "mcp",
	mcpToolName: "create_draft",
	auth: { type: "connection", connectionId: "google-gmail" },
});
const descope = tool({
	transport: "mcp",
	mcpToolName: "auth_keys_write",
	auth: { type: "connection", connectionId: "descope" },
});
const skill = tool({ transport: "rpc", endpoint: "skills/runWorkflow" });

describe("effect-based gateway approval", () => {
	it("projects Gmail drafts as bounded writes in discovery and scopes", () => {
		expect(resolveWireAnnotations(gmail)).toMatchObject({
			destructiveHint: false,
			readOnlyHint: false,
		});
		expect(toolApprovalMetadata(gmail)["com.tedix/policy"]).toMatchObject({
			riskTier: "bounded_write",
		});
		expect(resolveCodeModeInnerToolScopes(gmail, "mail", undefined)).toEqual([
			"connections.execute",
		]);
	});
	it("classifies Descope scope by the operation at dispatch", () => {
		expect(
			resolveCodeModeInnerToolScopes(descope, "descope", undefined, {
				arguments: { operation: "SearchAccessKeys" },
			}),
		).toEqual(["connections.read"]);
		expect(
			resolveCodeModeInnerToolScopes(descope, "descope", undefined, {
				arguments: { operation: "DeleteAccessKey" },
			}),
		).toEqual(["connections.execute", "connections.admin"]);
		expect(
			resolveCodeModeInnerToolScopes(descope, "descope", undefined),
		).toEqual(["connections.execute", "connections.admin"]);
	});
	it("uses a server-approved exact retry without elicitation", async () => {
		const ctx = context();
		vi.mocked(
			ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
		).mockResolvedValue({
			approved: true,
			approvalRequestId: "approval-1",
			status: "consumed",
			url: "https://os.example/work/approvals",
		});
		expect(
			await requireDestructiveToolApproval(ctx, descope, descope.annotations, {
				args: { operation: "DeleteAccessKey" },
				extra: {
					_meta: {
						...extra._meta,
						"com.tedix/approvalRequestId": "approval-1",
					},
				},
			}),
		).toBeNull();
		expect(
			ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalRequestId: "approval-1",
				args: { operation: "DeleteAccessKey" },
			}),
		);
	});
	it.each([
		[skill, { certification: true, skillId: "skill-1" }],
		[gmail, { subject: "Draft about deleting keys and sending money" }],
		[descope, { operation: "SearchAccessKeys", args: {} }],
	])("permits the reviewed effect %j", async (target, args) => {
		expect(
			await requireDestructiveToolApproval(
				context(),
				target,
				target.annotations,
				{ args, extra },
			),
		).toBeNull();
	});
	it.each([
		[skill, { certification: false }],
		[descope, { operation: "CreateAccessKey" }],
		[descope, { operation: "DeleteAccessKey" }],
		[
			descope,
			{ operation: "SearchAccessKeys", operations: ["DeleteAccessKey"] },
		],
		[tool({ ...gmail.config, mcpToolName: "send" }), {}],
		[tool({ ...gmail.config, mcpToolName: "delete" }), {}],
		[tool({ transport: "rpc", endpoint: "payments/transfer" }), {}],
		[tool({ transport: "rpc", endpoint: "connections/consent" }), {}],
	])("parks genuine or unreviewed effects %j", async (target, args) => {
		const ctx = context();
		const result = await requireDestructiveToolApproval(
			ctx,
			target,
			target.annotations,
			{ args, extra },
		);
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("approval-1");
		expect(callToolResultText(result!)).toContain(
			"https://os.example/work/approvals",
		);
		expect(
			ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
		).toHaveBeenCalled();
	});
	// Live 24 Oct 2026: an owner starting a tenant skill through skills.* (served
	// by the public tedix app, owned by the platform organization) got "Owner
	// tool approval is unavailable", because the request named the app owner's
	// organization and the API refused the mismatch.
	it("parks a tenant owner's call on the public platform app in the tenant", async () => {
		const ctx = context();
		Object.assign(ctx, {
			appSlug: "tedix",
			app: { organizationId: "org-platform", visibility: "public" },
			callerIdentity: {
				authType: "oauth",
				userId: "owner-1",
				organizationId: "org-tenant",
			},
		});
		const result = await requireDestructiveToolApproval(
			ctx,
			skill,
			skill.annotations,
			{ args: { skillId: "skill-1" }, extra },
		);
		expect(callToolResultText(result!)).toContain("approval-1");
		expect(
			ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
		).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-tenant" }),
		);
	});
	it("keeps a private app's approval in its own organization", async () => {
		const ctx = context();
		Object.assign(ctx, {
			app: { organizationId: "org-1", visibility: "private" },
			callerIdentity: {
				authType: "oauth",
				userId: "owner-1",
				organizationId: "org-tenant",
			},
		});
		const result = await requireDestructiveToolApproval(
			ctx,
			skill,
			skill.annotations,
			{ args: { skillId: "skill-1" }, extra },
		);
		expect(result?.isError).toBe(true);
		expect(
			ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
		).not.toHaveBeenCalled();
	});
	it("never turns a lookalike provider into a reviewed draft", async () => {
		const target = tool({
			...gmail.config,
			auth: { type: "connection", connectionId: "unreviewed" },
		});
		expect(
			(
				await requireDestructiveToolApproval(
					context(),
					target,
					target.annotations,
					{ extra },
				)
			)?.isError,
		).toBe(true);
	});
	it("preserves explicit approval on drafts", async () => {
		const target = {
			...gmail,
			config: { ...gmail.config, approvalPolicy: "always" as const },
		};
		expect(
			(
				await requireDestructiveToolApproval(
					context(),
					target,
					target.annotations,
					{ extra },
				)
			)?.isError,
		).toBe(true);
	});
});
