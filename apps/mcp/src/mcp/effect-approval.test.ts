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
	// Live 25 Oct: an owner's certification run of a draft and the activation
	// of the certified improvement parked behind MCP_INPUT_REQUIRED in an
	// organization without explicit autonomy.
	it.each([
		[skill, { certification: true, skillId: "draft-1", tediId: "tedi-1" }],
		[
			{
				...tool({
					transport: "rpc",
					endpoint: "skills/activateWorkflowImprovement",
				}),
				toolId: "activate_skill_workflow_improvement",
				annotations: { destructiveHint: false },
			},
			{ id: "draft-1", certificationRunId: "run-1", reason: "certified" },
		],
	])(
		"lets the owner's skill operation %# run under the platform default",
		async (target, args) => {
			const ctx = context();
			vi.mocked(
				ctx.apiClient.mcpGovernance.resolveAgentTransportPolicy,
			).mockResolvedValue({ requireExplicitApprovalPolicy: false });
			expect(
				await requireDestructiveToolApproval(ctx, target, target.annotations, {
					args,
					extra,
				}),
			).toBeNull();
			expect(
				ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
			).not.toHaveBeenCalled();
		},
	);
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
	it("says when an approval was already used and explains a refusal", async () => {
		const ctx = context();
		vi.mocked(
			ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
		).mockResolvedValueOnce({
			approved: false,
			approvalRequestId: "approval-1",
			status: "executed",
			url: "https://os.example/work/approvals",
		});
		const retry = {
			args: { operation: "DeleteAccessKey" },
			extra: {
				_meta: { ...extra._meta, "com.tedix/approvalRequestId": "approval-1" },
			},
		};
		const used = await requireDestructiveToolApproval(
			ctx,
			descope,
			descope.annotations,
			retry,
		);
		expect(callToolResultText(used!)).toContain("already used (executed)");
		vi.mocked(
			ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
		).mockRejectedValueOnce(
			Object.assign(
				new Error(
					"Approval approval-1 is for a different call (arguments differ)",
				),
				{ code: "FORBIDDEN" },
			),
		);
		const refused = await requireDestructiveToolApproval(
			ctx,
			descope,
			descope.annotations,
			retry,
		);
		expect(callToolResultText(refused!)).toContain(
			"FORBIDDEN: Approval approval-1 is for a different call (arguments differ)",
		);
	});
	describe("platform replay of an owner approval", () => {
		function replayContext(approved: boolean) {
			const ctx = context();
			// The gateway binds a kernel caller to the requester's primary tedi.
			(ctx as { callerIdentity: unknown }).callerIdentity = {
				authType: "service",
				kernel: true,
				userId: "owner-1",
				tediId: "tedi-primary-1",
			};
			vi.mocked(
				ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
			).mockResolvedValue({
				approved,
				approvalRequestId: "approval-1",
				status: approved ? "consumed" : "expired",
				url: "https://os.example/work/approvals",
			});
			return ctx;
		}
		const replay = {
			args: { operation: "DeleteAccessKey" },
			extra: { _meta: { "com.tedix/approvalRequestId": "approval-1" } },
		};
		it("consumes the approval for the requester and lets the call run", async () => {
			const ctx = replayContext(true);
			expect(
				await requireDestructiveToolApproval(
					ctx,
					descope,
					descope.annotations,
					replay,
				),
			).toBeNull();
			expect(
				ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "owner-1",
					approvalRequestId: "approval-1",
					args: { operation: "DeleteAccessKey" },
				}),
			);
			expect(
				ctx.apiClient.mcpGovernance.resolveAgentTransportPolicy,
			).not.toHaveBeenCalled();
		});
		it("never runs an expired, rejected or already used approval", async () => {
			const ctx = replayContext(false);
			const result = await requireDestructiveToolApproval(
				ctx,
				descope,
				descope.annotations,
				replay,
			);
			expect(result?.isError).toBe(true);
			expect(callToolResultText(result!)).toContain("did not run");
		});
		it("takes no replay without the kernel marker or an acting user", async () => {
			const ctx = replayContext(true);
			(ctx as { callerIdentity: unknown }).callerIdentity = {
				authType: "service",
				userId: "owner-1",
			};
			const result = await requireDestructiveToolApproval(
				ctx,
				descope,
				descope.annotations,
				replay,
			);
			expect(result?.isError).toBe(true);
			expect(
				ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
			).not.toHaveBeenCalled();
		});
	});
	describe("owner start of an active skill", () => {
		function ownerStartContext(approved: boolean) {
			const ctx = context();
			Object.assign(ctx.apiClient.mcpGovernance, {
				resolveOwnerSkillStart: vi.fn(async () => ({
					approved,
					...(approved ? { skillId: "skill-1", revision: 3 } : {}),
				})),
			});
			return ctx;
		}
		const args = {
			skillId: "skill-1",
			confirmDestructive: true,
			reason: "tedix flow run: existing skill",
		};
		it("starts directly without parking an approval", async () => {
			const ctx = ownerStartContext(true);
			expect(
				await requireDestructiveToolApproval(ctx, skill, skill.annotations, {
					args,
				}),
			).toBeNull();
			expect(
				ctx.apiClient.mcpGovernance.resolveOwnerSkillStart,
			).toHaveBeenCalledWith({
				organizationId: "org-1",
				userId: "owner-1",
				skillId: "skill-1",
			});
			expect(
				ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
			).not.toHaveBeenCalled();
		});
		it("parks when the API does not confirm an active owned skill", async () => {
			const ctx = ownerStartContext(false);
			const result = await requireDestructiveToolApproval(
				ctx,
				skill,
				skill.annotations,
				{ args },
			);
			expect(callToolResultText(result!)).toContain("approval-1");
		});
		it.each([
			["a tedi", { authType: "tedi", userId: "owner-1", tediId: "tedi-1" }],
			[
				"an external agent",
				{
					authType: "oauth",
					userId: "owner-1",
					externalAgentPrincipalId: "agent-1",
				},
			],
		])("never applies to %s", async (_label, callerIdentity) => {
			const ctx = ownerStartContext(true);
			Object.assign(ctx, { callerIdentity });
			// An organization that opted out of the platform default.
			vi.mocked(
				ctx.apiClient.mcpGovernance.resolveAgentTransportPolicy,
			).mockResolvedValue({
				requireExplicitApprovalPolicy: false,
				platformAutonomy: false,
			});
			expect(
				(
					await requireDestructiveToolApproval(ctx, skill, skill.annotations, {
						args,
						extra,
					})
				)?.isError,
			).toBe(true);
			expect(
				ctx.apiClient.mcpGovernance.resolveOwnerSkillStart,
			).not.toHaveBeenCalled();
		});
		it("keeps an external agent's run start gated under the platform default", async () => {
			const ctx = ownerStartContext(true);
			Object.assign(ctx, {
				callerIdentity: {
					authType: "oauth",
					userId: "owner-1",
					externalAgentPrincipalId: "agent-1",
				},
			});
			vi.mocked(
				ctx.apiClient.mcpGovernance.resolveAgentTransportPolicy,
			).mockResolvedValue({ requireExplicitApprovalPolicy: false });
			expect(
				(
					await requireDestructiveToolApproval(ctx, skill, skill.annotations, {
						args,
						extra,
					})
				)?.isError,
			).toBe(true);
		});
		it.each([
			["a tedi", { authType: "tedi", userId: "owner-1", tediId: "tedi-1" }],
		])(
			"lets %s start a run under the platform default",
			async (_label, callerIdentity) => {
				const ctx = ownerStartContext(true);
				Object.assign(ctx, { callerIdentity });
				vi.mocked(
					ctx.apiClient.mcpGovernance.resolveAgentTransportPolicy,
				).mockResolvedValue({ requireExplicitApprovalPolicy: false });
				const record = vi.fn(async () => ({ approvalRequestId: null }));
				Object.assign(ctx.apiClient.mcpGovernance, {
					recordPolicyToolApproval: record,
				});
				expect(
					await requireDestructiveToolApproval(ctx, skill, skill.annotations, {
						args,
						extra,
					}),
				).toBeNull();
				expect(
					ctx.apiClient.mcpGovernance.requestOwnerToolApproval,
				).not.toHaveBeenCalled();
				// Recorded as an approved policy row so Activity lists it.
				expect(record).toHaveBeenCalledWith(
					expect.objectContaining({
						organizationId: "org-1",
						toolId: skill.toolId,
						operationId: "runs",
						reason: "Starting runs run without approval (platform default)",
					}),
				);
			},
		);
		it("keeps a configured approval policy", async () => {
			const ctx = ownerStartContext(true);
			const target = {
				...skill,
				config: { ...skill.config, approvalPolicy: "always" as const },
			};
			expect(
				(
					await requireDestructiveToolApproval(
						ctx,
						target,
						target.annotations,
						{ args },
					)
				)?.isError,
			).toBe(true);
			expect(
				ctx.apiClient.mcpGovernance.resolveOwnerSkillStart,
			).not.toHaveBeenCalled();
		});
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
