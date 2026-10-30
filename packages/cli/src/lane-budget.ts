import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { laneChildEnv } from "./lane-child-env";
import {
	localExecutors,
	parseBudgetSignal,
	type BudgetSnapshot,
	type ExecutorBudgets,
	type RoutingPolicy,
} from "./lane-routing";

function tail(path: string) {
	const fd = openSync(path, "r");
	try {
		const size = statSync(path).size;
		const bytes = Buffer.alloc(Math.min(size, 128 * 1024));
		readSync(fd, bytes, 0, bytes.length, size - bytes.length);
		return bytes.toString();
	} finally {
		closeSync(fd);
	}
}
function recentFiles(root: string, depth: number): string[] {
	try {
		const paths = readdirSync(root)
			.map((name) => join(root, name))
			.map((path) => ({ path, stat: statSync(path) }))
			.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
			.slice(0, 3);
		return paths.flatMap(({ path, stat }) =>
			stat.isDirectory() && depth > 0
				? recentFiles(path, depth - 1)
				: stat.isFile() && path.endsWith(".jsonl")
					? [path]
					: [],
		);
	} catch {
		return [];
	}
}
/** Read usage records, never credential/configuration stores or arbitrary stdout. */
export function readExecutorBudgets(
	policy: RoutingPolicy,
	env = process.env,
): ExecutorBudgets {
	const result: ExecutorBudgets = {};
	for (const executor of localExecutors) {
		let best: BudgetSnapshot = { source: "unknown", observedAt: Date.now() };
		const automatic =
			executor === "codex"
				? recentFiles(
						join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
						3,
					)
				: executor === "claude-code"
					? recentFiles(
							join(
								env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
								"projects",
							),
							1,
						)
					: [];
		for (const path of [
			...automatic,
			...(policy.budgetFiles[executor] ?? []),
		]) {
			try {
				const text = tail(path);
				const observedAt = statSync(path).mtimeMs;
				let records: string[];
				try {
					JSON.parse(text);
					records = [text];
				} catch {
					records = text.trim().split("\n");
				}
				for (const line of records) {
					try {
						const event = JSON.parse(line);
						const timestamp =
							typeof event.timestamp === "string"
								? Date.parse(event.timestamp)
								: observedAt;
						const snapshot = parseBudgetSignal(
							event.payload?.rate_limits ?? event.rate_limit_info ?? event,
							Number.isFinite(timestamp) ? timestamp : observedAt,
						);
						if (
							snapshot.source !== "unknown" &&
							(best.source === "unknown" ||
								snapshot.observedAt >= best.observedAt)
						)
							best = snapshot;
					} catch {
						/* A partial first/last transcript line is not a usage signal. */
					}
				}
			} catch {
				/* Missing native usage is unknown, never an inferred allowance. */
			}
		}
		if (executor === "opencode") {
			const stats = spawnSync("opencode", ["stats", "--days", "1"], {
				env: { ...laneChildEnv(env), OPENCODE_DISABLE_AUTOUPDATE: "true" },
				encoding: "utf8",
				timeout: 5000,
				killSignal: "SIGKILL",
				maxBuffer: 128 * 1024,
			});
			const cost =
				stats.status === 0
					? stats.stdout.match(/Total Cost\s*[^\d]*\$([\d.]+)/i)
					: undefined;
			if (cost)
				best = { ...best, estimatedCostUsd: Number(cost[1]), source: "native" };
		}
		result[executor] = best;
	}
	return result;
}
