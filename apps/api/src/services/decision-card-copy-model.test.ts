import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	select: vi.fn(),
	generate: vi.fn(),
}));
vi.mock("../rpc/routers/kernel/llm", () => ({ kernelModel: mocks.select }));
vi.mock("../lib/traced-ai", () => ({
	tracedAi: { generateText: mocks.generate },
}));
import { runDecisionCardCopyModel } from "./decision-card-copy-model";
const options = {
	orgId: "fictional",
	model: "azure-openai/gpt-6-luna",
	maxTokens: 650,
	timeoutMs: 10000,
	system: "Source facts only; exactly three texts.",
	rewriteInstruction: "Apply the Adriana test; do not execute a filing.",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.select.mockReturnValue({
		model: "rewrite-model",
	});
	mocks.generate.mockReset().mockResolvedValue({ text: '{"title":"Final"}' });
});
it("rewrites source facts in one attributed bounded call", async () => {
	expect(
		await runDecisionCardCopyModel(
			{ env: {} } as never,
			"Fictional account question",
			options,
		),
	).toBe('{"title":"Final"}');
	expect(mocks.select).toHaveBeenCalledWith(
		{},
		{ modelRef: options.model },
		{ organizationId: "fictional", source: "decision_card_copy" },
	);
	expect(mocks.generate).toHaveBeenCalledTimes(1);
	expect(mocks.generate.mock.calls[0]?.[0]).toMatchObject({
		model: "rewrite-model",
		maxOutputTokens: 650,
		maxRetries: 0,
		runtimeContext: { orgId: "fictional" },
	});
	expect(JSON.parse(mocks.generate.mock.calls[0]?.[0].prompt)).toEqual({
		source: "Fictional account question",
		instruction: options.rewriteInstruction,
	});
	expect(
		mocks.generate.mock.calls.every(
			([x]) => x.abortSignal instanceof AbortSignal,
		),
	).toBe(true);
});
it("does not fall back to a different provider when the selected route is unavailable", async () => {
	mocks.select.mockReturnValue(null);
	const failure = vi.fn();
	expect(
		await runDecisionCardCopyModel({ env: {} } as never, "Fictional source", {
			...options,
			onFailure: failure,
		}),
	).toBeNull();
	expect(mocks.generate).not.toHaveBeenCalled();
	expect(failure).toHaveBeenCalledWith("model_binding_unavailable");
});
it("does not return source text when rewriting fails", async () => {
	mocks.generate.mockRejectedValueOnce(new Error("provider unavailable"));
	const failure = vi.fn();
	expect(
		await runDecisionCardCopyModel({ env: {} } as never, "Fictional source", {
			...options,
			onFailure: failure,
		}),
	).toBeNull();
	expect(failure).toHaveBeenCalledWith("model_provider_failed");
});
