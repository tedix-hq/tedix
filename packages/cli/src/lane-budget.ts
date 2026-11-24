import { laneCommand } from "./lane-command";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { laneChildEnv } from "./lane-child-env";
import {
	localExecutors,
	parseBudgetSignal,
	type BudgetSnapshot,
	type ExecutorBudgets,
	type LocalExecutor,
	type RoutingPolicy,
} from "./lane-routing";

function configDir(env: NodeJS.ProcessEnv): string {
	return env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix");
}
function usageSignalPath(env: NodeJS.ProcessEnv, executor: LocalExecutor) {
	return join(configDir(env), "tool-usage", `${executor}.json`);
}
/** Keep the freshest usage a tool reported during a run, for later reads. */
export function recordExecutorUsageSignal(
	executor: LocalExecutor,
	signal: unknown,
	env = process.env,
) {
	try {
		const snapshot = parseBudgetSignal(signal);
		if (snapshot.source === "unknown") return;
		snapshot.observedAt = Date.now();
		const path = usageSignalPath(env, executor);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		try {
			const prior = JSON.parse(readFileSync(path, "utf8")) as BudgetSnapshot;
			if (
				typeof prior.observedAt === "number" &&
				prior.observedAt > snapshot.observedAt
			)
				return;
		} catch {
			/* No earlier signal or an unreadable one; the new one wins. */
		}
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
		renameSync(temporary, path);
	} catch {
		/* Recording usage never affects the run that reported it. */
	}
}
/** What each tool does and does not expose, in plain words. */
const USAGE_EXPOSURE: Record<LocalExecutor, (policy: RoutingPolicy) => string> =
	{
		codex: () =>
			"Codex reports plan and window usage in its own session records.",
		"claude-code": () =>
			"Claude Code reports window usage during a run; Tedix records it after each run.",
		opencode: (policy) => {
			const provider = policy.opencodeModel?.split("/")[0];
			return `OpenCode exposes no plan quota${provider ? `; the configured model runs on ${provider}` : ""} — cost comes from opencode stats.`;
		},
		devin: () =>
			"Devin CLI exposes usage only inside a session (`/usage`); there is no scriptable account read.",
		tedi: () => "Tedi exposes no plan quota.",
	};

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
export async function readExecutorBudgets(
	policy: RoutingPolicy,
	env = process.env,
): Promise<ExecutorBudgets> {
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
							event.payload?.rate_limits ??
								event.rate_limit_info ??
								event.apiErrorParams?.rate_limit_info ??
								event.quotaLimits ??
								event,
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
			const stats = await laneCommand("opencode", ["stats", "--days", "1"], {
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
		try {
			const saved = JSON.parse(
				readFileSync(usageSignalPath(env, executor), "utf8"),
			) as BudgetSnapshot;
			if (
				saved &&
				saved.source !== "unknown" &&
				(best.source === "unknown" ||
					(saved.observedAt ?? 0) >= best.observedAt)
			)
				best = saved;
		} catch {
			/* No recorded run signal yet. */
		}
		if (!best.plan && !best.windows?.length)
			best.note = USAGE_EXPOSURE[executor](policy);
		result[executor] = best;
	}
	return result;
}

/** Budget sampling need not spawn OpenCode more than once per minute. */
export function cachedExecutorBudgets(
	read = readExecutorBudgets,
	now = Date.now,
) {
	let cached:
		| { policy: RoutingPolicy; at: number; result: Promise<ExecutorBudgets> }
		| undefined;
	return (policy: RoutingPolicy) => {
		if (cached?.policy === policy && now() - cached.at < 60_000)
			return cached.result;
		const result = read(policy);
		cached = { policy, at: now(), result };
		result.catch(() => {
			if (cached?.result === result) cached = undefined;
		});
		return result;
	};
}
