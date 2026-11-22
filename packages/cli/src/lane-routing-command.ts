import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	describeRoutingPolicy,
	localExecutors,
	readRoutingPolicy,
	type ExecutorBudgets,
	type LocalExecutor,
} from "./lane-routing";

const NAMES: Record<LocalExecutor, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
	opencode: "OpenCode",
	devin: "Devin",
};

/**
 * Each tool's availability as this Mac's runners last saw it, from the
 * back-off they record when a tool reports a usage limit or no credits.
 */
export function toolAvailability(
	env: NodeJS.ProcessEnv = process.env,
	now = Date.now(),
) {
	const root = join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"dispatchers",
	);
	const until: Partial<Record<LocalExecutor, number>> = {};
	let names: string[] = [];
	try {
		names = readdirSync(root);
	} catch {}
	for (const name of names) {
		try {
			const budgets = JSON.parse(
				readFileSync(join(root, name, "budgets.state"), "utf8"),
			) as ExecutorBudgets;
			for (const executor of localExecutors) {
				const end = budgets[executor]?.backoffUntil ?? 0;
				if (end > now && end > (until[executor] ?? 0)) until[executor] = end;
			}
		} catch {}
	}
	return localExecutors.map((executor) => {
		const end = until[executor];
		return {
			executor,
			available: !end,
			until: end ? new Date(end).toISOString() : null,
			description: end
				? `${NAMES[executor]}: out of credits or at its usage limit, back around ${new Date(end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
				: `${NAMES[executor]}: available`,
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
	options: { json?: boolean } = {},
): Promise<number> {
	const path = routingConfigPath(args);
	const policy = readRoutingPolicy(path);
	const description = describeRoutingPolicy(policy);
	const tools = toolAvailability();
	if (options.json || args.includes("--json")) {
		console.log(
			JSON.stringify({ path: path ?? null, policy, description, tools }),
		);
		return 0;
	}
	console.log(
		path
			? `Routing file: ${path}\nEdit it to change which agent takes which tasks; runners read it at their next start.\n`
			: "No routing file is set. Each runner takes only the tasks assigned to its own agent.\n",
	);
	for (const line of description) console.log(`- ${line}`);
	console.log("\nRight now:");
	for (const tool of tools) console.log(`- ${tool.description}`);
	return 0;
}
