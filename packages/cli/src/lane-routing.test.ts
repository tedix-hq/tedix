import { describe, expect, it } from "bun:test";
import {
	describeRoutingPolicy,
	describeUsage,
	nearUsageLimit,
	routeLocalWork,
	routingPolicySchema,
	executorBackoff,
	statedResetAt,
	parseBudgetSignal,
	resumeThenFresh,
	LocalExecutorCapacityError,
} from "./lane-routing";
import { testRoutingPolicy } from "./lane-routing.fixture";

const available = {
	codex: { available: true },
	"claude-code": { available: true },
	cursor: { available: true },
	opencode: { available: true },
	devin: { available: true },
	tedi: { available: false },
};
describe("local capability routing", () => {
	it("retains each route's settings when pinned or falling back and rejects incompatible modes", () => {
		const policy = structuredClone(testRoutingPolicy);
		policy.rules[0]!.routes[0] = {
			executor: "codex",
			limits: { maxTurns: 3 },
			effort: "high",
			permission: { sandbox: "read-only", approval: "never" },
		};
		policy.rules[0]!.routes[1] = {
			executor: "claude-code",
			effort: "low",
			permission: { mode: "dontAsk" },
		};
		policy.rules[1]!.routes = policy.rules[1]!.routes.filter(
			(route) => route.executor !== "codex",
		);
		const parsed = routingPolicySchema.parse(policy);
		expect(
			routeLocalWork(
				{ executor: "codex", size: "small" },
				parsed,
				available,
				{},
			),
		).toMatchObject({
			limits: { maxTurns: 3 },
			effort: "high",
			permission: { sandbox: "read-only", approval: "never" },
		});
		expect(
			routeLocalWork(
				{ executor: "any-local", risk: "high" },
				parsed,
				{ ...available, codex: { available: false } },
				{},
			),
		).toMatchObject({
			executor: "claude-code",
			effort: "low",
			permission: { mode: "dontAsk" },
		});
		policy.rules[0]!.routes[1]!.permission = { sandbox: "danger-full-access" };
		expect(() => routingPolicySchema.parse(policy)).toThrow(
			"only supported by Codex",
		);
	});
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
					cursor: { available: true },
					opencode: { available: true },
					tedi: { available: false },
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
describe("fair test routing", () => {
	const share = (value: number) => {
		const policy = structuredClone(testRoutingPolicy);
		policy.explorationShare = value;
		return policy;
	};
	it("sends a deterministic share of comparable work to another eligible agent, recorded", () => {
		const policy = share(1);
		const first = routeLocalWork(
			{ executor: "any-local", id: "work-a", risk: "low" },
			policy,
			available,
			{},
		);
		expect(first.executor).not.toBe("codex");
		expect(first.exploration).toEqual({ share: 1, topPick: "codex" });
		expect(
			routeLocalWork(
				{ executor: "any-local", id: "work-a", risk: "low" },
				policy,
				available,
				{},
			).executor,
		).toBe(first.executor);
		const explored = Array.from({ length: 40 }, (_, index) =>
			routeLocalWork(
				{ executor: "any-local", id: `probe-${index}`, risk: "medium" },
				share(0.15),
				available,
				{},
			),
		).filter((route) => route.exploration);
		expect(explored.length).toBeGreaterThan(0);
		expect(explored.length).toBeLessThan(40);
		for (const route of explored) {
			expect(route.executor).not.toBe(route.exploration!.topPick);
			expect(route.exploration!.share).toBe(0.15);
		}
	});
	it("never explores high or critical risk, pinned agents, missing ids, or a zero share", () => {
		const policy = share(1);
		for (const risk of ["high", "critical"] as const)
			expect(
				routeLocalWork(
					{ executor: "any-local", id: "work-b", risk },
					policy,
					available,
					{},
				).exploration,
			).toBeUndefined();
		expect(
			routeLocalWork(
				{ executor: "any-local", risk: "low" },
				policy,
				available,
				{},
			).exploration,
		).toBeUndefined();
		expect(
			routeLocalWork(
				{ executor: "codex", id: "work-b", risk: "low" },
				policy,
				available,
				{},
			).exploration,
		).toBeUndefined();
		expect(
			routeLocalWork(
				{ executor: "any-local", id: "work-b", risk: "low" },
				share(0),
				available,
				{},
			).exploration,
		).toBeUndefined();
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
	it("keeps each Codex window, plan and credit balance", () => {
		const snapshot = parseBudgetSignal(
			{
				limit_id: "codex",
				plan_type: "pro",
				primary: {
					used_percent: 96,
					window_minutes: 10080,
					resets_at: 1_800_000_000,
				},
				credits: { has_credits: true, unlimited: false, balance: "79.85" },
				secret: "never retained",
			},
			1000,
		);
		expect(snapshot.plan).toBe("pro");
		expect(snapshot.windows).toEqual([
			{ name: "Credits", detail: "79.85 left" },
			{
				name: "codex Weekly",
				usedPercent: 96,
				resetAt: 1_800_000_000_000,
			},
		]);
		expect(snapshot.remainingPercent).toBe(4);
		expect(JSON.stringify(snapshot)).not.toContain("secret");
		expect(nearUsageLimit(snapshot)).toBe(true);
	});
	it("reads Claude's unified windows and per-model shares", () => {
		const snapshot = parseBudgetSignal(
			{
				status: "allowed",
				rateLimitType: "seven_day",
				resetsAt: 1_800_000_000,
				unifiedWindows: {
					five_hour: { utilization: 0.09, resetsAt: 1_799_000_000 },
					seven_day: { utilization: 0.96, resetsAt: 1_800_000_000 },
					seven_day_overage_included: {
						utilization: 0.5,
						resetsAt: 1_800_000_000,
					},
				},
			},
			1000,
		);
		expect(snapshot.remainingPercent).toBe(4);
		expect(snapshot.windows?.map((window) => window.name)).toEqual([
			"5-hour",
			"Weekly",
			"Weekly extra usage",
		]);
		expect(snapshot.windows?.[1]?.usedPercent).toBeCloseTo(96);
		expect(nearUsageLimit(snapshot)).toBe(true);
	});
	it("describes plan, each limit with its reset and the tool's own note", () => {
		const snapshot = parseBudgetSignal(
			{
				limit_id: "codex",
				plan_type: "pro",
				primary: { used_percent: 42, window_minutes: 10080, resets_at: 0 },
				credits: { has_credits: true, unlimited: false, balance: "79.85" },
			},
			1000,
		);
		snapshot.note = "From session records.";
		snapshot.estimatedCostUsd = 1.25;
		const text = describeUsage(snapshot);
		expect(text).toContain("pro");
		expect(text).toContain("Credits: 79.85 left");
		expect(text).toContain("Weekly: 42% used");
		expect(text).toContain("cost $1.25 today");
		expect(text).toContain("From session records.");
		expect(nearUsageLimit(snapshot)).toBe(false);
		expect(describeUsage(undefined)).toBe("");
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
			"A fair-test share of 15% of low and medium risk tasks goes to a different eligible agent; each choice is recorded.",
		]);
	});
	it("lists one plain line per kind of task only when rules differ", () => {
		expect(describeRoutingPolicy(testRoutingPolicy)).toEqual([
			"Each kind of task goes to its own tool.",
			"Large or risky tasks go to Codex, then Claude Code, then OpenCode.",
			"Small routine tasks go to OpenCode, then Claude Code, then Codex, then Devin.",
			"Everything else goes to Codex, then Claude Code, then OpenCode, then Devin.",
			"A fair-test share of 15% of low and medium risk tasks goes to a different eligible agent; each choice is recorded.",
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
		).toEqual([
			"Right now no agent takes tasks.",
			"A fair-test share of 15% of low and medium risk tasks goes to a different eligible agent; each choice is recorded.",
		]);
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

describe("each tool's stated reset time", () => {
	const now = new Date(2026, 10, 22, 20, 0).getTime();
	it.each([
		[
			`Claude AI usage limit reached|${new Date(2026, 10, 22, 23, 0).getTime() / 1000}`,
			new Date(2026, 10, 22, 23, 0).getTime(),
		],
		[
			"5-hour limit reached ∙ resets 9pm",
			new Date(2026, 10, 22, 21, 0).getTime(),
		],
		[
			"You've hit your limit · resets 3:30 AM (Europe/Berlin)",
			new Date(2026, 10, 23, 3, 30).getTime(),
		],
		[
			"429 quota exceeded; resets at 2026-11-23T01:00:00Z",
			Date.parse("2026-11-23T01:00:00Z"),
		],
	])("reads %s", (message, expected) => {
		expect(statedResetAt(message, now)).toBe(expected);
		expect(executorBackoff(message, undefined, now)?.backoffUntil).toBe(
			expected,
		);
	});
	it("guesses a short doubling wait when no time is stated", () => {
		expect(
			executorBackoff("529 overloaded", undefined, now)?.backoffUntil,
		).toBe(now + 60_000);
	});
});
