import { describe, expect, it } from "vite-plus/test";
import type { KernelExecutionAttempt } from "./gateway-attribution";
import type { KernelRouteUsage } from "./route-planner";
import { aggregateTurnUsage } from "./turn-usage";

function attempt(id: string, input = 100, output = 20): KernelExecutionAttempt {
	return {
		executionId: id,
		occurredAt: "2026-09-24T00:00:00Z",
		identity: {
			provider: "typesafe",
			requestModel: "typesafe/jev",
			gatewayAccountId: "account",
			gatewayId: "gateway",
			transportKind: "cloudflare-ai-https",
			apiKind: "typesafe-systemone",
			providerOrigin: null,
			providerResource: null,
			deployment: null,
		},
		usage: {
			inputTokens: input,
			outputTokens: output,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
	};
}
function route(attempts: KernelExecutionAttempt[] = []): KernelRouteUsage {
	return {
		attempts,
		attemptCount: attempts.length,
		executionId: attempts[0]?.executionId ?? null,
		pricingIdentity: attempts[0]?.identity ?? null,
		occurredAt: attempts[0]?.occurredAt ?? null,
		complete: true,
		provider: "typesafe",
		model: "typesafe/jev",
		inputTokens: 100,
		outputTokens: 20,
		reasoningTokens: 4,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
}
describe("aggregateTurnUsage", () => {
	it("counts ranking, routing and post-route action receipts once, not route counters again", () => {
		const routing = attempt("routing");
		const ranking = attempt("ranking", 10, 2);
		const action = attempt("action", 30, 4);
		expect(
			aggregateTurnUsage(route([routing, ranking]), [
				ranking,
				routing,
				action,
				action,
			]),
		).toMatchObject({
			inputTokens: 140,
			outputTokens: 26,
			attemptCount: 3,
			complete: true,
			executionId: null,
			pricingIdentity: null,
			occurredAt: null,
			reasoningTokens: null,
		});
	});
	it("retains reported usage when a duplicate callback lacks it", () => {
		const paid = attempt("paid");
		expect(
			aggregateTurnUsage(route([paid]), [{ ...paid, usage: undefined }]),
		).toMatchObject({
			inputTokens: 100,
			outputTokens: 20,
			attemptCount: 1,
			reasoningTokens: 4,
		});
	});
	it("does not turn an unreported execution into zero usage", () => {
		expect(
			aggregateTurnUsage(route([attempt("route")]), [
				{ ...attempt("unknown"), usage: undefined },
			]),
		).toMatchObject({
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			complete: false,
		});
	});
	it("preserves unknown fields individually", () => {
		const partial = attempt("partial");
		partial.usage!.outputTokens = null;
		expect(aggregateTurnUsage(null, [partial])).toMatchObject({
			inputTokens: 100,
			outputTokens: null,
			complete: false,
		});
	});
	it("preserves legacy route counters only when there are no receipts", () => {
		const legacy = route();
		expect(aggregateTurnUsage(legacy, [])).toBe(legacy);
		expect(aggregateTurnUsage(null, [])).toBeNull();
	});
	it("does not attribute mixed provider totals to the routing model", () => {
		const direct = attempt("other");
		direct.identity = {
			...direct.identity,
			provider: "azure-openai",
			requestModel: "gpt",
			apiKind: "azure-chat",
			providerResource: "test",
			providerOrigin: "https://test.openai.azure.com",
			deployment: "gpt",
		};
		expect(
			aggregateTurnUsage(route([attempt("route")]), [direct]),
		).toMatchObject({ provider: null, model: null, pricingIdentity: null });
	});
	it("preserves actual zero and rejects overflow totals", () => {
		expect(aggregateTurnUsage(null, [attempt("zero", 0, 0)])).toMatchObject({
			inputTokens: 0,
			outputTokens: 0,
			complete: true,
		});
		expect(
			aggregateTurnUsage(null, [
				attempt("large", Number.MAX_SAFE_INTEGER),
				attempt("one", 1),
			]),
		).toMatchObject({ inputTokens: null, complete: false });
	});
});
