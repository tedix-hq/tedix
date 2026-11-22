import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describeRoutingPolicy, readRoutingPolicy } from "./lane-routing";

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
	if (options.json || args.includes("--json")) {
		console.log(JSON.stringify({ path: path ?? null, policy, description }));
		return 0;
	}
	console.log(
		path
			? `Routing file: ${path}\nEdit it to change which agent takes which tasks; runners read it at their next start.\n`
			: "No routing file is set. Each runner takes only the tasks assigned to its own agent.\n",
	);
	for (const line of description) console.log(`- ${line}`);
	return 0;
}
