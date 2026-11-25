import { describe, expect, test } from "bun:test";
import { retryRead, readBudgetMs } from "./read-retry";
import { CliReadError, readJsonChild } from "./hooks/hook-io";
import { undeliveredAnswers } from "./hooks/answer-delivery";

describe("one read retry budget", () => {
	test("bounds growing call slices and jitter by the original deadline", async () => {
		let now = 0;
		const slices: number[] = [];
		const waits: number[] = [];
		const logs: Array<Record<string, unknown>> = [];
		await expect(
			retryRead(
				async (ms) => {
					slices.push(ms);
					now += ms;
					throw new Error("Native call deadline elapsed");
				},
				{
					operation: "heartbeat",
					budgetMs: 2000,
					attemptMs: 300,
					now: () => now,
					random: () => 0.5,
					wait: async (ms) => {
						waits.push(ms);
						now += ms;
					},
					log: (line) => logs.push(JSON.parse(line)),
				},
			),
		).rejects.toThrow("Native call deadline elapsed");
		expect(slices).toEqual([300, 600, 350]);
		expect(waits).toEqual([250, 500]);
		expect(now).toBe(2000);
		expect(new Set(logs.map((row) => row.budgetId)).size).toBe(1);
		expect(logs.at(-1)?.event).toBe("read-failed");
	});

	test.each([
		new CliReadError("denied", "FORBIDDEN", 403),
		new CliReadError("stale", "CONFLICT", 409),
		new Error("Tedix CLI returned invalid JSON"),
		new Error("Tedix CLI read output exceeds byte limit"),
		new DOMException("Aborted", "AbortError"),
	])("does not retry a terminal failure: %s", async (error) => {
		let calls = 0;
		await expect(
			retryRead(
				async () => {
					calls++;
					throw error;
				},
				{
					operation: "claim",
					budgetMs: 1000,
					attemptMs: 300,
					log: () => {},
				},
			),
		).rejects.toBe(error);
		expect(calls).toBe(1);
	});

	test.each([
		"Could not submit evidence: Internal Server Error",
		"fetch failed: connection error",
		`Tedix CLI read failed (exit 2): {"message":"MCP tool error: The organization's tool policy could not be verified; no action was executed."}`,
		`Tedix CLI read failed (exit 2): {"message":"ECONNRESET: The socket connection was closed unexpectedly. [traceId: 00000000-0000-4000-8000-000000000000]"}`,
		`Tedix CLI read failed (exit 2): {"message":"MCP tools/call error: \\"external_agent_validation_unavailable\\" [traceId: 00000000-0000-4000-8000-000000000000]"}`,
	])(
		"retries a server fault reported as a message only: %s",
		async (message) => {
			let calls = 0;
			expect(
				await retryRead(
					async () => {
						if (++calls < 3) throw new CliReadError(message);
						return "read";
					},
					{
						operation: "dispatch-get",
						budgetMs: 60_000,
						attemptMs: 20_000,
						wait: async () => {},
						log: () => {},
					},
				),
			).toBe("read");
			expect(calls).toBe(3);
		},
	);

	test.each([
		`Tedix CLI read failed (exit 2): {"message":"MCP tool error: FORBIDDEN: Work Item completion requires its owner or steward"}`,
		`Tedix CLI read failed (exit 2): {"message":"MCP tool error: FORBIDDEN: policy_unavailable for this Attempt"}`,
		`Tedix CLI read failed (exit 2): {"message":"MCP tool error: CONFLICT: Attempt is no longer current"}`,
		"Tedix CLI read failed (exit 1): Error: not signed in",
	])("keeps a refusal reported as a message final: %s", async (message) => {
		let calls = 0;
		await expect(
			retryRead(
				async () => {
					calls++;
					throw new CliReadError(message);
				},
				{
					operation: "dispatch-get",
					budgetMs: 60_000,
					attemptMs: 20_000,
					wait: async () => {},
					log: () => {},
				},
			),
		).rejects.toThrow(message);
		expect(calls).toBe(1);
	});

	test("caps immediate transient retries and scales the load ceiling", async () => {
		let calls = 0;
		await expect(
			retryRead(
				async () => {
					calls++;
					throw new CliReadError("busy", "SERVICE_UNAVAILABLE", 503);
				},
				{
					operation: "claim",
					budgetMs: 60_000,
					attemptMs: 20_000,
					wait: async () => {},
					log: () => {},
				},
			),
		).rejects.toThrow("busy");
		expect(calls).toBe(4);
		expect(readBudgetMs(60_000, 1)).toBe(60_000);
		expect(readBudgetMs(60_000, 20)).toBe(300_000);
		expect(readBudgetMs(60_000, 100)).toBe(300_000);
	});

	test("undelivered answers retry the read without acknowledging delivery", async () => {
		let calls = 0;
		const answers = await undeliveredAnswers(
			{
				read: async (args) => {
					expect(args.at(-1)).toContain(
						"list_undelivered_work_interaction_responses",
					);
					if (++calls === 1) throw new Error("Tedix CLI read deadline elapsed");
					return { data: [], observedAt: new Date().toISOString() };
				},
			},
			{ command: ["-w", "fixture"], user: "fixture" },
			{},
			2000,
		);
		expect(answers).toEqual([]);
		expect(calls).toBe(2);
	});

	test("20 parallel lanes recover real child read deadlines", async () => {
		const logs: Array<Record<string, unknown>> = [];
		const laneCount = 20;
		const operations = ["claim", "heartbeat", "undelivered-answers"] as const;
		const results = await Promise.allSettled(
			Array.from({ length: laneCount }, async (_, lane) => {
				const operation = operations[lane % operations.length];
				const key = `${lane}:${operation}`;
				const respond = (n: number) =>
					`process.stdout.write(${JSON.stringify(JSON.stringify({ key, n }))})`;
				let attempt = 0;
				const value = await retryRead(
					(ms) =>
						readJsonChild(
							process.execPath,
							[
								"-e",
								attempt++ === 0
									? `setTimeout(()=>${respond(1)},5000)`
									: respond(2),
							],
							ms,
						),
					{
						operation: key,
						budgetMs: 20_000,
						attemptMs: 2_000,
						log: (line) => logs.push(JSON.parse(line)),
					},
				);
				expect(value).toEqual({ key, n: 2 });
			}),
		);
		expect(results.filter((row) => row.status === "rejected")).toEqual([]);
		expect(logs.filter((row) => row.event === "read-retry")).toHaveLength(
			laneCount,
		);
		expect(logs.filter((row) => row.event === "read-succeeded")).toHaveLength(
			laneCount,
		);
		expect(logs.filter((row) => row.event === "read-failed")).toEqual([]);
		expect(new Set(logs.map((row) => row.budgetId)).size).toBe(laneCount);
	}, 30_000);
});
