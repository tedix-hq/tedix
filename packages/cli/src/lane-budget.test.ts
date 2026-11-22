import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cachedExecutorBudgets,
	readExecutorBudgets,
	recordExecutorUsageSignal,
} from "./lane-budget";
import * as laneSubprocess from "./lane-command";
import {
	defaultRoutingPolicy,
	readRoutingPolicy,
	routeLocalWork,
} from "./lane-routing";
import { testRoutingPolicy } from "./lane-routing.fixture";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
it("reads native usage and explicit plan caps, omitting secrets and keeping absent allowances unknown", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-budget-test-"));
	dirs.push(dir);
	const sessions = join(dir, "sessions", "2026", "10", "21");
	mkdirSync(sessions, { recursive: true });
	const at = new Date().toISOString();
	writeFileSync(
		join(sessions, "rollout.jsonl"),
		JSON.stringify({
			timestamp: at,
			payload: { rate_limits: { primary: { used_percent: 96 } } },
			token: "never-project-this",
		}) + "\n",
	);
	const cap = join(dir, "plan.json");
	writeFileSync(
		cap,
		JSON.stringify(
			{ session_limit: 10, sessions_used: 9, token: "never-project-this" },
			null,
			2,
		),
	);
	const policy = structuredClone(defaultRoutingPolicy);
	policy.budgetFiles = { devin: [cap] };
	const command = spyOn(laneSubprocess, "laneCommand");
	try {
		const budgets = await readExecutorBudgets(policy, {
			PATH: "/missing",
			TEDIX_CONFIG_DIR: join(dir, "config"),
			CODEX_HOME: dir,
			CLAUDE_CONFIG_DIR: join(dir, "absent"),
		});
		expect(budgets.codex?.remainingPercent).toBe(4);
		expect(budgets.devin?.remainingPercent).toBe(10);
		expect(budgets["claude-code"]?.source).toBe("unknown");
		expect(budgets.opencode?.remainingPercent).toBeUndefined();
		expect(JSON.stringify(budgets)).not.toContain("never-project-this");
		const options = command.mock.calls[0]?.[2];
		expect(options?.killSignal).toBe("SIGKILL");
		expect(options?.timeout).toBeGreaterThan(0);
	} finally {
		command.mockRestore();
	}
});
it("keeps the freshest run signal and says plainly what a tool does not expose", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-usage-test-"));
	dirs.push(dir);
	const env = {
		PATH: "/missing",
		TEDIX_CONFIG_DIR: join(dir, "config"),
		CODEX_HOME: join(dir, "codex"),
		CLAUDE_CONFIG_DIR: join(dir, "claude"),
	};
	const policy = structuredClone(defaultRoutingPolicy);
	const command = spyOn(laneSubprocess, "laneCommand");
	try {
		recordExecutorUsageSignal(
			"claude-code",
			{
				status: "allowed",
				unifiedWindows: {
					seven_day: { utilization: 0.96, resetsAt: 4_000_000_000 },
				},
			},
			env,
		);
		recordExecutorUsageSignal("devin", { unrelated: true }, env);
		const budgets = await readExecutorBudgets(policy, env);
		expect(budgets["claude-code"]?.windows?.[0]?.usedPercent).toBeCloseTo(96);
		expect(budgets["claude-code"]?.note).toBeUndefined();
		expect(budgets.devin?.note).toContain("no scriptable account read");
		expect(budgets.opencode?.note).toContain("exposes no plan quota");
		expect(budgets.codex?.note).toContain("session records");
	} finally {
		command.mockRestore();
	}
});

it("uses an optional launcher-adjacent OpenCode default, with explicit policy taking precedence", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-config-test-"));
	dirs.push(dir);
	writeFileSync(
		join(dir, "opencode-routing.json"),
		JSON.stringify({ defaultModel: "fictional/model" }),
	);
	const env = { TEDIX_LANE_LOG: join(dir, "lane.log") };
	expect(readRoutingPolicy(undefined, env).opencodeModel).toBe(
		"fictional/model",
	);
	const path = join(dir, "routing.json");
	writeFileSync(path, JSON.stringify(defaultRoutingPolicy));
	expect(readRoutingPolicy(path, env).opencodeModel).toBeUndefined();
});

it("does not select an automatic executor without an operator policy, while retaining named assignments", () => {
	const policy = readRoutingPolicy(undefined, {});
	const available = {
		codex: { available: true },
		"claude-code": { available: true },
		opencode: { available: true },
		devin: { available: true },
	};
	expect(policy.rules.flatMap((rule) => rule.routes)).toEqual([]);
	expect(() =>
		routeLocalWork({ executor: "any-local" }, policy, available, {}),
	).toThrow("--routing-config");
	for (const executor of ["codex", "claude-code", "devin"] as const) {
		expect(routeLocalWork({ executor }, policy, available, {})).toMatchObject({
			executor,
			model: undefined,
		});
	}
});

it("uses explicit choices without merging managed preferences and fails closed on missing or invalid files", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-policy-test-"));
	dirs.push(dir);
	const path = join(dir, "routing.json");
	const configured = structuredClone(testRoutingPolicy);
	configured.rules = [
		{
			name: "only-configured",
			tags: [],
			sizes: [],
			risks: [],
			routes: [{ executor: "devin", model: "fictional-choice" }],
		},
	];
	writeFileSync(path, JSON.stringify(configured));
	const policy = readRoutingPolicy(path, {});
	expect(policy).toEqual(configured);
	expect(
		routeLocalWork(
			{ executor: "any-local" },
			policy,
			{
				codex: { available: true },
				"claude-code": { available: true },
				opencode: { available: true },
				devin: { available: true },
			},
			{},
		).executor,
	).toBe("devin");
	writeFileSync(path, JSON.stringify({ ...configured, version: 2 }));
	expect(() => readRoutingPolicy(path, {})).toThrow();
	expect(() => readRoutingPolicy(join(dir, "missing.json"), {})).toThrow();
});

it("shares budget probes until the cache expires and retries rejected reads", async () => {
	let now = 0;
	let calls = 0;
	let failed = false;
	const read = cachedExecutorBudgets(
		async () => {
			calls++;
			if (failed) throw new Error("unavailable");
			return {};
		},
		() => now,
	);
	await Promise.all([read(defaultRoutingPolicy), read(defaultRoutingPolicy)]);
	expect(calls).toBe(1);
	now = 60_000;
	failed = true;
	await expect(read(defaultRoutingPolicy)).rejects.toThrow("unavailable");
	failed = false;
	await read(defaultRoutingPolicy);
	expect(calls).toBe(3);
});
