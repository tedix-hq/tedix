import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
const policy = vi.hoisted(() => vi.fn());
vi.mock("@tedix/db/queries/data-residency", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/data-residency")>()),
	getOrganizationResidencyPolicy: policy,
}));
vi.mock("@tedix/db/queries/app-records", () => ({
	getAppById: async () => ({ organizationId: "org_lark" }),
}));
import {
	organizationModelEnv,
	assertModelEgressAllowed,
	requireUnrestrictedModelEgress,
} from "./unrouted-model-egress";
import { runDistillModel } from "./lesson-distiller";
import { runClef } from "../lib/clef";
import { createVoiceGatewayAi } from "../kernel/voice-gateway-ai";
import { indexContentDocument } from "../integrations/ai-search/content-index";
beforeEach(() => {
	vi.resetAllMocks();
	policy.mockResolvedValue({ mode: "eu", revision: 1 });
});
describe("auxiliary model egress under organization residency", () => {
	it("blocks direct learning and judging transports for EU without altering shared env or another organization", async () => {
		const send = vi.fn(async () => ({ response: "fictional response" }));
		const env = { AI: { run: send } };
		const scoped = organizationModelEnv(env, {} as never, "org_lark");
		expect(
			await runDistillModel(scoped as never, "fictional prompt"),
		).toBeNull();
		expect(
			(
				await runClef(scoped as never, {
					modelId: "@cf/cloudflare/clef",
					state: "fictional",
					questions: {},
					surface: "fixture",
				})
			).ok,
		).toBe(false);
		expect(send).not.toHaveBeenCalled();
		expect(scoped).not.toBe(env);
		expect(env.AI.run).toBe(send);
		policy.mockResolvedValue(null);
		const other = organizationModelEnv(env, {} as never, "org_elm");
		await other.AI.run();
		expect(send).toHaveBeenCalledOnce();
		expect(policy.mock.calls.at(-1)?.[1]).toBe("org_elm");
	});
	it("rechecks before a gateway helper or a new request in an existing scoped env", async () => {
		const send = vi.fn();
		const scoped = organizationModelEnv(
			{ AI: { run: send } },
			{} as never,
			"org_lark",
		);
		await expect(assertModelEgressAllowed(scoped)).rejects.toThrow(
			"EU_PROVIDER_ROUTE_REQUIRED",
		);
		expect(send).not.toHaveBeenCalled();
		policy.mockRejectedValue(Error("policy database unavailable"));
		await expect(scoped.AI.run()).rejects.toThrow(
			"RESIDENCY_POLICY_UNAVAILABLE",
		);
		expect(send).not.toHaveBeenCalled();
	});
	it.each(["voice-stt", "voice-tts"] as const)(
		"blocks %s at the provider run boundary",
		async (channel) => {
			const send = vi.fn();
			const runner = createVoiceGatewayAi({
				ai: () => ({ run: send }),
				gatewayId: () => "example-gateway",
				channel,
				attribution: () => ({ organizationId: "org_lark" }),
				beforeRun: (org) =>
					requireUnrestrictedModelEgress({} as never, org, "Live voice"),
			});
			await expect(runner.run("fictional-voice-model", {})).rejects.toThrow(
				"EU_PROVIDER_ROUTE_REQUIRED",
			);
			expect(send).not.toHaveBeenCalled();
		},
	);
	it("blocks image/OCR embeddings before object upload or search-index transmission", async () => {
		const put = vi.fn(),
			get = vi.fn();
		await expect(
			indexContentDocument(
				{} as never,
				{
					CONTENT_CMS_BUCKET: { put } as never,
					CONTENT_AI_SEARCH: { get } as never,
				},
				{
					appId: "example-app",
					appSlug: "guide",
					canonicalUrl: "https://example.test/image.png",
					title: "Fictional image",
					contentType: "docs",
					visibility: "private",
					nativeFile: {
						name: "image.png",
						mediaType: "image/png",
						content: new ArrayBuffer(4),
					},
				},
			),
		).rejects.toThrow("EU_PROVIDER_ROUTE_REQUIRED");
		expect(put).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
	});
});
