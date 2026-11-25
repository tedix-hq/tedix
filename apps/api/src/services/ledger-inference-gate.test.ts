import { expect, it, vi } from "vite-plus/test";
import { skipLedgerInference } from "./ledger-inference-gate";

function answer(choice: string, confidence = 0.99) {
	return {
		type: "choice",
		choice,
		confidence,
		probabilities: { [choice]: confidence },
	};
}

it("requires agreement for every request's change, lifecycle and user attention", async () => {
	const answers = {
		request_0_change: answer("unchanged"),
		request_0_state: answer("open"),
		request_0_user: answer("no"),
		request_1_change: answer("unchanged"),
		request_1_state: answer("open"),
		request_1_user: answer("yes"),
	};
	const run = vi.fn().mockResolvedValue({ answers });
	const env = {
		AI: { run } as unknown as Ai,
		AI_GATEWAY_LLM_ID: "example-gateway",
	};
	const input = {
		surface: "status" as const,
		state: "Saved rows and current evidence",
		rows: [
			{ ref: "r1", text: "Fix the upload", status: "in_progress" as const },
			{
				ref: "r2",
				text: "Approve sending",
				status: "waiting_on_user" as const,
			},
		],
	};
	expect(await skipLedgerInference(env, input)).toBe(true);
	for (const replacement of [
		answer("changed"),
		answer("unsure"),
		answer("unchanged", 0.5),
	]) {
		run.mockResolvedValueOnce({
			answers: { ...answers, request_1_change: replacement },
		});
		expect(await skipLedgerInference(env, input)).toBe(false);
	}
	run.mockResolvedValueOnce({
		answers: { ...answers, request_0_state: answer("done") },
	});
	expect(await skipLedgerInference(env, input)).toBe(false);
	run.mockResolvedValueOnce({
		answers: { ...answers, request_1_user: answer("no") },
	});
	expect(await skipLedgerInference(env, input)).toBe(false);
	run.mockResolvedValueOnce({ answers: {} });
	expect(await skipLedgerInference(env, input)).toBe(false);
	run.mockRejectedValueOnce(new Error("provider unavailable"));
	expect(await skipLedgerInference(env, input)).toBe(false);
	run.mockClear();
	expect(
		await skipLedgerInference(env, { ...input, state: "x".repeat(25_000) }),
	).toBe(false);
	expect(
		await skipLedgerInference(env, {
			...input,
			rows: Array.from({ length: 22 }, () => input.rows[0]!),
		}),
	).toBe(false);
	expect(run).not.toHaveBeenCalled();
});

it("calls generation after a gate deadline instead of losing a lesson", async () => {
	vi.useFakeTimers();
	try {
		const env = {
			AI: { run: vi.fn(() => new Promise(() => {})) } as unknown as Ai,
			AI_GATEWAY_LLM_ID: "",
		};
		const pending = skipLedgerInference(env, {
			surface: "lesson",
			state: { previous: {}, sources: [] },
		});
		await vi.advanceTimersByTimeAsync(2500);
		expect(await pending).toBe(false);
	} finally {
		vi.useRealTimers();
	}
});
