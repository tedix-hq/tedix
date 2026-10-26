import { gateDecisionMetadata } from "./gate-decision";
import { reviewedConnectedEffect } from "@tedix/api-contract/utils/approval-policy";
import {
	parseToolPolicyMetadata,
	type ToolBlastRadius,
	type ToolOperationalRiskTier,
} from "@tedix/api-contract/schemas/tools";
import { serializeException } from "@tedix/worker-kit/logger";
import { createMcpLogger } from "../log";
import { redactRateLimitKey } from "../middleware/rate-limit";
import { normalizeCallerIdentity } from "./caller-identity";
import { connectedProviderId } from "@tedix/mcp-shared/auth/tool-scopes";
import type { AppTool, ServerContext } from "./server-context";

const log = createMcpLogger("mcp.tool_risk");

export interface ToolRiskPolicy {
	riskTier: ToolOperationalRiskTier;
	blastRadius: ToolBlastRadius;
	argumentPolicy?: "notion_page_update";
}

export function resolveToolRiskPolicy(
	tool: Pick<AppTool, "meta">,
): ToolRiskPolicy | null {
	const policy = parseToolPolicyMetadata(tool.meta as Record<string, unknown>);
	return policy?.riskTier && policy.blastRadius
		? {
				riskTier: policy.riskTier,
				blastRadius: policy.blastRadius,
				...(policy.argumentPolicy
					? { argumentPolicy: policy.argumentPolicy }
					: {}),
			}
		: null;
}

/** The bounded approval facts shared by native and Code Mode discovery. */
export function toolApprovalMetadata(
	tool: Pick<AppTool, "toolId" | "config" | "meta">,
): Record<string, unknown> {
	const providerId = connectedProviderId(tool);
	const effect =
		tool.config?.transport === "mcp"
			? reviewedConnectedEffect({
					providerId,
					toolName:
						typeof tool.config.mcpToolName === "string"
							? tool.config.mcpToolName
							: undefined,
				})
			: undefined;
	const policy = effect
		? { riskTier: effect, blastRadius: "single_resource" }
		: resolveToolRiskPolicy(tool);
	return {
		...(policy ? { "com.tedix/policy": policy } : {}),
		...(providerId &&
		tool.config?.transport === "mcp" &&
		typeof tool.config.mcpToolName === "string"
			? {
					"com.tedix/connectedTool": {
						providerId,
						toolName: tool.config.mcpToolName,
					},
				}
			: {}),
	};
}

export function toolRiskAuditMetadata(
	tool: Pick<AppTool, "meta">,
): Record<string, string> {
	const policy = resolveToolRiskPolicy(tool);
	return policy
		? { riskTier: policy.riskTier, blastRadius: policy.blastRadius }
		: { riskTier: "unclassified", blastRadius: "unclassified" };
}

/** Mirrors `MCP_WRITE_RATE_LIMITER` and `MCP_HIGH_RISK_RATE_LIMITER` in cloudflare.config.ts. */
const WRITE_BUDGET = { limit: 30, windowSeconds: 60 };
const HIGH_RISK_BUDGET = { limit: 5, windowSeconds: 60 };
const RISK_TIER_BUDGETS: Record<
	Exclude<ToolOperationalRiskTier, "read">,
	{ limit: number; windowSeconds: number }
> = {
	bounded_write: WRITE_BUDGET,
	high_impact_write: HIGH_RISK_BUDGET,
	external_side_effect: HIGH_RISK_BUDGET,
};

type RiskRateLimiter = {
	limit(options: { key: string }): Promise<{ success: boolean }>;
};

function limiterForTier(
	env: CloudflareEnv,
	tier: ToolOperationalRiskTier,
): RiskRateLimiter | undefined {
	const bindings = env as CloudflareEnv & {
		MCP_WRITE_RATE_LIMITER?: RiskRateLimiter;
		MCP_HIGH_RISK_RATE_LIMITER?: RiskRateLimiter;
	};
	return tier === "bounded_write"
		? bindings.MCP_WRITE_RATE_LIMITER
		: tier === "high_impact_write" || tier === "external_side_effect"
			? bindings.MCP_HIGH_RISK_RATE_LIMITER
			: undefined;
}

export async function enforceToolRiskRateLimit(
	agent: ServerContext,
	tool: AppTool,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	isError: true;
	_meta: Record<string, unknown>;
} | null> {
	const policy = resolveToolRiskPolicy(tool);
	if (!policy || policy.riskTier === "read") return null;
	const limiter = limiterForTier(agent.env, policy.riskTier);
	if (!limiter) return null;

	const caller = normalizeCallerIdentity(
		agent.callerIdentity ?? { authType: "anonymous" },
	);
	const actorId = caller.actorId ?? "anonymous";
	const key = [
		agent.app?.organizationId ?? "unknown-org",
		actorId,
		agent.appSlug ?? "unknown-app",
		tool.toolId,
	].join(":");

	try {
		const { success } = await limiter.limit({ key });
		if (success) return null;
	} catch (error) {
		log.error("Tool risk rate limiter failed; allowing request", {
			event: "tool_risk.rate_limit_unavailable",
			appId: agent.appId,
			toolName: tool.toolId,
			traceId: agent.traceId,
			outcome: "unavailable",
			error: redactRateLimitKey(serializeException(error), key),
		});
		return null;
	}

	const budget = RISK_TIER_BUDGETS[policy.riskTier];
	return {
		content: [
			{
				type: "text",
				text: `Tool rate limit exceeded for ${policy.riskTier}: each ${policy.riskTier} tool allows ${budget.limit} calls per ${budget.windowSeconds} seconds for one caller in this organization (per-tool risk limiter, keyed by organization, caller, app and tool). No side effect was executed for this call. Wait ${budget.windowSeconds} seconds (retryAfter: ${budget.windowSeconds}) before calling ${tool.toolId} again and retry only the calls that did not succeed; other tools have their own budgets.`,
			},
		],
		isError: true,
		_meta: {
			"com.tedix/security": {
				...gateDecisionMetadata("risk_rate_limit", "deny", "tool_rate_limited"),
				denialReason: "tool_rate_limited",
				...policy,
				rateLimit: {
					limiter: "tool_risk",
					scope: "organization_caller_app_tool",
					limit: budget.limit,
					windowSeconds: budget.windowSeconds,
					// The limiter binding reports no reset time; one full window is
					// the conservative wait.
					retryAfterSeconds: budget.windowSeconds,
				},
			},
		},
	};
}
