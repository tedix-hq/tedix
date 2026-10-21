import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExecutorBudgets } from "./lane-budget";
import { defaultRoutingPolicy, readRoutingPolicy } from "./lane-routing";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
it("reads native usage and explicit plan caps, omitting secrets and keeping absent allowances unknown", () => {
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
	const budgets = readExecutorBudgets(policy, {
		PATH: "/missing",
		CODEX_HOME: dir,
		CLAUDE_CONFIG_DIR: join(dir, "absent"),
	});
	expect(budgets.codex?.remainingPercent).toBe(4);
	expect(budgets.devin?.remainingPercent).toBe(10);
	expect(budgets["claude-code"]?.source).toBe("unknown");
	expect(budgets.opencode?.remainingPercent).toBeUndefined();
	expect(JSON.stringify(budgets)).not.toContain("never-project-this");
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
