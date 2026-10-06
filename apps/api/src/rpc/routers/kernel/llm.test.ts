import { describe, expect, it } from "vite-plus/test";
import { kernelGatewayMetadata } from "./gateway-attribution";
import { azureGatewayByokHeaders, type KernelEnv, kernelModel } from "./llm";

const AZURE_ENV = {
	AZURE_OPENAI_RESOURCE: "tedix-resource",
	AZURE_CHAT_DEPLOYMENT: "gpt-5.6-luna",
	AI_GATEWAY_ACCOUNT_ID: "account",
	AI_GATEWAY_LLM_ID: "gateway",
	CF_AI_GATEWAY_TOKEN: "token",
} as unknown as KernelEnv;

const FAKE_AI = { run: async () => ({ response: "{}" }) };

describe("kernelModel provider selection", () => {
	it("selects exact deployed v6 refs with Responses pricing identity", () => {
		for (const deployment of ["gpt-6.1-sol", "gpt-6-luna"]) {
			const selected = kernelModel(AZURE_ENV, {
				modelRef: `azure-openai/${deployment}`,
			});
			expect(selected?.pricingIdentity).toMatchObject({
				requestModel: deployment,
				deployment,
				apiKind: "azure-responses",
			});
			expect(
				typeof selected?.model === "object" && selected.model.modelId,
			).toBe(deployment);
		}
	});

	it("uses authenticated Gateway BYOK instead of forwarding the Worker Azure key", () => {
		const headers = azureGatewayByokHeaders(
			{
				"api-key": "stale-worker-key",
				"x-test": "kept",
				"cf-aig-no-wholesale": "false",
			},
			"gateway-token",
			"org-1",
		);
		expect(headers.has("api-key")).toBe(false);
		expect(headers.get("cf-aig-no-wholesale")).toBe("true");
		expect(headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
		expect(headers.get("cf-aig-metadata")).toBe(
			JSON.stringify(kernelGatewayMetadata("org-1")),
		);
		expect(headers.get("x-test")).toBe("kept");
	});

	it("builds the Auto Router model by default", () => {
		const model = kernelModel(AZURE_ENV);
		expect(model).not.toBeNull();
		expect(
			typeof model === "object" &&
				typeof model?.model === "object" &&
				model.model.provider,
		).toBe("cloudflare-auto");
	});

	it("builds Auto Router from authenticated Gateway without a provider key", () => {
		const model = kernelModel({
			AZURE_OPENAI_RESOURCE: "tedix-resource",
			AZURE_CHAT_DEPLOYMENT: "gpt-5.6-luna",
			AI_GATEWAY_ACCOUNT_ID: "account",
			AI_GATEWAY_LLM_ID: "gateway",
			CF_AI_GATEWAY_TOKEN: "token",
		});
		expect(model).not.toBeNull();
		expect(
			typeof model === "object" &&
				typeof model?.model === "object" &&
				model.model.provider,
		).toBe("cloudflare-auto");
	});

	it("allows the tokenless bridge only for the exact loopback local-demo lane", () => {
		const local = {
			AZURE_OPENAI_RESOURCE: "tedix-resource",
			AZURE_CHAT_DEPLOYMENT: "gpt-5.6-luna",
			AI_GATEWAY_ACCOUNT_ID: "account",
			AI_GATEWAY_LLM_ID: "gateway",
			TEDIX_LOCAL_INFERENCE_PROXY_URL: "http://127.0.0.1:8791",
			TEDIX_LOCAL_DEMO_ENABLED: "true",
			DESCOPE_PROJECT_ID: "local-development-disabled",
		} satisfies KernelEnv;
		expect(
			kernelModel(local, { modelRef: "azure-openai/gpt-5.6-luna" }),
		).not.toBeNull();
		expect(
			kernelModel({
				...local,
				TEDIX_LOCAL_INFERENCE_PROXY_URL: "https://evil.test",
			}),
		).toBeNull();
		expect(
			kernelModel({ ...local, DESCOPE_PROJECT_ID: "real-project" }),
		).toBeNull();
		expect(
			kernelModel({ ...local, TEDIX_LOCAL_DEMO_ENABLED: "false" }),
		).toBeNull();
	});

	it("preserves an explicit Workers AI model choice", () => {
		const selected = kernelModel(
			{ ...AZURE_ENV, AI: FAKE_AI } as unknown as KernelEnv,
			{ modelRef: "workers-ai/@cf/meta/llama-3.1-8b-instruct-fast" },
		);
		expect(typeof selected?.model === "object" && selected.model.provider).toBe(
			"workers-ai",
		);
	});

	it("selects the per-role KERNEL_MODEL_REF workers-ai catalog model when explicitly selected", () => {
		const model = kernelModel({
			...AZURE_ENV,
			KERNEL_MODEL_REF: "workers-ai/@cf/meta/llama-3.1-8b-instruct-fast",
			AI: FAKE_AI,
		} as unknown as KernelEnv);
		expect(
			typeof model === "object" &&
				typeof model?.model === "object" &&
				model.model.modelId,
		).toBe("@cf/meta/llama-3.1-8b-instruct-fast");
	});

	it("routes governed judgment through the authorized default", () => {
		const selected = kernelModel(AZURE_ENV, undefined, {
			source: "kernel:goal-judge",
		});
		expect(
			typeof selected === "object" &&
				typeof selected?.model === "object" &&
				selected.model.provider,
		).toBe("cloudflare-auto");
	});

	it("routes authority-bearing planning through the authorized default", () => {
		const selected = kernelModel(AZURE_ENV, undefined, {
			source: "kernel:route-plan",
		});
		expect(
			typeof selected === "object" &&
				typeof selected?.model === "object" &&
				selected.model.provider,
		).toBe("cloudflare-auto");
	});

	it("still returns null when Azure is unconfigured and nothing is forced", () => {
		expect(kernelModel({} as unknown as KernelEnv)).toBeNull();
	});
});
