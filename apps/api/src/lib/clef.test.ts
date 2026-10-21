import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { CLEF_TIMEOUT_MS, type ClefQuestion, runClef } from "./clef";

const question: ClefQuestion = {
	type: "choice",
	instructions: "Choose an option",
	criteria: { yes: "Yes", no: "No" },
};

function fixture(run = vi.fn().mockResolvedValue({})) {
	const env = {
		AI: { run },
		AI_GATEWAY_LLM_ID: "",
	} as unknown as Parameters<typeof runClef>[0];
	const input: Parameters<typeof runClef>[1] = {
		modelId: "@cf/cloudflare/clef-flash",
		state: { text: "Fictional state" },
		questions: { decision: question },
		surface: "test-clef",
	};
	return { env, input, run };
}

function response(choice = "yes") {
	return {
		answers: {
			decision: {
				type: "choice",
				choice,
				probabilities: { [choice]: 0.8, no: 0.1 },
				confidence: 0.7,
			},
		},
	};
}

describe("runClef", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([false, true])(
		"accepts own choices (enveloped: %s)",
		async (enveloped) => {
			const body = response();
			const { env, input, run } = fixture(
				vi.fn().mockResolvedValue(enveloped ? { result: body } : body),
			);
			await expect(runClef(env, input)).resolves.toEqual({
				ok: true,
				answers: body.answers,
				latencyMs: 0,
			});
			expect(run).toHaveBeenCalledWith(
				input.modelId,
				{ model: "clef-flash", state: input.state, questions: input.questions },
				{ signal: expect.any(AbortSignal) },
			);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(["toString", "constructor", "inheritedOption"])(
		"rejects undeclared inherited choice %s in both response shapes",
		async (choice) => {
			const { env, input, run } = fixture();
			input.questions.decision = {
				...question,
				criteria: Object.assign(
					Object.create({ inheritedOption: "Inherited" }),
					{
						yes: "Yes",
						no: "No",
					},
				),
			};
			for (const body of [response(choice), { result: response(choice) }]) {
				run.mockResolvedValue(body);
				await expect(runClef(env, input)).resolves.toEqual({
					ok: false,
					reason: "malformed",
					latencyMs: 0,
				});
			}
		},
	);

	it("accepts an explicitly declared own toString option", async () => {
		const body = response("toString");
		const { env, input } = fixture(vi.fn().mockResolvedValue(body));
		input.questions.decision = {
			...question,
			criteria: { toString: "Explicit option", no: "No" },
		};
		await expect(runClef(env, input)).resolves.toEqual({
			ok: true,
			answers: body.answers,
			latencyMs: 0,
		});
	});

	it.each([
		null,
		{},
		{ result: {} },
		{ answers: {} },
		{ answers: { decision: null } },
	])("fails soft for missing answers: %j", async (body) => {
		const { env, input } = fixture(vi.fn().mockResolvedValue(body));
		await expect(runClef(env, input)).resolves.toMatchObject({
			ok: false,
			reason: "malformed",
		});
	});

	it.each([0, 0.5, 1, -0.01, 1.01, NaN, Infinity, "0.5"])(
		"preserves noul bounds for %s",
		async (noul) => {
			const { env, input } = fixture(
				vi.fn().mockResolvedValue({ answers: { decision: { noul } } }),
			);
			input.questions.decision = { type: "noul", instructions: "Score" };
			const result = await runClef(env, input);
			if (typeof noul === "number" && noul >= 0 && noul <= 1) {
				expect(result).toMatchObject({
					ok: true,
					answers: { decision: { type: "noul", noul } },
				});
			} else {
				expect(result).toMatchObject({ ok: false, reason: "malformed" });
			}
		},
	);

	it.each([undefined, -1, 2, NaN, "0.8"])(
		"defaults invalid or missing confidence %s to zero without requiring a probability sum",
		async (confidence) => {
			const body = response();
			const { env, input } = fixture(
				vi.fn().mockResolvedValue({
					answers: { decision: { ...body.answers.decision, confidence } },
				}),
			);
			await expect(runClef(env, input)).resolves.toMatchObject({
				ok: true,
				answers: { decision: { ...body.answers.decision, confidence: 0 } },
			});
		},
	);

	it.each([-0.01, 1.01, NaN, Infinity, "0.5"])(
		"rejects an invalid choice probability %s",
		async (p) => {
			const body = response();
			const { env, input } = fixture(
				vi.fn().mockResolvedValue({
					answers: {
						decision: { ...body.answers.decision, probabilities: { yes: p } },
					},
				}),
			);
			await expect(runClef(env, input)).resolves.toMatchObject({
				ok: false,
				reason: "malformed",
			});
		},
	);

	it("fails soft when the provider rejects", async () => {
		const { env, input } = fixture(
			vi.fn().mockRejectedValue(Error("provider failed")),
		);
		await expect(runClef(env, input)).resolves.toEqual({
			ok: false,
			reason: "error",
			latencyMs: 0,
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([undefined, 50])(
		"aborts at the configured timeout %s and handles a late rejection",
		async (timeoutMs) => {
			let rejectProvider!: (error: Error) => void;
			const { env, input, run } = fixture(
				vi.fn(
					() =>
						new Promise((_resolve, reject) => {
							rejectProvider = reject;
						}),
				),
			);
			input.timeoutMs = timeoutMs;
			const limit = timeoutMs ?? CLEF_TIMEOUT_MS;
			const pending = runClef(env, input);
			const signal = run.mock.calls[0]![2].signal as AbortSignal;
			await vi.advanceTimersByTimeAsync(limit - 1);
			expect(signal.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await expect(pending).resolves.toEqual({
				ok: false,
				reason: "timeout",
				latencyMs: limit,
			});
			expect(signal.aborted).toBe(true);
			rejectProvider(Error("late provider failure"));
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});
