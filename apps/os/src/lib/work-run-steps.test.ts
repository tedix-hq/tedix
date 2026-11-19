import type { ListWorkAttemptStepsResult } from "@tedix/api-contract/schemas/work-attempt-steps";
import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { readWorkRunSteps, WORK_RUN_STEP_PAGE } from "./work-run-steps";

const RUN_A = "44444444-4444-4444-8444-444444444444";
const RUN_B = "77777777-7777-4777-8777-777777777777";

const steps = (from: number, count: number) =>
	Array.from({ length: count }, (_, index) => ({
		seq: from + index,
		at: 1_000 + from + index,
		kind: "message" as const,
		text: `step ${from + index}`,
	}));

const page = (
	attemptId: string | null,
	pageSteps: ReturnType<typeof steps>,
	live = true,
): ListWorkAttemptStepsResult => ({
	attemptId,
	live,
	steps: pageSteps,
	messages: [],
});

it("reads a long run page by page, then only what is new", async () => {
	const readPage = vi
		.fn<Parameters<typeof readWorkRunSteps>[0]>()
		.mockResolvedValueOnce(page(RUN_A, steps(0, WORK_RUN_STEP_PAGE)))
		.mockResolvedValueOnce(page(RUN_A, steps(WORK_RUN_STEP_PAGE, 3)));
	const first = await readWorkRunSteps(readPage);
	expect(first.steps).toHaveLength(WORK_RUN_STEP_PAGE + 3);
	expect(readPage.mock.calls).toEqual([
		[{}],
		[{ attemptId: RUN_A, afterSeq: WORK_RUN_STEP_PAGE - 1 }],
	]);

	readPage.mockClear();
	readPage.mockResolvedValueOnce(page(RUN_A, steps(WORK_RUN_STEP_PAGE + 3, 1)));
	const second = await readWorkRunSteps(readPage, first);
	expect(readPage.mock.calls).toEqual([[{ afterSeq: WORK_RUN_STEP_PAGE + 2 }]]);
	expect(second.steps).toHaveLength(WORK_RUN_STEP_PAGE + 4);
	// Steps already held stay the same objects, so their rows do not render.
	expect(second.steps[0]).toBe(first.steps[0]);
});

it("keeps the cached run itself when a refresh has nothing new", async () => {
	const client = new QueryClient();
	const readPage = vi
		.fn<Parameters<typeof readWorkRunSteps>[0]>()
		.mockResolvedValueOnce(page(RUN_A, steps(0, 2)))
		.mockResolvedValue(page(RUN_A, []));
	const options = {
		queryKey: ["run"],
		queryFn: () =>
			readWorkRunSteps(readPage, client.getQueryData(options.queryKey)),
	};
	await client.fetchQuery(options);
	const first = client.getQueryData(options.queryKey);
	await client.fetchQuery(options);
	expect(readPage).toHaveBeenLastCalledWith({ afterSeq: 1 });
	expect(client.getQueryData(options.queryKey)).toBe(first);
});

it("starts over when a new run has started", async () => {
	const held = page(RUN_A, steps(0, 5), false);
	const readPage = vi
		.fn<Parameters<typeof readWorkRunSteps>[0]>()
		// The newest run is another Attempt; `afterSeq` hid its first steps.
		.mockResolvedValueOnce(page(RUN_B, []))
		.mockResolvedValueOnce(page(RUN_B, steps(0, 2)));
	const next = await readWorkRunSteps(readPage, held);
	expect(readPage.mock.calls).toEqual([
		[{ afterSeq: 4 }],
		[{ attemptId: RUN_B }],
	]);
	expect(next.attemptId).toBe(RUN_B);
	expect(next.steps.map((step) => step.seq)).toEqual([0, 1]);
});
