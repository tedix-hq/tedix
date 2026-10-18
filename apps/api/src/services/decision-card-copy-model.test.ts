import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	select: vi.fn(),
	generate: vi.fn(),
	next: vi.fn(),
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
	mocks.next.mockReturnValue({ model: "rewrite-model" });
	mocks.select.mockReturnValue({
		model: "draft-model",
		forOperation: mocks.next,
	});
	mocks.generate
		.mockResolvedValueOnce({ text: '{"title":"Draft"}' })
		.mockResolvedValueOnce({ text: '{"title":"Final"}' });
});
it("uses attributed model selection and a separate bounded rewrite, returning only the final copy", async () => {
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
	expect(mocks.generate).toHaveBeenCalledTimes(2);
	expect(mocks.generate.mock.calls[0]?.[0]).toMatchObject({
		model: "draft-model",
		prompt: "Fictional account question",
		maxRetries: 0,
		runtimeContext: { orgId: "fictional" },
	});
	expect(mocks.generate.mock.calls[1]?.[0]).toMatchObject({
		model: "rewrite-model",
		maxRetries: 0,
	});
	expect(JSON.parse(mocks.generate.mock.calls[1]?.[0].prompt)).toEqual({
		source: "Fictional account question",
		draft: '{"title":"Draft"}',
		instruction: options.rewriteInstruction,
	});
	expect(mocks.next).toHaveBeenCalledTimes(1);
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
it("does not return the unreviewed draft when the rewrite fails", async () => {
	mocks.generate
		.mockReset()
		.mockResolvedValueOnce({ text: '{"title":"Draft"}' })
		.mockRejectedValueOnce(new Error("provider unavailable"));
	const failure = vi.fn();
	expect(
		await runDecisionCardCopyModel({ env: {} } as never, "Fictional source", {
			...options,
			onFailure: failure,
		}),
	).toBeNull();
	expect(failure).toHaveBeenCalledWith("model_provider_failed");
});
