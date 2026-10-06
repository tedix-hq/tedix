import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { measureMiningPhase } from "./mining-phase-timing";

const context = { url: new URL("https://api/rpc/skills/mineCandidates") };

afterEach(() => vi.restoreAllMocks());

describe("mining phase diagnostics", () => {
	it("records the unfinished phase before awaiting and preserves the result", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		let finish!: (value: object) => void;
		const value = { privateEpisode: "not a log field" };
		const operation = vi.fn(
			() =>
				new Promise<object>((resolve) => {
					finish = resolve;
				}),
		);
		const clock = vi.spyOn(Date, "now").mockReturnValue(100);
		const pending = measureMiningPhase(context, "mining.episodes", operation);
		expect(info.mock.calls).toEqual([
			[
				{
					event: "mining_rpc_phase",
					phase: "mining.episodes",
					status: "started",
					elapsedMs: 0,
				},
			],
		]);
		clock.mockReturnValue(450);
		finish(value);
		expect(await pending).toBe(value);
		expect(operation).toHaveBeenCalledTimes(1);
		expect(info.mock.calls[1]).toEqual([
			{
				event: "mining_rpc_phase",
				phase: "mining.episodes",
				status: "succeeded",
				elapsedMs: 350,
			},
		]);
	});

	it.each([false, true])(
		"preserves sync/async exceptions without logging their contents (async=%s)",
		async (asynchronous) => {
			vi.spyOn(console, "info").mockImplementation(() => {});
			const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
			const failure = new Error("SQL and private bindings must stay private");
			const operation = vi.fn(() => {
				if (asynchronous) return Promise.reject(failure);
				throw failure;
			});
			await expect(
				measureMiningPhase(context, "auth.user", operation),
			).rejects.toBe(failure);
			expect(operation).toHaveBeenCalledTimes(1);
			expect(errorLog.mock.calls).toEqual([
				[
					{
						event: "mining_rpc_phase",
						phase: "auth.user",
						status: "failed",
						elapsedMs: expect.any(Number),
					},
				],
			]);
		},
	);

	it("ignores unrelated endpoints and preserves their errors", async () => {
		const info = vi.spyOn(console, "info");
		const errorLog = vi.spyOn(console, "error");
		const other = {
			url: new URL("https://api/rpc/skills/listByOrg?secret=private"),
		};
		expect(await measureMiningPhase(other, "auth.user", async () => 42)).toBe(
			42,
		);
		const failure = new Error("private");
		await expect(
			measureMiningPhase(other, "auth.user", async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(info).not.toHaveBeenCalled();
		expect(errorLog).not.toHaveBeenCalled();
	});

	it("does not read request headers, query parameters or returned content", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const sensitiveContext = {
			url: new URL("https://api/rpc/skills/mineCandidates?token=private"),
			get headers(): never {
				throw new Error("headers must not be inspected");
			},
		};
		await measureMiningPhase(sensitiveContext, "mining.dedupe", async () => ({
			content: "private",
		}));
		expect(info.mock.calls).toHaveLength(2);
		for (const [event] of info.mock.calls) {
			expect(Object.keys(event).sort()).toEqual([
				"elapsedMs",
				"event",
				"phase",
				"status",
			]);
		}
		expect(JSON.stringify(info.mock.calls)).not.toContain("private");
	});

	it("isolates logging failures from both successful and failed operations", async () => {
		vi.spyOn(console, "info").mockImplementation(() => {
			throw new Error("logger failed");
		});
		vi.spyOn(console, "error").mockImplementation(() => {
			throw new Error("logger failed");
		});
		expect(await measureMiningPhase(context, "auth.user", async () => 42)).toBe(
			42,
		);
		const failure = new Error("original failure");
		await expect(
			measureMiningPhase(context, "auth.user", async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
	});
});
