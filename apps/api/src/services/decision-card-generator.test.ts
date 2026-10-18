import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	config: vi.fn(),
	preferences: vi.fn(),
	model: vi.fn(),
}));
vi.mock("@tedix/db/queries/decision-learning", () => ({
	getDecisionLearningConfig: mocks.config,
}));
vi.mock("./decision-learning", () => ({
	readDraftPreferences: mocks.preferences,
}));
vi.mock("./lesson-distiller", () => ({ runDistillModel: mocks.model }));
import { generateDecisionCard } from "./decision-card-generator";
const request = {
	orgId: "fictional",
	targetId: "robin",
	kind: "question",
	subject: "Sign-in proof",
	prompt: "Review a fictional sign-in; no approval exists.",
	metadata: {},
};
const copy = {
	version: 1,
	title: "Allow the fictional sign-in test?",
	body: "The test checks the sign-in flow. It still needs your approval.",
	recommendation:
		"Review the test scope because permission has not been granted.",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.config.mockResolvedValue({ preferenceModel: "small-configured-model" });
	mocks.preferences.mockResolvedValue("Prefer shorter proposals.");
	mocks.model.mockResolvedValue(JSON.stringify(copy));
});
it("uses the recipient's learned preferences and configured small model without generating authority", async () => {
	const result = await generateDecisionCard(
		{ db: {}, env: {} } as never,
		request,
	);
	expect(result).toMatchObject({ ...copy, model: "small-configured-model" });
	expect(mocks.preferences).toHaveBeenCalledWith({}, "fictional", "robin");
	expect(mocks.model).toHaveBeenCalledWith(
		expect.anything(),
		expect.stringContaining("Prefer shorter proposals."),
		expect.objectContaining({ model: "small-configured-model" }),
	);
});
it.each([
	{ ...copy, title: "x".repeat(91) },
	{ ...copy, body: "One. Two. Three." },
	{ ...copy, recommendation: "Approve this." },
	{ ...copy, options: [{ intent: "approve" }] },
])("rejects invalid copy or invented actions", async (invalid) => {
	mocks.model.mockResolvedValue(JSON.stringify(invalid));
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toBeNull();
	expect(mocks.model).toHaveBeenCalledTimes(2);
});
