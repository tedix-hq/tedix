import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { TEDIX_DEVIN_OAUTH_CLIENT_ID } from "@tedix/auth/oauth-client-registration";
import { withFileLockSync } from "./local-file-lock";
import { selfCommand } from "./shared";
import {
	devinEnvironmentReadDenials,
	devinGitWritePaths,
	devinSecretPaths,
} from "./devin-lane-security";

export function devinConfigDirectory(env = process.env) {
	return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "devin");
}

export function devinCliCommand() {
	const [program, prefix] = selfCommand();
	return [program, ...prefix]
		.map((part) =>
			/^[\w/.:=-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`,
		)
		.join(" ");
}

export function devinHooks(lane = false) {
	const cli = devinCliCommand();
	return Object.fromEntries(
		[
			["SessionStart", "session-start"],
			["UserPromptSubmit", "prompt-context"],
			["UserPromptSubmit", "capture-reply"],
			["Stop", "capture-stop"],
			["SessionEnd", "status"],
			...(lane ? [["PreToolUse", "devin-permission"]] : []),
		].reduce<Array<[string, unknown[]]>>((entries, [event, name]) => {
			const entry = entries.find(([key]) => key === event);
			const hook = {
				matcher: "",
				hooks: [
					{
						type: "command",
						command:
							name === "devin-permission"
								? `${cli} hooks devin-permission --host devin || exit 2 # tedix-managed-devin-hook`
								: `${cli} hooks ${name} --host devin || true # tedix-managed-devin-hook`,
						timeout: 30,
					},
				],
			};
			if (entry) entry[1].push(hook);
			else entries.push([event!, [hook]]);
			return entries;
		}, []),
	);
}

function readConfig(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const value = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(value))
		throw new Error(`Expected a JSON object in ${path}; file was not changed`);
	return value;
}

function objectField(value: unknown): Record<string, unknown> {
	if (value === undefined) return {};
	if (!isRecord(value))
		throw new Error(
			"Invalid Devin configuration object; files were not changed",
		);
	return value;
}

/** Merge only Tedix's entries; malformed files and conflicting server names fail closed. */
export function setupDevin(directory = devinConfigDirectory()) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	withFileLockSync(join(directory, ".tedix-setup.lock"), () => {
		const configPath = join(directory, "config.json");
		const mcpPath = join(directory, "mcp_config.json");
		const config = readConfig(configPath);
		const mcp = readConfig(mcpPath);
		const servers = objectField(mcp.mcpServers);
		const existing = servers.tedix;
		const server = {
			url: "https://connect.mcp.tedix.dev/mcp",
			transport: "http",
			oauthClientId: TEDIX_DEVIN_OAUTH_CLIENT_ID,
		};
		if (
			existing &&
			(!isRecord(existing) ||
				existing.url !== server.url ||
				existing.transport !== server.transport)
		)
			throw new Error(
				"Devin already has a different tedix MCP server; inspect it before setup",
			);
		const hooks = { ...objectField(config.hooks) };
		for (const [event, entries] of Object.entries({
			PreToolUse: [],
			...devinHooks(),
		})) {
			const previous = hooks[event] ?? [];
			if (!Array.isArray(previous))
				throw new Error(`Invalid Devin ${event} hooks`);
			hooks[event] = [
				...previous.filter(
					(entry: unknown) =>
						!(
							isRecord(entry) &&
							Array.isArray(entry.hooks) &&
							entry.hooks.length > 0 &&
							entry.hooks.every(
								(hook: unknown) =>
									isRecord(hook) &&
									typeof hook.command === "string" &&
									hook.command.endsWith(" # tedix-managed-devin-hook"),
							)
						),
				),
				...entries,
			];
		}
		for (const [path, value] of [
			[
				configPath,
				{
					...config,
					attribution: false,
					read_config_from: {
						...objectField(config.read_config_from),
						claude: false,
					},
					hooks,
				},
			],
			[
				mcpPath,
				{
					...mcp,
					mcpServers: {
						...servers,
						tedix: { ...objectField(existing), ...server },
					},
				},
			],
		] as const) {
			const temporary = `${path}.${process.pid}.tmp`;
			writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
				mode: 0o600,
			});
			renameSync(temporary, path);
		}
	});
}

