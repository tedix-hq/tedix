import { describe, expect, it, vi } from "vite-plus/test";
import {
	enforceToolRiskRateLimit,
	resolveToolRiskPolicy,
	toolRiskAuditMetadata,
} from "./tool-risk-policy";

function tool(riskTier?: string, blastRadius?: string) {
	return {
		toolId: "update_customer",
		meta:
			riskTier && blastRadius
				? {
						"com.tedix/policy": { riskTier, blastRadius },
					}
				: null,
	} as never;
}

function context(limit: ReturnType<typeof vi.fn>) {
	return {
		env: {
			MCP_WRITE_RATE_LIMITER: { limit },
			MCP_HIGH_RISK_RATE_LIMITER: { limit },
		},
		app: { organizationId: "org-1" },
		appSlug: "crm",
		callerIdentity: { authType: "user", userId: "user-1" },
	} as never;
}

describe("tool risk policy", () => {
	it("reads the canonical D1-backed policy metadata", () => {
		expect(
			resolveToolRiskPolicy(tool("bounded_write", "single_resource")),
		).toEqual({
			riskTier: "bounded_write",
			blastRadius: "single_resource",
		});
		expect(toolRiskAuditMetadata(tool())).toEqual({
			riskTier: "unclassified",
			blastRadius: "unclassified",
		});
	});

	it("rate limits a write by organization, actor, app, and tool", async () => {
		const limit = vi.fn().mockResolvedValue({ success: false });
		const result = await enforceToolRiskRateLimit(
			context(limit),
			tool("bounded_write", "single_resource"),
		);

		expect(limit).toHaveBeenCalledWith({
			key: "org-1:user-1:crm:update_customer",
		});
		expect(result).toMatchObject({
			isError: true,
			_meta: {
				"com.tedix/security": {
					gate: "risk_rate_limit",
					gateDecision: "deny",
					gateReason: "tool_rate_limited",
					denialReason: "tool_rate_limited",
					riskTier: "bounded_write",
					blastRadius: "single_resource",
					rateLimit: {
						limiter: "tool_risk",
						scope: "organization_caller_app_tool",
						limit: 30,
						windowSeconds: 60,
						retryAfterSeconds: 60,
					},
				},
			},
		});
		const text = result?.content[0]?.text ?? "";
		expect(text).toContain("30 calls per 60 seconds");
		expect(text).toContain("No side effect was executed");
		expect(text).toContain(
			"Wait 60 seconds (retryAfter: 60) before calling update_customer",
		);
		expect(text).toContain("retry only the calls that did not succeed");
	});

	it("states the tighter budget for high-impact writes", async () => {
		const limit = vi.fn().mockResolvedValue({ success: false });
		const result = await enforceToolRiskRateLimit(
			context(limit),
			tool("high_impact_write", "tenant"),
		);
		expect(result?._meta["com.tedix/security"]).toMatchObject({
			rateLimit: { limit: 5, windowSeconds: 60, retryAfterSeconds: 60 },
		});
	});

	it("does not spend the write budget for reads or unclassified tools", async () => {
		const limit = vi.fn();
		expect(
			await enforceToolRiskRateLimit(context(limit), tool("read", "none")),
		).toBeNull();
		expect(await enforceToolRiskRateLimit(context(limit), tool())).toBeNull();
		expect(limit).not.toHaveBeenCalled();
	});

	it("keeps availability and redacts the limiter key from nested exception logs", async () => {
		const key = "org-1:user-1:crm:update_customer";
		const cause = new Error(`backend rejected ${key}`);
		const limit = vi
			.fn()
			.mockRejectedValue(new Error(`limiter failed for ${key}`, { cause }));
		const output = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(
				await enforceToolRiskRateLimit(
					context(limit),
					tool("bounded_write", "single_resource"),
				),
			).toBeNull();
			const logged = output.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(logged.event).toBe("tool_risk.rate_limit_unavailable");
			expect(JSON.stringify(logged)).not.toContain(key);
			expect(JSON.stringify(logged.exception)).toContain(
				"[redacted rate-limit key]",
			);
		} finally {
			output.mockRestore();
		}
	});
});
