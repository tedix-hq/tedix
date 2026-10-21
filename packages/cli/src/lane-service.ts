import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServeOptions } from "./lane-serve";
import { selfCommand } from "./shared";

const xml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
export function laneServicePlist(
	program: string[],
	label: string,
	env: NodeJS.ProcessEnv,
	home = homedir(),
) {
	const variables = Object.fromEntries(
		[
			"PATH",
			"TEDIX_CONFIG_DIR",
			"CODEX_HOME",
			"CLAUDE_CONFIG_DIR",
			"OPENCODE_ROUTING_CONFIG",
		].flatMap((key) => (env[key] ? [[key, env[key]!]] : [])),
	);
	const log = join(
		env.TEDIX_CONFIG_DIR || join(home, ".tedix"),
		`${label}.log`,
	);
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${program.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(variables)
		.map(
			([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
		)
		.join("")}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>60</integer>
<key>ProcessType</key><string>Background</string>
<key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

export function installLaneService(options: ServeOptions): number {
	if (process.platform !== "darwin")
		throw new Error(
			"--install requires macOS; elsewhere run lane serve under your service manager",
		);
	const org = options.scope[options.scope.indexOf("--organization") + 1]!;
	const label = `dev.tedix.lane-serve.${createHash("sha256").update(`${org}:${options.executor}`).digest("hex").slice(0, 16)}`;
	const folder = join(homedir(), "Library", "LaunchAgents");
	mkdirSync(folder, { recursive: true });
	mkdirSync(process.env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"), {
		recursive: true,
		mode: 0o700,
	});
	const path = join(folder, `${label}.plist`);
	const [command, prefix] = selfCommand();
	const program = [
		command,
		...prefix,
		...options.scope,
		"lane",
		"serve",
		"--executor",
		options.executor,
		"--max",
		String(options.max),
		"--rules",
		options.rules,
		"--repo",
		options.repo,
		...(options.project ? ["--project", options.project] : []),
		...(options.routingConfig
			? ["--routing-config", options.routingConfig]
			: []),
		...(options.coordinated ? ["--coordinated"] : []),
	];
	const domain = `gui/${process.getuid!()}`;
	const service = `${domain}/${label}`;
	const run = (args: string[]) =>
		spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 5000 });
	if (run(["print", service]).status === 0)
		throw new Error(
			`Dispatcher is already installed: ${service}. Stop it with launchctl bootout ${service} before replacing it.`,
		);
	writeFileSync(path, laneServicePlist(program, label, process.env), {
		mode: 0o600,
	});
	const loaded = run(["bootstrap", domain, path]);
	if (loaded.status !== 0 || run(["print", service]).status !== 0)
		throw new Error(
			`Wrote ${path}; launchctl could not load it: ${loaded.stderr}`,
		);
	console.log(
		JSON.stringify({
			installed: true,
			plistPath: path,
			service,
			command: program,
		}),
	);
	return 0;
}
