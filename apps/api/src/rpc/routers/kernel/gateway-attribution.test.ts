import { decodeAiGatewayAttribution } from "@tedix/api-contract/schemas/ai-gateway-attribution";
import { describe, expect, it } from "vite-plus/test";
import {
	captureKernelAttemptUsage,
	KERNEL_SPAN_AGENT_ID,
	KERNEL_SPAN_AGENT_NAME,
	kernelGatewayMetadata,
	kernelSpanContext,
} from "./gateway-attribution";

describe("captureKernelAttemptUsage", () => {
	it("retains bounded Auto Router receipts beside the admitted attempt", () => {
		const attempts: Parameters<typeof captureKernelAttemptUsage>[0] = [
			{
				identity: {
					provider: "workers-ai",
					requestModel: "cloudflare/auto",
					gatewayAccountId: "account",
					gatewayId: "gateway",
					transportKind: "gateway-https",
					apiKind: "workers-ai-chat",
					providerResource: null,
					providerOrigin: null,
					deployment: null,
				},
				occurredAt: "2026-10-01T00:00:00.000Z",
				executionId: "execution-1",
			},
		];
		captureKernelAttemptUsage(
			attempts,
			{ inputTokens: 3, outputTokens: 1 },
			{
				cloudflareAutoRouter: {
					routedModel: "openai/gpt-5.6-luna",
					routingReason: "quality_match",
					routingDecisionId: "decision-1",
					requestId: "request-1",
				},
			},
		);
		expect(attempts[0]?.autoRouter).toEqual({
			routedModel: "openai/gpt-5.6-luna",
			routingReason: "quality_match",
			routingDecisionId: "decision-1",
			requestId: "request-1",
		});
	});
});

describe("kernelGatewayMetadata", () => {
	it("fits the Cloudflare five-entry limit and preserves governed correlation", () => {
		const metadata = kernelGatewayMetadata({
			organizationId: "org-1",
			runId: "home-run-1",
			workItemId: "work-item-1",
			sessionKey: "home:conversation-1",
			source: "kernel:route",
			billingReservationId: "billing-reservation-1",
		});

		expect(Object.keys(metadata)).toHaveLength(5);
		expect(metadata).toMatchObject({
			surface: "kernel",
			orgId: "org-1",
			source: "kernel:route",
		});
		expect(metadata.sessionKeyHash).toMatch(/^[0-9a-f]{8}$/);
		expect(decodeAiGatewayAttribution(metadata.attribution)).toEqual({
			runId: "home-run-1",
			workItemId: "work-item-1",
			billingReservationId: "billing-reservation-1",
		});
	});

	it("uses explicit system correlation instead of anonymous metadata", () => {
		const metadata = kernelGatewayMetadata({
			organizationId: "org-1",
			source: "kernel:conversation-title",
		});

		expect(decodeAiGatewayAttribution(metadata.attribution)).toEqual({
			runId: "system:kernel:kernel:conversation-title",
			workItemId: "system:kernel:kernel:conversation-title",
		});
		expect(metadata.sessionKeyHash).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("kernelSpanContext", () => {
	// agentName is load-bearing and invisible: the Agents dashboard groups by
	// gen_ai.agent.name, and wrapAISDK falls back to telemetry.functionId when it
	// is unset — which listed one Home turn under an agent literally named
	// "kernel.route_plan.stream" before this was fixed. Nothing about a missing
	// agentName fails at runtime, so it is pinned here.
	it("names the one Home agent so call sites cannot become pseudo-agents", () => {
		const span = kernelSpanContext({
			organizationId: "org-1",
			runId: "home-run-1",
			sessionKey: "home:conversation-1",
			source: "route_plan",
		});

		expect(span.agentId).toBe(KERNEL_SPAN_AGENT_ID);
		expect(span.agentName).toBe(KERNEL_SPAN_AGENT_NAME);
		expect(span.conversationId).toBe("home:conversation-1");
		expect(span.orgId).toBe("org-1");
		expect(span.runId).toBe("home-run-1");
		expect(span.source).toBe("route_plan");
	});

	it("keeps agent identity even with no correlation at all", () => {
		const span = kernelSpanContext();

		expect(span.agentId).toBe(KERNEL_SPAN_AGENT_ID);
		expect(span.agentName).toBe(KERNEL_SPAN_AGENT_NAME);
	});
});
