import { spawnSync } from "node:child_process";
import type { ServeOptions } from "./lane-serve";
import {
	LANES_FILE,
	laneDutyFromServeOptions,
	laneKey,
	writeLaneDuty,
} from "./supervise-lanes";
import { LAUNCH_AGENT_LABEL } from "./supervise-drivers";

/** True when the supervisor LaunchAgent is loaded; undefined off macOS. */
export function supervisorLoaded(
	run: (args: string[]) => { status: number | null } = (args) =>
		spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 5000 }),
	platform: NodeJS.Platform = process.platform,
	uid = process.getuid?.() ?? 0,
): boolean | undefined {
	if (platform !== "darwin") return undefined;
	return run(["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]).status === 0;
}

/**
 * `tedix lane serve --install`: records the dispatcher as a duty of the
 * supervisor, which starts it within a minute and keeps it running. No
 * LaunchAgent per dispatcher any more; the supervisor is the one agent.
 */
export function installLaneService(
	options: ServeOptions,
	env: NodeJS.ProcessEnv = process.env,
	loaded: boolean | undefined = supervisorLoaded(),
): number {
	const duty = laneDutyFromServeOptions(options);
	const { replaced } = writeLaneDuty(env, duty);
	const supervisor =
		loaded === undefined
			? "run tedix supervise under your service manager"
			: loaded
				? "running; it starts the dispatcher on its next tick"
				: "not installed; run tedix supervise install";
	console.log(
		JSON.stringify({
			installed: true,
			replaced,
			file: LANES_FILE,
			lane: laneKey(duty),
			duty,
			supervisor,
		}),
	);
	return 0;
}
