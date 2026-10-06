import { describe, expect, test } from "bun:test";
import type { AskHomeInput, McpCallOptions } from "./home-client";
import { askHomeOnce, HomeSubmissionUnresolvedError } from "./home-submission";
import { formatInkInteractiveHelp } from "./interactive-ink";

test("interactive help makes multiline, queue and activity controls discoverable", () => {
	const help = formatInkInteractiveHelp();
	expect(help).toContain("/sessions");
	expect(help).toContain("Alt+Enter newline");
	expect(help).toContain("Shift+Enter newline if supported");
	expect(help).toContain("Ctrl+Q queue");
	expect(help).toContain("PgUp/PgDn activity");
	expect(help).toContain("Ctrl+G mode");
});

function harness(error?: Error) {
	let askCount = 0;
	let readCount = 0;
	let submitted: AskHomeInput | undefined;
	let signal: AbortSignal | undefined;
	let runs: Record<string, unknown>[] = [];
	const client = {
		askHome: async (input: AskHomeInput, options?: McpCallOptions) => {
			askCount++;
			submitted = input;
			signal = options?.signal;
			if (error) throw error;
			return await new Promise<never>(() => {});
		},
		readHomeRun: async (id: string) => ({
			run: runs.find((run) => run.id === id),
		}),
		readHomeRunSet: async (input: {
			conversationId?: string;
			limit?: number;
		}) => {
			readCount++;
			expect(input).toEqual({ conversationId: "home:cli:test", limit: 5 });
			return { runs };
		},
	};
	return {
		client,
		get askCount() {
			return askCount;
		},
		get readCount() {
			return readCount;
		},
		get submitted() {
			return submitted;
		},
		get signal() {
			return signal;
		},
		setRuns(value: Record<string, unknown>[]) {
			runs = value;
		},
	};
}
const input = {
	content: "hello",
	conversationId: "home:cli:test",
	metadata: { source: "test" },
	timeoutMs: 1,
};

describe("shared CLI and TUI Home submission recovery", () => {
	test("recovers the exact submission even when a different turn is newer", async () => {
		const h = harness();
		const pending = askHomeOnce({ client: h.client, ...input });
		h.setRuns([
			{
				id: "my-run",
				status: "running",
				createdAt: "2026-09-14T01:00:00Z",
				metadata: h.submitted?.metadata,
			},
			{
				id: "other-run",
				status: "completed",
				createdAt: "2026-09-14T02:00:00Z",
				metadata: { clientSubmissionId: "other" },
			},
		]);
		expect(await pending).toMatchObject({
			summary: { homeRunId: "my-run", status: "running", assistantText: "" },
			recovered: true,
		});
		expect(h.askCount).toBe(1);
		expect(h.signal?.aborted).toBe(true);
		expect(h.submitted?.metadata?.source).toBe("test");
	});

	for (const error of [
		new Error("ASK_HOME_TIMEOUT"),
		new Error("MCP -32001 request timed out"),
		new Error("connection closed"),
	]) {
		test(`recovers ${error.message} without redispatch`, async () => {
			const h = harness(error);
			const pending = askHomeOnce({ client: h.client, ...input });
			h.setRuns([
				{ id: "my-run", status: "running", metadata: h.submitted?.metadata },
			]);
			expect((await pending).summary.homeRunId).toBe("my-run");
			expect(h.askCount).toBe(1);
			expect(h.readCount).toBe(1);
		});
	}

	for (const runs of [
		[],
		[{ id: "other", metadata: { clientSubmissionId: "other" } }],
		[{ id: "legacy-run" }],
	]) {
		test("refuses unrelated or absent runs and does not invite resubmission", async () => {
			const h = harness();
			h.setRuns(runs);
			const pending = askHomeOnce({ client: h.client, ...input });
			await expect(pending).rejects.toBeInstanceOf(
				HomeSubmissionUnresolvedError,
			);
			await expect(pending).rejects.toThrow(
				"It was not resent; check `tedix runs` before retrying",
			);
			expect(h.askCount).toBe(1);
		});
	}

	test("preserves successful acknowledgements without a recovery read", async () => {
		const h = harness();
		const client = {
			...h.client,
			askHome: async () => ({
				run: {
					id: "ack-run",
					status: "completed",
					metadata: {
						kernelRoute: { routeKind: "answer_in_home", answer: "hello" },
					},
				},
			}),
		};
		const result = await askHomeOnce({ client, ...input });
		expect(result.recovered).toBe(false);
		expect(result.summary.homeRunId).toBe("ack-run");
		expect(result.summary.assistantText).toBe("hello");
		expect(h.readCount).toBe(0);
	});

	for (const error of [
		new Error("401 Unauthorized network error"),
		new Error("invalid parameters"),
	]) {
		test(`does not recover a hard failure: ${error.message}`, async () => {
			const h = harness(error);
			await expect(askHomeOnce({ client: h.client, ...input })).rejects.toBe(
				error,
			);
			expect(h.readCount).toBe(0);
			expect(h.askCount).toBe(1);
		});
	}

	test("hydrates the answer of a run completed before recovery", async () => {
		const h = harness(new Error("connection closed"));
		const pending = askHomeOnce({ client: h.client, ...input });
		h.setRuns([
			{
				id: "completed-run",
				status: "completed",
				metadata: {
					...h.submitted?.metadata,
					kernelRoute: {
						routeKind: "answer_in_home",
						answer: "The recommendation is to fix recovery.",
					},
				},
			},
		]);
		const result = await pending;
		expect(result.summary.status).toBe("completed");
		expect(result.summary.assistantText).toBe(
			"The recommendation is to fix recovery.",
		);
		expect(h.askCount).toBe(1);
	});

	test("preserves the exact run ID when its detail read fails", async () => {
		const h = harness(new Error("connection closed"));
		const client = {
			...h.client,
			readHomeRun: async () => {
				throw new Error("network error");
			},
		};
		const pending = askHomeOnce({ client, ...input });
		h.setRuns([{ id: "accepted-run", metadata: h.submitted?.metadata }]);
		await expect(pending).rejects.toThrow("tedix tail accepted-run");
		expect(h.askCount).toBe(1);
	});

	test("refuses a mismatched detail read instead of showing another answer", async () => {
		const h = harness(new Error("connection closed"));
		const client = {
			...h.client,
			readHomeRun: async () => ({
				run: { id: "wrong-run", status: "completed" },
			}),
		};
		const pending = askHomeOnce({ client, ...input });
		h.setRuns([{ id: "accepted-run", metadata: h.submitted?.metadata }]);
		await expect(pending).rejects.toThrow("tedix tail accepted-run");
		expect(h.askCount).toBe(1);
	});

	test("does not reuse a supplied submission identity for a new send", async () => {
		const h = harness();
		const pending = askHomeOnce({
			client: h.client,
			...input,
			metadata: { clientSubmissionId: "old-submission" },
		});
		expect(h.submitted?.metadata?.clientSubmissionId).not.toBe(
			"old-submission",
		);
		await expect(pending).rejects.toBeInstanceOf(HomeSubmissionUnresolvedError);
	});

	test("failed recovery reads never trigger another ask", async () => {
		const h = harness(new Error("connection closed"));
		const client = {
			...h.client,
			readHomeRunSet: async () => {
				throw new Error("network error");
			},
		};
		await expect(askHomeOnce({ client, ...input })).rejects.toBeInstanceOf(
			HomeSubmissionUnresolvedError,
		);
		expect(h.askCount).toBe(1);
	});
});
