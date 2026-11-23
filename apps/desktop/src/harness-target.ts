import {
	accessSync,
	constants,
	existsSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { findCommand, toolPath } from "./shell";

const APPS = {
	chatgpt: "ChatGPT.app",
	claude: "Claude.app",
	devin: "Devin.app",
	opencode: "OpenCode.app",
} as const;

export type DesktopApp = keyof typeof APPS;

const HOSTS = {
	codex: {
		app: "chatgpt",
		name: "ChatGPT Work",
		executable: "codex-cli/bin/codex",
	},
	claude: { app: "claude", name: "Claude Code in Claude Desktop" },
	devin: {
		app: "devin",
		name: "Devin Desktop",
		executable: "app/extensions/windsurf/devin/bin/devin",
	},
	opencode: {
		app: "opencode",
		name: "OpenCode Desktop",
		executable: "opencode-cli",
	},
} as const;

export type Harness = keyof typeof HOSTS;

export function desktopAppPath(app: DesktopApp): string | undefined {
	return [
		join("/Applications", APPS[app]),
		join(homedir(), "Applications", APPS[app]),
	].find((path) => existsSync(path));
}

function executable(path: string): string | undefined {
	try {
		accessSync(path, constants.X_OK);
		return path;
	} catch {
		return undefined;
	}
}

function claudeCode(): string | undefined {
	const root = join(
		homedir(),
		"Library",
		"Application Support",
		"Claude",
		"claude-code",
	);
	try {
		const versions = readdirSync(root)
			.filter((name) => /^\d+\.\d+\.\d+$/.test(name))
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
		for (const version of versions)
			for (const id of readdirSync(join(root, version))) {
				const command = executable(
					join(root, version, id, "claude.app", "Contents", "MacOS", "claude"),
				);
				if (command) return command;
			}
	} catch {
		// Opening Claude's Code tab installs this executable.
	}
}

export function selectedHarnessCommand(
	desktopInstalled: boolean,
	bundled: string | undefined,
	standalone: string | undefined,
): string | undefined {
	return desktopInstalled ? bundled : standalone;
}

export function harnessTarget(host: Harness) {
	const spec = HOSTS[host];
	const app = desktopAppPath(spec.app);
	const bundled =
		app &&
		("executable" in spec
			? executable(join(app, "Contents", "Resources", spec.executable))
			: claudeCode());
	const standalone = findCommand(
		host,
		(candidate) =>
			!bundled || realpathSync(candidate) !== realpathSync(bundled),
	);
	return {
		command: selectedHarnessCommand(Boolean(app), bundled, standalone),
		desktop: app ? spec.name : undefined,
		standaloneFound: Boolean(standalone),
	};
}

let commandDirectory: string | undefined;

function commandPath(host: string, command: string): string {
	if (basename(command) === host) return dirname(command);
	if (!commandDirectory) {
		const directory = mkdtempSync(join(tmpdir(), "tedix-harnesses-"));
		process.once("exit", () =>
			rmSync(directory, { recursive: true, force: true }),
		);
		commandDirectory = directory;
	}
	const link = join(commandDirectory, host);
	if (existsSync(link) && realpathSync(link) === realpathSync(command))
		return commandDirectory;
	rmSync(link, { force: true });
	symlinkSync(command, link);
	return commandDirectory;
}

/** The CLI helpers and supervisor resolve host executables by command name. */
export function harnessPath(): string {
	const directories = Object.keys(HOSTS).flatMap((host) => {
		const target = harnessTarget(host as Harness);
		return target.desktop && target.command
			? [commandPath(host, target.command)]
			: [];
	});
	return [...new Set([...directories, ...toolPath().split(delimiter)])].join(
		delimiter,
	);
}
