import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AskHomeInput, McpCallOptions } from "./home-client";
import { askHomeOnce, HomeSubmissionUnresolvedError } from "./home-submission";

const timers: ReturnType<typeof setTimeout>[] = [];
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
	for (const timer of timers.splice(0)) clearTimeout(timer);
	spyOn(globalThis, "setTimeout").mockRestore();
});

function clock() {
	const deadlines: { ms: number | undefined; fire: () => void }[] = [];
	spyOn(globalThis, "setTimeout").mockImplementation(
		Object.assign(
			(...[callback, ms, ...args]: Parameters<typeof setTimeout>) => {
				const timer = originalSetTimeout(() => {}, 60_000);
				timers.push(timer);
				deadlines.push({
					ms,
					fire: () => {
						clearTimeout(timer);
						callback(...args);
					},
				});
				return timer;
			},
			{ __promisify__: originalSetTimeout.__promisify__ },
		),
	);
	return deadlines;
}

async function flush() {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

function deferred() {
	let resolve!: (value: unknown) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<unknown>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function harness() {
	const ask = deferred();
	const runSet = deferred();
	const run = deferred();
	let submitted!: AskHomeInput;
	let askSignal: AbortSignal | undefined;
	let readSignal: AbortSignal | undefined;
	const client = {
		askHome: mock((input: AskHomeInput, options?: McpCallOptions) => {
			submitted = input;
			askSignal = options?.signal;
			return ask.promise;
		}),
		readHomeRunSet: mock(() => runSet.promise),
		readHomeRun: mock((_id: string, signal?: AbortSignal) => {
			readSignal = signal;
			return run.promise;
		}),
	};
	return {
		client,
		ask,
		runSet,
		run,
		get submissionId() {
			return submitted.metadata?.clientSubmissionId;
		},
		get askSignal() {
			return askSignal;
		},
		get readSignal() {
			return readSignal;
		},
		matchingRuns() {
			return {
				runs: [
					{ id: "exact-run", status: "running", metadata: submitted.metadata },
					{
						id: "other-run",
						status: "completed",
						metadata: { clientSubmissionId: "other" },
					},
				],
			};
		},
	};
}

const input = { content: "hello", conversationId: "home:cli:test" };

describe("Home submission recovery deadlines", () => {
	for (const timeoutMs of [7, undefined]) {
		for (const stage of ["run-set", "exact-run"] as const) {
			test(`${stage} read is bounded with timeout ${timeoutMs ?? "default"}`, async () => {
				const deadlines = clock();
				const h = harness();
				let failure: unknown;
				const pending = askHomeOnce({ client: h.client, ...input, timeoutMs });
				void pending.catch((error) => {
					failure = error;
				});
				expect(deadlines[0]?.ms).toBe(timeoutMs ?? 30_000);
				deadlines[0]?.fire();
				await flush();
				expect(h.askSignal?.aborted).toBe(true);
				if (stage === "exact-run") {
					h.runSet.resolve(h.matchingRuns());
					await flush();
					expect(h.client.readHomeRun.mock.calls[0]?.[0]).toBe("exact-run");
				}
				const deadline = deadlines[stage === "run-set" ? 1 : 2];
				expect(deadline?.ms).toBe(timeoutMs ?? 30_000);
				expect(failure).toBeUndefined();
				deadline?.fire();
				await flush();
				expect(failure).toBeInstanceOf(HomeSubmissionUnresolvedError);
				expect(failure).toMatchObject({
					clientSubmissionId: h.submissionId,
					homeRunId: stage === "exact-run" ? "exact-run" : undefined,
					cause: new Error(
						stage === "exact-run"
							? "READ_HOME_RUN_TIMEOUT"
							: "READ_HOME_RUN_SET_TIMEOUT",
					),
				});
				expect((failure as Error).message).toContain(
					stage === "exact-run" ? "tedix tail exact-run" : "tedix runs",
				);
				if (stage === "exact-run") expect(h.readSignal?.aborted).toBe(true);
				// A timed-out transport can still complete after the helper returns.
				h.runSet.resolve(h.matchingRuns());
				h.run.resolve({ run: { id: "exact-run", status: "completed" } });
				h.ask.reject(new Error("late submission rejection"));
				await flush();
				expect(h.client.askHome).toHaveBeenCalledTimes(1);
				expect(h.client.readHomeRun).toHaveBeenCalledTimes(
					stage === "exact-run" ? 1 : 0,
				);
			});
		}
	}

	for (const stage of ["run-set", "exact-run"] as const) {
		test(`late ${stage} rejection is handled after timeout`, async () => {
			const deadlines = clock();
			const h = harness();
			const pending = askHomeOnce({ client: h.client, ...input, timeoutMs: 7 });
			const observed = pending.catch((error: unknown) => error);
			h.ask.reject(new Error("connection closed"));
			await flush();
			if (stage === "exact-run") {
				h.runSet.resolve(h.matchingRuns());
				await flush();
			}
			const deadline = deadlines[stage === "run-set" ? 1 : 2];
			expect(deadline).toBeDefined();
			deadline?.fire();
			await flush();
			expect(await observed).toBeInstanceOf(HomeSubmissionUnresolvedError);
			(stage === "run-set" ? h.runSet : h.run).reject(
				new Error("late network error"),
			);
			await flush();
			expect(h.client.askHome).toHaveBeenCalledTimes(1);
		});
	}

	test("recovers only the matching submission and hydrates its answer", async () => {
		clock();
		const h = harness();
		const pending = askHomeOnce({ client: h.client, ...input, timeoutMs: 7 });
		h.ask.reject(new Error("connection closed"));
		h.runSet.resolve(h.matchingRuns());
		h.run.resolve({
			run: {
				id: "exact-run",
				status: "completed",
				metadata: {
					kernelRoute: {
						routeKind: "answer_in_home",
						answer: "Recovered answer",
					},
				},
			},
		});
		expect(await pending).toMatchObject({
			recovered: true,
			summary: { homeRunId: "exact-run", assistantText: "Recovered answer" },
		});
		expect(h.readSignal?.aborted).toBe(false);
		expect(h.client.askHome).toHaveBeenCalledTimes(1);
	});

	for (const stage of ["run-set", "exact-run"] as const) {
		test(`authentication rejection during ${stage} recovery preserves uncertainty`, async () => {
			clock();
			const h = harness();
			const pending = askHomeOnce({ client: h.client, ...input });
			const observed = pending.catch((error: unknown) => error);
			h.ask.reject(new Error("connection closed"));
			await flush();
			if (stage === "exact-run") {
				h.runSet.resolve(h.matchingRuns());
				await flush();
			}
			const cause = new Error("401 Unauthorized");
			(stage === "run-set" ? h.runSet : h.run).reject(cause);
			expect(await observed).toMatchObject({
				name: "HomeSubmissionUnresolvedError",
				cause,
				clientSubmissionId: h.submissionId,
				homeRunId: stage === "exact-run" ? "exact-run" : undefined,
			});
			expect(h.client.askHome).toHaveBeenCalledTimes(1);
		});
	}

	test("authentication rejection never starts recovery", async () => {
		clock();
		const h = harness();
		const pending = askHomeOnce({ client: h.client, ...input });
		const error = new Error("401 Unauthorized network error");
		h.ask.reject(error);
		await expect(pending).rejects.toBe(error);
		expect(h.client.askHome).toHaveBeenCalledTimes(1);
		expect(h.client.readHomeRunSet).not.toHaveBeenCalled();
	});
});
