import { spawn as nodeSpawn } from "node:child_process";

type Spawn = (
	command: string,
	args: string[],
	options: { stdio: "ignore" },
) => {
	pid?: number;
	kill(): boolean;
	on(event: "error", listener: () => void): unknown;
};

/**
 * Keep a macOS host awake while the supervisor runs, so a runner's Attempt
 * lease does not lapse during idle sleep. `-i` blocks idle sleep; `-s` also
 * blocks lid-close sleep while on AC power. macOS still sleeps on lid close
 * when on battery; no user-level assertion can prevent that. `-w` ends the
 * assertion if the supervisor dies without cleanup.
 */
export function holdAwake(
	log: (message: string) => void,
	options: { platform?: NodeJS.Platform; pid?: number; spawn?: Spawn } = {},
): () => void {
	const platform = options.platform ?? process.platform;
	if (platform !== "darwin") return () => undefined;
	const spawn = options.spawn ?? (nodeSpawn as unknown as Spawn);
	const pid = options.pid ?? process.pid;
	const child = spawn("/usr/bin/caffeinate", ["-i", "-s", "-w", String(pid)], {
		stdio: "ignore",
	});
	child.on("error", () =>
		log("keep-awake: caffeinate could not start; runs may stop during sleep"),
	);
	log(
		"keep-awake: holding idle sleep off (and lid-close sleep while on power)",
	);
	return () => {
		child.kill();
	};
}
