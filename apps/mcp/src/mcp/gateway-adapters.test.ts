/**
 * The same call through the gateway adapters and through `wrapBinding` with
 * the in-memory adapters must produce the same decision and the same ledger
 * row shape, so a workspace object binding and an MCP tool are governed alike.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { createInMemoryAdapters } from "@tedix/agent-governance/in-memory";
import type {
	ChangeRecord,
	ComplianceDecision,
} from "@tedix/agent-governance/types";
import {
	CallRefusedError,
	wrapBinding,
} from "@tedix/agent-governance/wrap-binding";
import { admitGatewayCall, guardGatewayCall } from "./gateway-adapters";
import type { ServerContext } from "./server-context";

const limiterSuccess = { limit: vi.fn(async () => ({ success: true })) };
const limiterExhausted = { limit: vi.fn(async () => ({ success: false })) };

function gatewayContext(options: {
	elicit?: (params: unknown) => Promise<unknown>;
	limiter?: typeof limiterSuccess;
	authType?: "user" | "tedi";
}) {
	const elicitInput = options.elicit ?? vi.fn();
	return {
		server: { server: { elicitInput } },
		env: {
			MCP_WRITE_RATE_LIMITER: options.limiter ?? limiterSuccess,
			MCP_HIGH_RISK_RATE_LIMITER: options.limiter ?? limiterSuccess,
		},
		app: { organizationId: "org-1" },
		appSlug: "crm",
		traceId: "trace-1",
		callerIdentity:
			options.authType === "tedi"
				? { authType: "tedi", tediId: "tedi-1" }
				: { authType: "user", userId: "user-1" },
		...(options.authType === "tedi"
			? {
					apiClient: {
						mcpGovernance: {
							resolveAgentTransportPolicy: vi.fn(async () => ({
								requireExplicitApprovalPolicy: false,
							})),
						},
					},
				}
			: {}),
	} as unknown as ServerContext;
}

function gatewayTool(
	toolId: string,
	riskTier: string,
	blastRadius: string,
	destructive = false,
) {
	return {
		toolId,
		title: toolId,
		inputSchema: { type: "object", properties: { id: { type: "string" } } },
		meta: { "com.tedix/policy": { riskTier, blastRadius } },
		...(destructive ? { writeCapability: "destructive" } : {}),
	} as never;
}

/** The same call through `wrapBinding` with the in-memory adapters. */
async function bindingDecision(
	toolId: string,
	riskTier: "read" | "bounded_write" | "high_impact_write",
	blastRadius: "none" | "single_resource" | "tenant",
	options: {
		destructive?: boolean;
		approval?: "granted" | "denied";
		exhausted?: boolean;
		actorKind?: "user" | "tedi";
	} = {},
): Promise<{ decision: ComplianceDecision; record: ChangeRecord }> {
	const adapters = createInMemoryAdapters({
		policies: {
			[`tool:${toolId}`]: {
				riskTier,
				blastRadius,
				destructive: options.destructive,
			},
		},
		approvedRequestIds: new Set(
			options.approval === "granted" ? ["req-1"] : [],
		),
		deniedRequestIds: new Set(options.approval === "denied" ? ["req-1"] : []),
	});
	if (options.exhausted) {
		const budget = riskTier === "bounded_write" ? 30 : 5;
		for (let i = 0; i < budget; i++) {
			await adapters.compliance.check({
				resource: `tool:${toolId}`,
				operation: toolId,
				args: {},
				actor: { id: "user-1", kind: "user", organizationId: "org-1" },
				source: { surface: "workspace_object" },
			});
		}
	}
	const binding = wrapBinding(
		{ [toolId]: async (_args: unknown) => ({ ok: true }) },
		{
			...adapters,
			actor: {
				id: options.actorKind === "tedi" ? "tedi-1" : "user-1",
				kind: options.actorKind ?? "user",
				organizationId: "org-1",
			},
			source: { surface: "workspace_object", traceId: "trace-1" },
			resource: `tool:${toolId}`,
			methods: {
				[toolId]: {
					resource: `tool:${toolId}`,
					riskTier,
					blastRadius,
					...(options.destructive ? { destructive: true } : {}),
				},
			},
		},
	);
	// The in-memory adapter reads the receipt from the call description; the
	// Proxy has no receipt channel, so pass it through a direct check when set.
	if (options.approval) {
		const call = {
			resource: `tool:${toolId}`,
			operation: toolId,
			args: [{ id: "one" }],
			actor: { id: "user-1", kind: "user" as const, organizationId: "org-1" },
			source: { surface: "workspace_object", traceId: "trace-1" },
			riskTier,
			blastRadius,
			destructive: true,
			approvalRequestId: "req-1",
		};
		const decision = await adapters.compliance.check(call);
		const record = await adapters.accountability.append({
			resource: call.resource,
			operation: call.operation,
			actor: call.actor,
			source: call.source,
			decision,
			argsHash: "",
			outcome:
				decision.verdict === "allow"
					? "applied"
					: decision.verdict === "deny"
						? "denied"
						: "needs_approval",
		});
		return { decision, record };
	}
	try {
		await binding[toolId]!({ id: "one" });
	} catch (error) {
		if (error instanceof CallRefusedError) {
			return { decision: error.decision, record: error.record };
		}
		throw error;
	}
	const [record] = await adapters.accountability.list();
	return { decision: record!.decision, record: record! };
}

function comparable(decision: ComplianceDecision) {
	return decision;
}

