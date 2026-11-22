import { describe, expect, it } from "bun:test";
import {
	describeRoutingPolicy,
	routeLocalWork,
	executorBackoff,
	parseBudgetSignal,
	resumeThenFresh,
	LocalExecutorCapacityError,
} from "./lane-routing";
import { testRoutingPolicy } from "./lane-routing.fixture";

const available = {
	codex: { available: true },
	"claude-code": { available: true },
	opencode: { available: true },
	devin: { available: true },
};
describe("local capability routing", () => {
	it("uses the first configured route for small mechanical work", () => {
		expect(
			routeLocalWork(
				{ executor: "any-local", tags: ["mechanical"], size: "small" },
				testRoutingPolicy,
				available,
				{},
			).executor,
		).toBe("opencode");
	});
	it("keeps security work on strong routes even with mechanical tags", () => {
		const route = routeLocalWork(
			{
				executor: "any-local",
				tags: ["mechanical", "security"],
				size: "small",
			},
			testRoutingPolicy,
			available,
			{},
		);
		expect(route.executor).toBe("codex");
		expect(route.rule).toBe("hard");
	});
	it.each([
		["codex", 10],
		["codex", 0],
		["any-local", 10],
		["any-local", 0],
	] as const)(
		"keeps Codex eligible for %s at %i reported allowance",
		(executor, remainingPercent) => {
			const now = 1_000_000;
			const budget = {
				observedAt: now,
				source: "native" as const,
				remainingPercent,
				resetAt: now + 5000,
			};
			expect(
				routeLocalWork(
					{ executor },
					testRoutingPolicy,
					available,
					{ codex: budget },
					now,
				).executor,
			).toBe("codex");
			expect(budget.remainingPercent).toBe(remainingPercent);
			expect(() =>
				routeLocalWork(
					{ executor: "codex" },
					testRoutingPolicy,
					available,
					{ codex: { ...budget, backoffUntil: now + 5000 } },
					now,
				),
			).toThrow(LocalExecutorCapacityError);
			expect(
				routeLocalWork(
					{ executor: "any-local" },
					testRoutingPolicy,
					available,
					{ codex: { ...budget, backoffUntil: now + 5000 } },
					now,
				).executor,
			).not.toBe("codex");
		},
	);

	it("falls back on near limits, cooldown and unavailable backends", () => {
		const now = Date.now();
		expect(
			routeLocalWork(
				{ executor: "any-local" },
				testRoutingPolicy,
				{ ...available, opencode: { available: false } },
				{
					codex: {
						observedAt: now,
						source: "error",
						backoffUntil: now + 5000,
					},
					"claude-code": {
						observedAt: now,
						source: "native",
						remainingPercent: 2,
						resetAt: now + 5000,
					},
				},
				now,
			).executor,
		).toBe("devin");
	});
	it("pins the executor but takes its configured route model", () => {
		expect(
			routeLocalWork({ executor: "devin" }, testRoutingPolicy, available, {})
				.model,
		).toBe("general-devin");
		expect(
			routeLocalWork(
				{ executor: "devin", tags: ["mechanical"] },
				testRoutingPolicy,
				available,
				{},
			).model,
		).toBe("small-devin");
	});
	it("uses the pinned executor's configured model from another rule", () => {
		const route = routeLocalWork(
			{ executor: "devin", tags: ["security"], risk: "high" },
			testRoutingPolicy,
			available,
			{},
		);
		expect(route.executor).toBe("devin");
		expect(route.rule).toBe("hard");
		expect(route.model).toBe("small-devin");
	});
	it("keeps the native default when no rule routes the pinned executor", () => {
		const policy = structuredClone(testRoutingPolicy);
		for (const rule of policy.rules)
			rule.routes = rule.routes.filter((route) => route.executor !== "devin");
		expect(
			routeLocalWork({ executor: "devin" }, policy, available, {}).model,
		).toBeUndefined();
	});
	it("never changes a pinned assignment and never downgrades outside the rule", () => {
		expect(() =>
			routeLocalWork({ executor: "codex" }, testRoutingPolicy, available, {
				codex: {
					observedAt: Date.now(),
					source: "error",
					backoffUntil: Date.now() + 5000,
				},
			}),
		).toThrow("No eligible");
		expect(() =>
			routeLocalWork(
				{ executor: "any-local", risk: "high" },
				testRoutingPolicy,
				{
					...available,
					codex: { available: false },
					"claude-code": { available: false },
					opencode: { available: false },
				},
				{},
			),
		).toThrow("No eligible");
	});
	it("types only known active capacity pauses without relaxing the route", () => {
		const now = 1_000_000;
		for (const { executor, budget } of [
			{
				executor: "claude-code",
				budget: {
					observedAt: now,
					source: "native" as const,
					remainingPercent: 10,
					resetAt: now + 1000,
				},
			},
			{
				executor: "codex",
				budget: {
					observedAt: 1,
					source: "error" as const,
					backoffUntil: now + 1000,
				},
			},
		]) {
			expect(() =>
				routeLocalWork(
					{ executor },
					testRoutingPolicy,
					available,
					{ [executor]: budget },
					now,
				),
			).toThrow(LocalExecutorCapacityError);
			try {
				routeLocalWork(
					{ executor },
					testRoutingPolicy,
					{ ...available, [executor]: { available: false } },
					{ [executor]: budget },
					now,
				);
				throw new Error("Unavailable executor unexpectedly admitted");
			} catch (error) {
				expect(error).not.toBeInstanceOf(LocalExecutorCapacityError);
				expect(String(error)).toContain("No eligible local executor");
			}
		}
		expect(() =>
			routeLocalWork(
				{ executor: "unknown" },
				testRoutingPolicy,
				available,
				{},
				now,
			),
		).not.toThrow(LocalExecutorCapacityError);
	});

	it("names each rejected route's cause in the skip reason", () => {
		const now = 1_000_000;
		let thrown: unknown;
		try {
			routeLocalWork(
				{ executor: "any-local" },
				testRoutingPolicy,
				{
					codex: {
						available: false,
						reason: "codex --version exited 1 after 87 ms",
					},
					"claude-code": { available: true },
					opencode: { available: true },
					devin: {
						available: false,
						reason: "devin --version timed out after 5000 ms",
					},
				},
				{
					"claude-code": {
						observedAt: now,
						source: "native",
						remainingPercent: 2,
						resetAt: now + 5000,
					},
					opencode: {
						observedAt: now,
						source: "error",
						backoffUntil: now + 60_000,
					},
				},
				now,
			);
		} catch (error) {
			thrown = error;
		}
		const message = String(thrown);
		expect(thrown).toBeInstanceOf(LocalExecutorCapacityError);
		expect(message).toContain("No eligible local executor for general");
		expect(message).toContain("codex: codex --version exited 1 after 87 ms");
		expect(message).toContain(
			`claude-code: 2% remaining is at or below the 10% near-limit until ${new Date(now + 5000).toISOString()}`,
		);
		expect(message).toContain(
			`opencode: budget backoff until ${new Date(now + 60_000).toISOString()}`,
		);
		expect(message).toContain("devin: devin --version timed out after 5000 ms");
		expect(message).toContain(
			"assignments and capability requirements retained",
		);
	});
	it("names the probe cause when a pinned executor is unavailable", () => {
		expect(() =>
			routeLocalWork(
				{ executor: "codex" },
				testRoutingPolicy,
				{
					...available,
					codex: {
						available: false,
						reason: "codex --version timed out after 5000 ms",
					},
				},
				{},
			),
		).toThrow(
			"No eligible local executor for general (codex: codex --version timed out after 5000 ms); assignments and capability requirements retained",
		);
	});
	it("pauses instead of failing when the version probe only timed out", () => {
		expect(() =>
			routeLocalWork(
				{ executor: "codex" },
				testRoutingPolicy,
				{
					...available,
					codex: {
						available: false,
						transient: true,
						reason: "codex --version timed out twice",
					},
				},
				{},
			),
		).toThrow(LocalExecutorCapacityError);
	});
	it("ignores expired native readings but preserves an explicit cooldown", () => {
		expect(
			routeLocalWork(
				{ executor: "any-local" },
				testRoutingPolicy,
				available,
				{ codex: { observedAt: 1, source: "native", remainingPercent: 0 } },
				1_000_000,
			).executor,
		).toBe("codex");
	});
});
describe("budget observations", () => {
	it("projects Codex windows conservatively without carrying arbitrary fields", () => {
		const snapshot = parseBudgetSignal(
			{
				primary: { used_percent: 95, resets_at: 2000 },
				secondary: { used_percent: 30 },
				secret: "never retained",
			},
			1000,
		);
		expect(snapshot.remainingPercent).toBe(5);
		expect(snapshot.resetAt).toBe(2_000_000);
		expect(JSON.stringify(snapshot)).not.toContain("secret");
	});
	it("accepts Claude utilization and Devin session cap observations", () => {
		expect(
			parseBudgetSignal({
				five_hour: { utilization: 92, resets_at: "2026-10-22T00:00:00Z" },
			}).remainingPercent,
		).toBe(8);
		expect(
			parseBudgetSignal({ sessions_used: 9, session_limit: 10 })
				.remainingPercent,
		).toBe(10);
	});
	it("does not turn estimated cost into remaining credit", () => {
		const snapshot = parseBudgetSignal({ estimatedCostUsd: 1.25 });
		expect(snapshot.estimatedCostUsd).toBe(1.25);
		expect(snapshot.remainingPercent).toBeUndefined();
	});
	it("backs off rate limits exponentially and honors retry-after", () => {
		expect(
			executorBackoff("429 rate limit; retry-after: 900", undefined, 1000)
				?.backoffUntil,
		).toBe(901000);
		const first = executorBackoff("usage limit reached", undefined, 1000)!;
		expect(
			executorBackoff("rate limit", first, 2000)!.backoffUntil,
		).toBeGreaterThan(first.backoffUntil!);
		expect(executorBackoff("file missing", undefined, 1000)).toBeUndefined();
	});
	it.each(["9".repeat(310), "10000000000000"])(
		"keeps a reportable, persistent cooldown for oversized retry-after %s",
		(retryAfter) => {
			const first = executorBackoff("429", undefined, 1000)!;
			const next = executorBackoff(
				`429 retry-after: ${retryAfter}`,
				first,
				2000,
			)!;
			expect(next.backoffUntil).toBe(122000);
			expect(new Date(next.backoffUntil!).toISOString()).toBe(
				"1970-01-01T00:02:02.000Z",
			);
			const persisted = JSON.parse(JSON.stringify(next));
			expect(persisted.backoffUntil).toBe(122000);
			expect(() =>
				routeLocalWork(
					{ executor: "codex" },
					testRoutingPolicy,
					available,
					{ codex: persisted },
					2000,
				),
			).toThrow("No eligible");
		},
	);
});
describe("routing description", () => {
	it("summarizes in one line when every rule names the same agents", () => {
		const policy = structuredClone(testRoutingPolicy);
		for (const rule of policy.rules)
			rule.routes = [{ executor: "codex" }, { executor: "claude-code" }];
		expect(describeRoutingPolicy(policy)).toEqual([
			"Right now every task goes to Codex, then Claude Code.",
		]);
	});
	it("lists one plain line per kind of task only when rules differ", () => {
		expect(describeRoutingPolicy(testRoutingPolicy)).toEqual([
			"Each kind of task goes to its own tool.",
			"Large or risky tasks go to Codex, then Claude Code, then OpenCode.",
			"Small routine tasks go to OpenCode, then Claude Code, then Codex, then Devin.",
			"Everything else goes to Codex, then Claude Code, then OpenCode, then Devin.",
		]);
	});
	it("names no tags, rule names, model ids or budget without a budget file", () => {
		const text = describeRoutingPolicy(testRoutingPolicy).join("\n");
		expect(text).not.toContain("“");
		expect(text).not.toContain("(");
		expect(text).not.toContain("hard");
		expect(text).not.toContain("mechanical");
		expect(text).not.toContain("security");
		expect(text).not.toContain("example");
		expect(text).not.toContain("out of budget");
	});
	it("mentions the budget threshold only when a budget file is configured", () => {
		const policy = structuredClone(testRoutingPolicy);
		policy.budgetFiles = { codex: ["/private/codex-usage.jsonl"] };
		const lines = describeRoutingPolicy(policy);
		expect(lines.at(-1)).toBe(
			"An agent counts as out of budget at 10% or less of its allowance left.",
		);
	});
	it("says when no agent takes tasks", () => {
		expect(
			describeRoutingPolicy({
				version: 1,
				nearLimitPercent: 10,
				signalMaxAgeMs: 300_000,
				rules: [
					{ name: "unconfigured", tags: [], sizes: [], risks: [], routes: [] },
				],
				budgetFiles: {},
			}),
		).toEqual(["Right now no agent takes tasks."]);
	});
});
describe("resume recovery before admission", () => {
	it("resumes first and allocates fresh only for missing native state", async () => {
		const events: string[] = [];
		const result = await resumeThenFresh(
			async () => {
				events.push("resume");
				throw new Error("rollout not found");
			},
			async () => {
				events.push("fresh");
				return "new";
			},
		);
		expect(result).toBe("new");
		expect(events).toEqual(["resume", "fresh"]);
	});
	it("allocates fresh when the retained session is archived", async () => {
		const events: string[] = [];
		const result = await resumeThenFresh(
			async () => {
				events.push("resume");
				throw new Error(
					"session 019a1b2c is archived. Run `codex unarchive` to restore it.",
				);
			},
			async () => {
				events.push("fresh");
				return "new";
			},
		);
		expect(result).toBe("new");
		expect(events).toEqual(["resume", "fresh"]);
	});
	it("does not hide auth, rate-limit, or backend failures as a missing session", async () => {
		let fresh = false;
		await expect(
			resumeThenFresh(
				async () => {
					throw new Error("backend stopped");
				},
				async () => {
					fresh = true;
				},
			),
		).rejects.toThrow("backend stopped");
		expect(fresh).toBe(false);
	});
});

describe("a tool's own limit message", () => {
	it("backs off until the time the tool names", () => {
		const now = new Date(2026, 10, 22, 19, 0).getTime();
		const next = executorBackoff(
			'{"message":"You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 23rd, 2026 12:18 AM.","codexErrorInfo":"usageLimitExceeded"}',
			undefined,
			now,
		);
		expect(next?.backoffUntil).toBe(new Date(2026, 10, 23, 0, 18).getTime());
	});
});
