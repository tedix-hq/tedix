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

	test("20 parallel lanes recover real child read deadlines for all three operations", async () => {
		const requests = new Map<string, number>();
		const logs: Array<Record<string, unknown>> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const key = new URL(req.url).pathname;
				const n = (requests.get(key) ?? 0) + 1;
				requests.set(key, n);
				await Bun.sleep(n === 1 ? 1200 : 10);
				return Response.json({ key, n });
			},
		});
		try {
			const results = await Promise.allSettled(
				Array.from({ length: 20 }, async (_, lane) => {
					for (const operation of [
						"claim",
						"heartbeat",
						"undelivered-answers",
					]) {
						const key = `/${lane}/${operation}`;
						const value = await retryRead(
							(ms) =>
								readJsonChild(
									process.execPath,
									[
										"-e",
										`fetch(${JSON.stringify(new URL(key, server.url).href)}).then(r=>r.text()).then(t=>process.stdout.write(t))`,
									],
									ms,
								),
							{
								operation: `${lane}:${operation}`,
								budgetMs: 5000,
								attemptMs: 700,
								log: (line) => logs.push(JSON.parse(line)),
							},
						);
						expect(value).toEqual({ key, n: 2 });
					}
				}),
			);
			expect(results.filter((row) => row.status === "rejected")).toEqual([]);
			expect(requests.size).toBe(60);
			expect([...requests.values()]).toEqual(Array(60).fill(2));
			expect(logs.filter((row) => row.event === "read-retry")).toHaveLength(60);
			expect(logs.filter((row) => row.event === "read-succeeded")).toHaveLength(
				60,
			);
			expect(logs.filter((row) => row.event === "read-failed")).toEqual([]);
			expect(new Set(logs.map((row) => row.budgetId)).size).toBe(60);
		} finally {
			await server.stop(true);
		}
	}, 15_000);
});
