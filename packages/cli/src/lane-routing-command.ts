import { executionSettings } from "./lane-execution-settings";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { probeTediLane } from "./lane-executor-probe";
import { readRunnerDuties } from "./supervise-runners";
import {
	describeRoutingPolicy,
	describeUsage,
	localExecutors,
	nearUsageLimit,
	readRoutingPolicy,
	type BudgetSnapshot,
	type ExecutorBudgets,
	type LocalExecutor,
} from "./lane-routing";

const NAMES: Record<LocalExecutor, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
	opencode: "OpenCode",
	devin: "Devin",
	tedi: "Tedi",
};

/**
 * Each tool's availability as this Mac's runners last saw it, from the
 * back-off they record for native setup failures and usage limits.
 */
export function toolAvailability(
	env: NodeJS.ProcessEnv = process.env,
	now = Date.now(),
	directory?: { root: string; single: boolean },
) {
	const root =
		directory?.root ??
		join(env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"), "dispatchers");
	const until: Partial<Record<LocalExecutor, number>> = {};
	const snapshots: Partial<Record<LocalExecutor, BudgetSnapshot>> = {};
	const blocked: Partial<Record<LocalExecutor, BudgetSnapshot>> = {};
	let names: string[] = [];
	try {
		names = directory?.single ? [""] : readdirSync(root);
	} catch {}
	for (const name of names) {
		try {
			const budgets = JSON.parse(
				readFileSync(join(root, name, "budgets.state"), "utf8"),
			) as ExecutorBudgets;
			for (const executor of localExecutors) {
				const snapshot = budgets[executor];
				const end = snapshot?.backoffUntil ?? 0;
				if (end > now && end > (until[executor] ?? 0)) {
					until[executor] = end;
					blocked[executor] = snapshot;
				}
				if (
					snapshot &&
					(snapshot.observedAt ?? 0) > (snapshots[executor]?.observedAt ?? -1)
				)
					snapshots[executor] = snapshot;
			}
		} catch {}
	}
	return localExecutors.map((executor) => {
		const end = until[executor];
		const usage = describeUsage(snapshots[executor]);
		return {
			executor,
			available: !end,
			until: end ? new Date(end).toISOString() : null,
			description: end
				? `${NAMES[executor]}: ${blocked[executor]?.backoffKind === "preparation" ? "could not start a task, trying again around" : "out of credits or at its usage limit, back around"} ${new Date(end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
				: `${NAMES[executor]}: available`,
			usage: usage || undefined,
			nearLimit: nearUsageLimit(snapshots[executor]),
		};
	});
}

/** The routing file runners on this Mac read, or none when none is set. */
export function routingConfigPath(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const at = args.indexOf("--routing-config");
	if (at >= 0 && args[at + 1]) return resolve(args[at + 1]!);
	if (env.TEDIX_LANE_ROUTING_CONFIG)
		return resolve(env.TEDIX_LANE_ROUTING_CONFIG);
	const file = join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"lane-routing.json",
	);
	return existsSync(file) ? file : undefined;
}

/** `tedix lane routing`: shows the routing file and what it does. Changes nothing. */
export async function runLaneRouting(
	args: string[],
	options: { json?: boolean; workspace?: string; organization?: string } = {},
): Promise<number> {
	const path = routingConfigPath(args);
	const policy = readRoutingPolicy(path);
	const description = describeRoutingPolicy(policy);
	const settings = policy.rules.flatMap((rule) =>
		rule.routes
			.filter((route) => route.executor !== "tedi")
			.map((route) => ({
				rule: rule.name,
				executor: route.executor,
				...executionSettings(route.executor, route),
			})),
	);
	const env = process.env;
	const tools = toolAvailability().map((tool) => {
		if (tool.executor !== "tedi") return tool;
		const scope =
			options.workspace && options.organization
				? { workspace: options.workspace, organization: options.organization }
				: undefined;
		let slug = policy.tedi;
		if (!slug) {
			try {
				slug = readRunnerDuties(env).find(
					(duty) =>
						duty.enabled &&
						duty.tedi &&
						(!scope ||
							(duty.workspace === scope.workspace &&
								duty.organization === scope.organization)),
				)?.tedi;
			} catch {}
		}
		const status = probeTediLane(slug, env, scope);
		return {
			...tool,
			available: tool.available && status.available,
			description: `${status.available ? tool.description : `Tedi: unavailable — ${status.reason}`}. Runs Work through a cloud tedi using this Mac's machine tools.`,
		};
	});
	if (options.json || args.includes("--json")) {
		console.log(
			JSON.stringify({
				path: path ?? null,
				policy,
				description,
				settings,
				tools,
			}),
		);
		return 0;
	}
	console.log(
		path
			? `Routing file: ${path}\nEdit it to change which agent takes which tasks; runners read it at their next start.\n`
			: "No routing file is set. Each runner takes only the tasks assigned to its own agent.\n",
	);
	for (const line of description) console.log(`- ${line}`);
	console.log("\nExecution settings:");
	for (const route of settings)
		console.log(
			`- ${route.rule} / ${NAMES[route.executor]}: effort ${route.effort}; permissions ${JSON.stringify(route.permission)}`,
		);
	console.log("\nRight now:");
	for (const tool of tools) {
		console.log(`- ${tool.description}`);
		if (tool.usage) console.log(`  ${tool.usage}`);
	}
	return 0;
}
