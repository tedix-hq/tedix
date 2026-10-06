import { describe, expect, it } from "vite-plus/test";
import { AuthorizeRuntimeInferenceInputSchema } from "./runtime-entitlements";
const request = {
	organizationId: "org",
	settlementMode: "external",
	source: "kernel",
	workItemId: null,
	execution: {
		provider: "workers-ai",
		requestModel: "@cf/model",
		gatewayAccountId: "account",
		gatewayId: "gateway",
		transportKind: "workers-ai-binding",
		apiKind: "workers-ai-chat",
		providerResource: null,
		providerOrigin: null,
		deployment: null,
	},
	estimatedInputTokens: 1,
	estimatedOutputTokens: 1,
	idempotencyKey: "attempt-key",
};
describe("remote native inference contract", () => {
	it("requires a bounded origin assertion even for source=kernel and missing tedi", () => {
		expect(
			AuthorizeRuntimeInferenceInputSchema.safeParse(request).success,
		).toBe(false);
		expect(
			AuthorizeRuntimeInferenceInputSchema.safeParse({
				...request,
				originToken: "",
			}).success,
		).toBe(false);
		expect(
			AuthorizeRuntimeInferenceInputSchema.safeParse({
				...request,
				originToken: "a".repeat(16385),
			}).success,
		).toBe(false);
	});
	it("accepts the known signed projection", () => {
		expect(
			AuthorizeRuntimeInferenceInputSchema.safeParse({
				...request,
				originToken: "assertion",
			}).success,
		).toBe(true);
	});
	it("rejects caller-selected authority fields", () => {
		expect(
			AuthorizeRuntimeInferenceInputSchema.safeParse({
				...request,
				originToken: "assertion",
				plane: "organization_kernel",
			}).success,
		).toBe(false);
	});
});

it("requires modern Auto routing on new signed admission and keeps fixed requests", () => {
	const auto = {
		...request,
		originToken: "assertion",
		execution: {
			...request.execution,
			requestModel: "cloudflare/auto",
			transportKind: "gateway-https",
		},
	};
	expect(AuthorizeRuntimeInferenceInputSchema.safeParse(auto).success).toBe(
		false,
	);
	expect(
		AuthorizeRuntimeInferenceInputSchema.safeParse({
			...auto,
			execution: {
				...auto.execution,
				autoRouting: {
					version: 1,
					modality: "text",
					mode: "unrestricted",
					allowedProviders: null,
					allowedModels: null,
				},
			},
		}).success,
	).toBe(true);
});
