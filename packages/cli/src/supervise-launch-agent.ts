import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { selfCommand } from "./shared";
import {
	alive,
	configDir,
	LAUNCH_AGENT_LABEL,
	pause,
} from "./supervise-drivers";

/** One supervisor per user: a PID file, taken over when its owner is gone. */
export function acquireLock(env: NodeJS.ProcessEnv): (() => void) | undefined {
	const path = join(configDir(env), "supervisor.pid");
	mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
			return () => rmSync(path, { force: true });
		} catch {
			const owner = Number(readFileSync(path, "utf8"));
			if (Number.isInteger(owner) && owner > 0 && alive(owner))
				return undefined;
			rmSync(path, { force: true });
		}
	}
	return undefined;
}

function launchAgentPath(): string {
	return join(
		homedir(),
		"Library",
		"LaunchAgents",
		`${LAUNCH_AGENT_LABEL}.plist`,
	);
}

const xml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");

export function launchAgentPlist(
	program: string[],
	env: NodeJS.ProcessEnv,
): string {
	const logPath = join(configDir(env), "supervisor.launchd.log");
	const variables: Record<string, string> = {
		PATH: env.PATH || "/usr/bin:/bin",
		...(env.TEDIX_CONFIG_DIR ? { TEDIX_CONFIG_DIR: env.TEDIX_CONFIG_DIR } : {}),
		...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}),
	};
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCH_AGENT_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${program.map((arg) => `		<string>${xml(arg)}</string>`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${Object.entries(variables)
	.map(
		([key, value]) =>
			`		<key>${xml(key)}</key>\n		<string>${xml(value)}</string>`,
	)
	.join("\n")}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>60</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${xml(logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

export interface LaunchctlResult {
	status: number;
	output: string;
}
export type Launchctl = (args: string[]) => LaunchctlResult;

export function systemLaunchctl(bin = "launchctl"): Launchctl {
	return (args) => {
		const result = spawnSync(bin, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {
			status: result.status ?? 1,
			output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
		};
	};
}

/**
 * Loads the LaunchAgent at `path` into `domain`, replacing a loaded copy.
 * `bootout` returns before launchd finishes tearing the old job down, so an
 * immediate `bootstrap` fails on a reinstall; wait for the old job to leave,
 * retry the bootstrap, and let `launchctl print` decide the outcome. launchd
 * gives a job 20 seconds to exit before killing it, so the unload wait is
 * longer than that.
 * Returns an error message, or undefined once the job is loaded.
 */
export async function loadLaunchAgent(
	path: string,
	domain: string,
	run: Launchctl,
	{ attempts = 20, unloadAttempts = 120, sleep = pause, delayMs = 250 } = {},
): Promise<string | undefined> {
	const service = `${domain}/${LAUNCH_AGENT_LABEL}`;
	const loaded = () => run(["print", service]).status === 0;
	// "Not loaded" is the fresh-install case, not an error.
	run(["bootout", service]);
	let waited = 0;
	while (loaded()) {
		if (++waited >= unloadAttempts)
			return `the existing ${service} did not unload; run launchctl bootout ${service} and retry.`;
		await sleep(delayMs);
	}
	let last: LaunchctlResult = { status: 1, output: "" };
	for (let attempt = 0; attempt < attempts; attempt++) {
		last = run(["bootstrap", domain, path]);
		if (last.status === 0 || loaded()) break;
		await sleep(delayMs);
	}
	if (loaded()) return undefined;
	return `launchctl bootstrap ${domain} failed (exit ${last.status}${last.output ? `: ${last.output}` : ""}).`;
}

const realPath = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

/**
 * After `tedix update` or `tedix rollback` replaced the file at `target`:
 * when the loaded supervisor runs that file, unload it and load it again.
 * A plain restart is not enough: macOS refuses to start the loaded job once
 * its program file was replaced ("Code Signature Invalid"), so the service
 * would stay down after its next exit. Returns one sentence on what
 * happened, or undefined when no loaded supervisor runs this file.
 */
export async function reloadSupervisorAfterUpdate(
	target: string,
	run: Launchctl = systemLaunchctl(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	if (process.platform !== "darwin") return undefined;
	const domain = `gui/${process.getuid!()}`;
	const service = `${domain}/${LAUNCH_AGENT_LABEL}`;
	const running = () =>
		/^\s*state = running$/m.test(run(["print", service]).output);
	const loaded = run(["print", service]);
	const program = /^\s*program = (.+)$/m.exec(loaded.output)?.[1];
	if (loaded.status !== 0 || !program) return undefined;
	if (realPath(program) !== realPath(target)) return undefined;
	const byHand = `launchctl bootout ${service}; launchctl bootstrap ${domain} ${launchAgentPath()}`;
	// Unloading the service stops everything it started, this command included.
	if (env.XPC_SERVICE_NAME === LAUNCH_AGENT_LABEL)
		return `The background service started this command, so it was not reloaded and keeps running the version before. Reload it from a terminal: ${byHand}`;
	const error = await loadLaunchAgent(launchAgentPath(), domain, run);
	if (error)
		return `The background service was not reloaded: ${error} Reload it yourself: ${byHand}`;
	for (let waited = 0; waited < 40 && !running(); waited++) await pause(250);
	return running()
		? "Reloaded the background service; it now runs this version. Runs that were in progress were stopped."
		: `The background service was reloaded but is not running. Check ~/.tedix/supervisor.launchd.log, or reload it yourself: ${byHand}`;
}

export async function install(env: NodeJS.ProcessEnv): Promise<number> {
	if (process.platform !== "darwin") {
		console.error(
			"tedix supervise install writes a macOS LaunchAgent; elsewhere run tedix supervise under your own service manager.",
		);
		return 1;
	}
	const [command, prefix] = selfCommand();
	const path = launchAgentPath();
	mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
	writeFileSync(
		path,
		launchAgentPlist([command, ...prefix, "supervise"], env),
		{
			mode: 0o644,
		},
	);
	const error = await loadLaunchAgent(
		path,
		`gui/${process.getuid!()}`,
		systemLaunchctl(),
	);
	if (error) {
		console.error(`Wrote ${path} but ${error}`);
		return 1;
	}
	console.log(
		`Installed ${path}; the supervisor runs now and at every login. Remove it with tedix supervise uninstall.`,
	);
	return 0;
}

export function uninstall(): number {
	if (process.platform !== "darwin") return 0;
	systemLaunchctl()([
		"bootout",
		`gui/${process.getuid!()}/${LAUNCH_AGENT_LABEL}`,
	]);
	rmSync(launchAgentPath(), { force: true });
	console.log("Removed the Tedix supervisor LaunchAgent.");
	return 0;
}
