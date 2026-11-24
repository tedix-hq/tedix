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
import { findCommand, run, toolPath } from "./shell";

/** Each Mac app's usual file name and the identifier it keeps when renamed or moved. */
const APPS = {
	chatgpt: { file: "ChatGPT.app", bundle: "com.openai.codex" },
	claude: { file: "Claude.app", bundle: "com.anthropic.claudefordesktop" },
	devin: { file: "Devin.app", bundle: "com.exafunction.windsurf" },
	opencode: { file: "OpenCode.app", bundle: "ai.opencode.desktop" },
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

/** Apps Spotlight found by identifier, with the version each one states. */
let located: Partial<Record<DesktopApp, { path: string; version: string }>> =
	{};

const applicationFolders = () => [
	"/Applications",
	join(homedir(), "Applications"),
];

/**
 * Finds the Mac apps by identifier, so a renamed app or one kept outside the
 * Applications folders is still found. Copies in the Trash or on a mounted
 * disk image do not count.
 */
export async function locateDesktopApps(): Promise<void> {
	if (process.platform !== "darwin") return;
	const next: typeof located = {};
	await Promise.all(
		(Object.keys(APPS) as DesktopApp[]).map(async (app) => {
			const found = await run(
				"/usr/bin/mdfind",
				[`kMDItemCFBundleIdentifier == "${APPS[app].bundle}"`],
				{ timeoutMs: 10_000 },
			);
			const inFolders = (path: string) =>
				applicationFolders().includes(dirname(path)) ? 0 : 1;
			const path =
				(found.ok ? found.output.split("\n") : [])
					.filter(
						(line) =>
							line.endsWith(".app") &&
							!line.startsWith("/Volumes/") &&
							!line.includes("/.Trash/") &&
							existsSync(line),
					)
					.sort((a, b) => inFolders(a) - inFolders(b))[0] ?? byName(app);
			if (!path) return;
			const version = await run(
				"/usr/bin/defaults",
				["read", join(path, "Contents", "Info"), "CFBundleShortVersionString"],
				{ timeoutMs: 5_000 },
			);
			next[app] = { path, version: version.ok ? version.output.trim() : "" };
		}),
	);
	located = next;
}

const byName = (app: DesktopApp) =>
	applicationFolders()
		.map((folder) => join(folder, APPS[app].file))
		.find((path) => existsSync(path));

export function desktopAppPath(app: DesktopApp): string | undefined {
	const found = located[app]?.path;
	return found && existsSync(found) ? found : byName(app);
}

/** The app's version, once `locateDesktopApps` has read it. */
export const desktopAppVersion = (app: DesktopApp): string =>
	located[app]?.version ?? "";

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
		// A Mac app without its own executable leaves the standalone command.
		command: bundled || standalone,
		/** The Mac app's name when setup uses its executable. */
		desktop: bundled ? spec.name : undefined,
		/** The Mac app's name when it is installed. */
		app: app ? spec.name : undefined,
		appPath: app,
		/** The Mac app's own executable, when it has one. */
		bundled: bundled || undefined,
		/** The command installed outside the Mac app, when there is one. */
		standalone,
		desktopApp: spec.app as DesktopApp,
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
