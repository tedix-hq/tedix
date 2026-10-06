import { describe, expect, it, vi } from "vite-plus/test";
const findRates = vi.hoisted(() => vi.fn());
vi.mock("@tedix/db/client", () => ({
	createDbClient: (binding: unknown) => binding,
}));
const tenant = { owner: "tenant" };
const env = {
	TEDIX_FLEET_AUTHORITY_MODE: "co-located",
	DB: tenant,
} as never;
vi.mock("@tedix/db/queries/billing/provider-model-rates", () => ({
	findProviderModelRates: findRates,
}));
import {
	priceKernelUsage,
	resolveProviderModelRate,
} from "./provider-model-pricing";
const input = {
	provider: "azure-openai",
	modelId: "provider/native/model",
	deploymentScope: "account/region/deployment",
	occurredAt: "2026-10-01T00:00:00.000Z",
};
describe("provider rate resolution", () => {
	it("keeps exact provider-native identity and an immutable selected version", async () => {
		const rate = Object.freeze({
			id: "version",
			cacheReadMicrousdPerMillion: 0,
		});
		findRates.mockResolvedValueOnce([rate]);
		expect(await resolveProviderModelRate(env, input)).toEqual({
			status: "resolved",
			rate,
		});
		expect(findRates).toHaveBeenLastCalledWith(tenant, input);
	});
	it("returns missing and ambiguous rates rather than choosing a default", async () => {
		findRates
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ id: "specific" },
				{ id: "conflicting-version" },
			]);
		expect(await resolveProviderModelRate(env, input)).toEqual({
			status: "unpriced",
			reason: "missing_rate",
		});
		expect(await resolveProviderModelRate(env, input)).toEqual({
			status: "unpriced",
			reason: "ambiguous_rate",
		});
	});
	it("requires known scope and valid event time before lookup", async () => {
		findRates.mockClear();
		expect(
			await resolveProviderModelRate(env, {
				...input,
				deploymentScope: null,
			}),
		).toEqual({ status: "unpriced", reason: "ambiguous_scope" });
		expect(
			await resolveProviderModelRate(env, {
				...input,
				occurredAt: "invalid",
			}),
		).toEqual({ status: "unpriced", reason: "invalid_timestamp" });
		expect(findRates).not.toHaveBeenCalled();
	});
	it.each(["", "   ", "\t\n"])(
		"rejects blank scope %j without broader lookup",
		async (deploymentScope) => {
			findRates.mockClear();
			expect(
				await resolveProviderModelRate(env, {
					...input,
					deploymentScope,
				}),
			).toEqual({ status: "unpriced", reason: "ambiguous_scope" });
			expect(findRates).not.toHaveBeenCalled();
		},
	);
});

describe("fleet ownership", () => {
	it("uses the explicitly co-located tenant binding only in co-located mode", async () => {
		findRates.mockResolvedValueOnce([]);
		await resolveProviderModelRate(
			{ TEDIX_FLEET_AUTHORITY_MODE: "co-located", DB: tenant } as never,
			input,
		);
		expect(findRates).toHaveBeenLastCalledWith(tenant, input);
	});
	it("reads no rows when fleet authority is disabled", async () => {
		findRates.mockClear();
		expect(
			await resolveProviderModelRate(
				{ TEDIX_FLEET_AUTHORITY_MODE: "disabled", DB: tenant } as never,
				input,
			),
		).toEqual({ status: "unpriced", reason: "rate_authority_unavailable" });
		expect(findRates).not.toHaveBeenCalled();
	});
	it("preserves unknown cost on lookup failure", async () => {
		findRates.mockRejectedValueOnce(new Error("offline"));
		expect(await resolveProviderModelRate(env, input)).toEqual({
			status: "unpriced",
			reason: "rate_lookup_failed",
		});
	});
});

const identity = {
	provider: "workers-ai",
	requestModel: "@cf/model",
	gatewayAccountId: "account",
	gatewayId: "gateway",
	transportKind: "workers-ai-binding",
	apiKind: "workers-ai-chat",
	providerResource: null,
	providerOrigin: null,
	deployment: null,
} as const;
const attempt = (
	executionId: string,
	usage = {
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 30,
		cacheWriteTokens: 10,
	},
) => ({ identity, executionId, occurredAt: input.occurredAt, usage });
const rates = {
	id: "rate",
	inputMicrousdPerMillion: 1_000_000,
	outputMicrousdPerMillion: 2_000_000,
	cacheReadMicrousdPerMillion: 100_000,
	cacheWriteMicrousdPerMillion: 500_000,
};
describe("complete attempt pricing", () => {
	it("includes failed-parse responses and the successful retry without double counting receipts", async () => {
		findRates.mockResolvedValue([rates]);
		const first = attempt("invalid-output"),
			second = attempt("valid-output");
		const result = await priceKernelUsage(env, {
			attempts: [first, second, first],
		});
		expect(result.costUsd).toBe(0.000216);
		expect(findRates).toHaveBeenCalledWith(
			tenant,
			expect.objectContaining({ inputTokens: 100 }),
		);
		expect(result.pricing).toMatchObject({
			knownSubtotalUsd: 0.000216,
			attemptCount: 2,
			pricedAttemptCount: 2,
			costCompleteness: "complete",
		});
	});
	it("preserves a known subtotal beside a missing failed attempt", async () => {
		findRates.mockResolvedValue([rates]);
		expect(
			await priceKernelUsage(env, {
				attempts: [
					{ ...attempt("failed"), usage: undefined },
					attempt("winner"),
				],
			}),
		).toMatchObject({
			costUsd: null,
			pricing: {
				knownSubtotalUsd: 0.000108,
				attemptCount: 2,
				pricedAttemptCount: 1,
				costCompleteness: "partial",
				reason: "missing_attempt_usage",
			},
		});
	});
	it("keeps known zero distinct from unknown", async () => {
		findRates.mockResolvedValue([
			{
				...rates,
				inputMicrousdPerMillion: 0,
				outputMicrousdPerMillion: 0,
				cacheReadMicrousdPerMillion: 0,
				cacheWriteMicrousdPerMillion: 0,
			},
		]);
		expect(
			await priceKernelUsage(env, { attempts: [attempt("zero")] }),
		).toMatchObject({
			costUsd: 0,
			pricing: { costCompleteness: "complete", pricedAttemptCount: 1 },
		});
		expect(
			await priceKernelUsage(env, {
				attempts: [{ ...attempt("missing"), usage: undefined }],
			}),
		).toMatchObject({
			costUsd: null,
			pricing: { costCompleteness: "unknown", pricedAttemptCount: 0 },
		});
	});
	it("rejects aggregate overflow even when each amount fits safe microUSD", async () => {
		findRates.mockResolvedValue([
			{ ...rates, inputMicrousdPerMillion: Number.MAX_SAFE_INTEGER },
		]);
		const usage = {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		expect(
			await priceKernelUsage(env, {
				attempts: [attempt("one", usage), attempt("two", usage)],
			}),
		).toMatchObject({
			costUsd: null,
			pricing: {
				pricedAttemptCount: 1,
				costCompleteness: "partial",
				reason: "cost_total_overflow",
			},
		});
	});
});

it("represents a proven operation with no admitted sends as no_usage", async () => {
	findRates.mockClear();
	expect(await priceKernelUsage(env, { attempts: [] })).toMatchObject({
		costUsd: 0,
		pricing: {
			attemptCount: 0,
			pricedAttemptCount: 0,
			knownSubtotalUsd: 0,
			costCompleteness: "no_usage",
		},
	});
	expect(findRates).not.toHaveBeenCalled();
});