describe("gateway adapters decide like wrapBinding", () => {
	it("allows a read on both paths", async () => {
		const gateway = await guardGatewayCall(
			{
				agent: gatewayContext({}),
				tool: gatewayTool("get_customer", "read", "none"),
				annotations: { readOnlyHint: true, destructiveHint: false },
				args: { id: "one" },
			},
			async () => ({ content: [{ type: "text", text: "ok" }] }),
		);
		const binding = await bindingDecision("get_customer", "read", "none");
		expect(gateway.failure).toBeNull();
		expect(comparable(gateway.decision)).toEqual(comparable(binding.decision));
		expect(gateway.record.outcome).toBe(binding.record.outcome);
	});

	it("allows a bounded write under budget with the same budget and rate state", async () => {
		const gateway = await guardGatewayCall(
			{
				agent: gatewayContext({}),
				tool: gatewayTool(
					"update_customer",
					"bounded_write",
					"single_resource",
				),
				annotations: { destructiveHint: false },
				args: { id: "one" },
			},
			async () => ({ content: [{ type: "text", text: "ok" }] }),
		);
		const binding = await bindingDecision(
			"update_customer",
			"bounded_write",
			"single_resource",
		);
		expect(gateway.decision).toEqual(binding.decision);
		expect(gateway.decision.budget).toEqual({ limit: 30, windowSeconds: 60 });
	});

	it("rate-limits an exhausted write identically", async () => {
		const gateway = await guardGatewayCall(
			{
				agent: gatewayContext({ limiter: limiterExhausted }),
				tool: gatewayTool(
					"update_customer",
					"bounded_write",
					"single_resource",
				),
				annotations: { destructiveHint: false },
				args: { id: "one" },
			},
			async () => {
				throw new Error("must not execute");
			},
		);
		const binding = await bindingDecision(
			"update_customer",
			"bounded_write",
			"single_resource",
			{
				exhausted: true,
			},
		);
		expect(gateway.failure?.isError).toBe(true);
		expect(gateway.decision).toEqual(binding.decision);
		expect(gateway.decision).toMatchObject({
			verdict: "deny",
			gate: "risk_rate_limit",
			rate: { limited: true, retryAfterSeconds: 60 },
		});
		expect(gateway.record.outcome).toBe("denied");
		expect(binding.record.outcome).toBe("denied");
	});

	it("holds a destructive call for an agent until approved, on both paths", async () => {
		const admission = await admitGatewayCall({
			agent: gatewayContext({ authType: "tedi" }),
			tool: gatewayTool("delete_customer", "high_impact_write", "tenant", true),
			annotations: { destructiveHint: true },
			args: { id: "one" },
			surface: "mcp_codemode",
		});
		const binding = await bindingDecision(
			"delete_customer",
			"high_impact_write",
			"tenant",
			{
				destructive: true,
				actorKind: "tedi",
			},
		);
		expect(admission.failure?._meta?.["tedix/inputRequired"]).toBeDefined();
		expect(admission.decision).toEqual({
			...binding.decision,
			approvalRoute: "agent",
		});
		expect(admission.decision.verdict).toBe("needs_approval");
		expect(await admission.settle({ status: "applied" })).toBeNull();
	});

	it("allows a destructive call once the approver accepted with a reason", async () => {
		const gateway = await guardGatewayCall(
			{
				agent: gatewayContext({
					elicit: async () => ({
						action: "accept",
						content: { reason: "owner asked" },
					}),
				}),
				tool: gatewayTool(
					"delete_customer",
					"high_impact_write",
					"tenant",
					true,
				),
				annotations: { destructiveHint: true },
				args: { id: "one" },
			},
			async (executionArgs) => ({
				content: [{ type: "text", text: JSON.stringify(executionArgs) }],
			}),
		);
		const binding = await bindingDecision(
			"delete_customer",
			"high_impact_write",
			"tenant",
			{
				destructive: true,
				approval: "granted",
			},
		);
		expect(gateway.decision).toEqual(binding.decision);
		expect(gateway.decision).toMatchObject({
			verdict: "allow",
			gate: "destructive_approval",
			reason: "destructive_approved",
		});
		expect(gateway.record.outcome).toBe("applied");
	});

	it("denies a destructive call the approver declined, on both paths", async () => {
		const gateway = await guardGatewayCall(
			{
				agent: gatewayContext({ elicit: async () => ({ action: "decline" }) }),
				tool: gatewayTool(
					"delete_customer",
					"high_impact_write",
					"tenant",
					true,
				),
				annotations: { destructiveHint: true },
				args: { id: "one" },
			},
			async () => {
				throw new Error("must not execute");
			},
		);
		const binding = await bindingDecision(
			"delete_customer",
			"high_impact_write",
			"tenant",
			{
				destructive: true,
				approval: "denied",
			},
		);
		expect(gateway.decision).toEqual(binding.decision);
		expect(gateway.decision).toMatchObject({
			verdict: "deny",
			gate: "destructive_approval",
			reason: "destructive_denied",
		});
	});

	it("records a failed execution as not_applied without refusing it", async () => {
		const gateway = await guardGatewayCall(
			{
				agent: gatewayContext({}),
				tool: gatewayTool("get_customer", "read", "none"),
				annotations: { readOnlyHint: true },
				args: {},
			},
			async () => ({
				isError: true,
				content: [{ type: "text", text: "upstream 502" }],
			}),
		);
		expect(gateway.failure).toBeNull();
		expect(gateway.result?.isError).toBe(true);
		expect(gateway.record.outcome).toBe("not_applied");
	});
});
