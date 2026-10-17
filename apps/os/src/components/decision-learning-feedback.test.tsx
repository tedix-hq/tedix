import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { OS_COPY } from "@/shared/os-copy";
import { DecisionLearningFeedback } from "./decision-learning-feedback";

vi.mock("@/lib/api", () => ({
	osApi: { learningFeedback: { correct: vi.fn(), model: vi.fn() } },
}));

let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	client?.clear();
	host?.remove();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});
async function mount(enabled = true) {
	client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	const model = learnDecisions({
		organizationId: "fictional-harbor",
		personId: "river",
		events: [],
		config: DecisionLearningConfigSchema.parse({ enabled }),
		now: new Date(),
	});
	model.receipts = [
		{
			eventId: "fictional-edited-signal",
			classId: "investor-email",
			eventKind: "edited",
			choice: "change",
			shortened: true,
		},
	];
	client.setQueryData(
		osQuery.learningFeedback.model.queryOptions({ input: {} }).queryKey,
		model,
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<DecisionLearningFeedback />
			</QueryClientProvider>,
		),
	);
}

it("explains an edit and corrects only its learning evidence", async () => {
	const correct = vi
		.mocked(osApi.learningFeedback.correct)
		.mockResolvedValue({} as never);
	await mount();
	expect(host.textContent).toContain(
		"Got it — shorter wording for investor email.",
	);
	// Keep the existing receipt visible while asserting the acknowledged correction.
	const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
	await act(async () => host.querySelector("button")!.click());
	expect(correct).toHaveBeenCalledExactlyOnceWith({
		eventId: "fictional-edited-signal",
		clientEventId: expect.any(String),
	});
	expect(invalidate).toHaveBeenCalledWith({
		queryKey: osQuery.learningFeedback.key(),
	});
	expect(host.textContent).toContain(OS_COPY.learning.undone);
});

it("keeps failed corrections retryable and hides feedback when disabled", async () => {
	const correct = vi
		.mocked(osApi.learningFeedback.correct)
		.mockRejectedValue(new Error("unavailable"));
	await mount();
	await act(async () => host.querySelector("button")!.click());
	expect(host.textContent).toContain(OS_COPY.learning.failed);
	expect(host.querySelector("button")!.disabled).toBe(false);
	await act(async () => root.unmount());
	client.clear();
	host.remove();
	await mount(false);
	expect(host.textContent).toBe("");
	expect(correct).toHaveBeenCalledTimes(1);
});
