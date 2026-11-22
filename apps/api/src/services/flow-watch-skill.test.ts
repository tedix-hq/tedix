import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	evaluateWatchRule,
	WATCH_WORKFLOW_SOURCE,
	watchSkillId,
} from "./flow-watch-skill";

describe("evaluateWatchRule", () => {
	const status = {
		workItemId: "w1",
		disposition: "completed",
		nested: { count: 3 },
		updatedAt: null,
	};

	it("matches in, eq and gte rules and nothing else", () => {
		expect(
			evaluateWatchRule(
				{ path: "disposition", in: ["failed", "completed"] },
				status,
			),
		).toBe(true);
		expect(
			evaluateWatchRule({ path: "disposition", in: ["accepted"] }, status),
		).toBe(false);
		expect(
			evaluateWatchRule({ path: "disposition", eq: "completed" }, status),
		).toBe(true);
		expect(evaluateWatchRule({ path: "updatedAt", eq: null }, status)).toBe(
			true,
		);
		expect(evaluateWatchRule({ path: "nested.count", gte: 3 }, status)).toBe(
			true,
		);
		expect(evaluateWatchRule({ path: "nested.count", gte: 4 }, status)).toBe(
			false,
		);
		// gte never coerces a string, and a missing or inherited key never matches.
		expect(evaluateWatchRule({ path: "disposition", gte: 0 }, status)).toBe(
			false,
		);
		expect(evaluateWatchRule({ path: "missing", eq: undefined }, status)).toBe(
			false,
		);
		expect(
			evaluateWatchRule({ path: "constructor", in: [Object] }, status),
		).toBe(false);
		expect(evaluateWatchRule({ path: "disposition" }, status)).toBe(false);
	});
});

/** Load the shipped source and drive it with a fake step and clock. */
function runWatch(
	params: Record<string, unknown>,
	reads: Array<Record<string, unknown> | Error>,
) {
	const module = new Function(
		WATCH_WORKFLOW_SOURCE.replace("export default", "return"),
	)() as {
		run: (event: unknown, step: unknown, env: unknown) => Promise<unknown>;
	};
	let now = Date.parse("2026-11-22T12:00:00.000Z");
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const sleeps: number[] = [];
	let checks = 0;
	const step = {
		do: async (_name: string, _config: unknown, fn: () => Promise<unknown>) =>
			fn(),
		sleep: async (_name: string, ms: number) => {
			sleeps.push(ms);
			now += ms;
		},
	};
	const env = {
		MCP: {
			tedi: {
				check_work_item_watch: async () => {
					const next = reads[Math.min(checks++, reads.length - 1)]!;
					if (next instanceof Error) throw next;
					return next;
				},
			},
		},
	};
	return {
		result: module.run(
			{
				payload: {
					workItemId: "w1",
					until: { path: "disposition", in: ["completed"] },
					everySeconds: 15,
					maxChecks: 10,
					deadlineAt: "2026-11-22T12:01:00.000Z",
					...params,
				},
			},
			step,
			env,
		),
		sleeps,
		checkCount: () => checks,
	};
}

const item = (disposition: string) => ({
	workItemId: "w1",
	disposition,
	updatedAt: "2026-11-22T12:00:00.000Z",
	title: "never leaves the step",
});

describe("watch workflow source", () => {
	afterEach(() => vi.restoreAllMocks());

	it("ends on the first matching check with only the status fields", async () => {
		const run = runWatch({}, [
			item("accepted"),
			item("accepted"),
			item("completed"),
		]);
		await expect(run.result).resolves.toEqual({
			outcome: "matched",
			checks: 3,
			status: {
				workItemId: "w1",
				disposition: "completed",
				updatedAt: "2026-11-22T12:00:00.000Z",
			},
			matchedAt: "2026-11-22T12:00:30.000Z",
		});
		expect(run.sleeps).toEqual([15_000, 15_000]);
	});

	it("shortens the last wait to the deadline, then ends", async () => {
		const run = runWatch({ everySeconds: 25 }, [item("accepted")]);
		await expect(run.result).resolves.toMatchObject({
			outcome: "deadline",
			checks: 4,
		});
		expect(run.sleeps).toEqual([25_000, 25_000, 10_000]);
	});

	it("stops at once when the starter's access is revoked", async () => {
		const run = runWatch({}, [
			item("accepted"),
			new Error(
				"FORBIDDEN: ACCESS_REVOKED: the watch's starter can no longer read Work",
			),
		]);
		await expect(run.result).resolves.toMatchObject({
			outcome: "check_failed",
			checks: 2,
			status: { disposition: "accepted" },
		});
	});

	it("counts failed reads against maxChecks and gives up after three in a row", async () => {
		const run = runWatch({ maxChecks: 2 }, [new Error("upstream timeout")]);
		await expect(run.result).resolves.toMatchObject({
			outcome: "max_checks",
			checks: 2,
		});
		const failing = runWatch({}, [new Error("upstream timeout")]);
		await expect(failing.result).resolves.toMatchObject({
			outcome: "check_failed",
			checks: 3,
		});
	});

	it("uses one stable skill id per organization", async () => {
		const id = await watchSkillId("org-1");
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(await watchSkillId("org-1")).toBe(id);
		expect(await watchSkillId("org-2")).not.toBe(id);
	});
});
