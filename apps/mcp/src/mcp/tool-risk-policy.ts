import {
	parseToolPolicyMetadata,
	type ToolBlastRadius,
	type ToolOperationalRiskTier,
} from "@tedix/api-contract/schemas/tools";
import { serializeException } from "@tedix/worker-kit/logger";
import { createMcpLogger } from "../log";
import { redactRateLimitKey } from "../middleware/rate-limit";
import { normalizeCallerIdentity } from "./caller-identity";
import type { AppTool, ServerContext } from "./server-context";

const log = createMcpLogger("mcp.tool_risk");

export interface ToolRiskPolicy {
	riskTier: ToolOperationalRiskTier;
	blastRadius: ToolBlastRadius;
}

export function resolveToolRiskPolicy(
	tool: Pick<AppTool, "meta">,
): ToolRiskPolicy | null {
	const policy = parseToolPolicyMetadata(tool.meta as Record<string, unknown>);
	return policy?.riskTier && policy.blastRadius
		? { riskTier: policy.riskTier, blastRadius: policy.blastRadius }
		: null;
}

export function toolRiskAuditMetadata(
	tool: Pick<AppTool, "meta">,
): Record<string, string> {
	const policy = resolveToolRiskPolicy(tool);
	return policy
		? { riskTier: policy.riskTier, blastRadius: policy.blastRadius }
		: { riskTier: "unclassified", blastRadius: "unclassified" };
}

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

	return {
		content: [
			{
				type: "text",
				text: `Tool rate limit exceeded for ${policy.riskTier}. Retry later. No side effect was executed.`,
			},
		],
		isError: true,
		_meta: {
			"com.tedix/security": {
				denialReason: "tool_rate_limited",
				...policy,
			},
		},
	};
}
