import { expect, it, vi } from "vite-plus/test";
import { summarizeFeedOutcome } from "./feed-outcome-summary";
import { runDistillModel } from "./lesson-distiller";
vi.mock("./lesson-distiller", () => ({ runDistillModel: vi.fn() }));
vi.mock("./unrouted-model-egress", () => ({
	organizationModelEnv: (env: unknown) => env,
}));
const context = { env: {}, db: {} } as never;
const input = {
	organizationId: "fictional-org",
	title: "Office fix",
	outcome: "succeeded",
	summary: "The Office view shows live activity again. Tests passed.",
};
it("makes one bounded small-model summary at ingestion and rejects raw output", async () => {
	vi.mocked(runDistillModel).mockResolvedValueOnce(
		"The Office view shows live activity again.",
	);
	expect(await summarizeFeedOutcome(context, input)).toBe(
		"The Office view shows live activity again.",
	);
	expect(runDistillModel).toHaveBeenLastCalledWith(
		{},
		expect.stringContaining(input.summary),
		expect.objectContaining({ maxTokens: 100, timeoutMs: 2500 }),
	);
	for (const answer of [
		null,
		"NONE",
		"session codex waiting: sha abcdef1234",
		"x".repeat(181),
	]) {
		vi.mocked(runDistillModel).mockResolvedValueOnce(answer);
		expect(await summarizeFeedOutcome(context, input)).toBeNull();
	}
});