/** Paired with mandatory --sandbox: Read denies also constrain exec processes. */
export function devinPermissionProfile(
	cwd: string,
	session?: { id: string; principalKey?: string },
) {
	const permissions = devinToolPermissions(cwd, session);
	return {
		attribution: false,
		read_config_from: { claude: false },
		hooks: devinHooks(true),
		sandbox: { excluded: { allow: [], ask: [], deny: ["Exec(**)"] } },
		permissions: {
			...permissions,
			allow: [
				...permissions.allow,
				...devinGitWritePaths(resolve(cwd)).map((path) => `Write(${path})`),
			],
		},
	};
}

/** Tool checks need the rules, not the sandbox's Git metadata write grants. */
export function devinToolPermissions(
	cwd: string,
	session?: { id: string; principalKey?: string },
) {
	const root = resolve(cwd);
	if (/[()\n\r*?\[\]{}]/.test(root))
		throw new Error("Unsupported Devin workspace path");
	return {
		allow: [
			`Read(${root}/**)`,
			`Write(${root}/**)`,
			...[
				"git status",
				"git fetch",
				"git worktree list",
				"git diff",
				"git log",
				"git show",
				"git rev-parse",
				"git add",
				"git commit",
				"git switch",
				"git branch",
				"git merge-base",
				"bun run",
				"bun test",
				"bun --version",
				"devin --version",
				"devin models",
				"rg",
				"ls",
				"cat",
				"sed",
				"gh run list",
				"gh run view",
			].flatMap((command) => [
				`Exec(${command})`,
				...(command.startsWith("git ")
					? [`Exec(git -C ${root} ${command.slice(4)})`]
					: []),
			]),
			...["tedix", devinCliCommand()].flatMap((cli) => [
				`Exec(${cli})`,
				...(session
					? [`Exec(TEDIX_AGENT_SESSION=devin:${session.id} ${cli})`]
					: []),
				...(session?.principalKey
					? [
							`Exec(TEDIX_EXTERNAL_AGENT=${session.principalKey} ${cli})`,
							`Exec(TEDIX_AGENT_SESSION=devin:${session.id} TEDIX_EXTERNAL_AGENT=${session.principalKey} ${cli})`,
							`Exec(TEDIX_EXTERNAL_AGENT=${session.principalKey} TEDIX_AGENT_SESSION=devin:${session.id} ${cli})`,
						]
					: []),
			]),
			"Fetch(https://docs.tedix.dev/*)",
			"Fetch(https://docs.devin.ai/*)",
			"mcp__tedix__*",
		],
		deny: [
			...["curl", "wget", "ssh", "scp", "env"].map((tool) => `Exec(${tool})`),
			"Exec(git push)",
			"Exec(tedix login)",
			"Exec(wrangler deploy)",
			"Exec(bunx wrangler deploy)",
			"Exec(npx wrangler deploy)",
			...[
				...devinSecretPaths(),
				`${root}/.devin/**`,
				`${root}/.claude/**`,
				"~/.ssh/**",
				"~/.config/**",
			].flatMap((path) => [`Read(${path})`, `Write(${path})`]),
			...devinEnvironmentReadDenials().map((path) => `Read(${path})`),
			...[
				"**/.env",
				"**/.env/**",
				"**/.env.*",
				"**/.env.*/**",
				"**/.dev.vars",
				"**/.dev.vars/**",
				"**/.dev.vars.*",
				"**/.dev.vars.*/**",
			].map((path) => `Write(${path})`),
		],
		ask: [],
	};
}

export function writeDevinLaneConfig(
	path: string,
	cwd: string,
	session?: { id: string; principalKey?: string },
) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(
		path,
		JSON.stringify(devinPermissionProfile(cwd, session), null, 2) + "\n",
		{ mode: 0o600, flag: "wx" },
	);
}
