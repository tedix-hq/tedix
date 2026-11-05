#!/usr/bin/env bun
import { type CliOptions, firstWord, INTERACTIVE_COMMANDS } from "./shared";
import type { TedixHomeClient } from "./home-client";

/**
 * Split a one-shot prompt that is really a slash command into its name and
 * remaining arguments. Returns undefined for ordinary prose, and for bare "/"
 * or a leading path like "/Users/..." so real prompts are never hijacked.
 */
export function parseSlashPrompt(
	prompt: string,
): { name: string; rest: string } | undefined {
	const trimmed = prompt.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const [name, rest] = firstWord(trimmed.slice(1));
	if (!name || !/^[a-z][a-z0-9-]*$/i.test(name)) return undefined;
	return { name: name.toLowerCase(), rest: rest.trim() };
}

/**
 * Explain an unresolved slash command instead of delegating its text. REPL-only
 * verbs get named as such so the caller knows the command exists but the
 * surface does not.
 */
export function slashCommandError(name: string): string {
	const replOnly = INTERACTIVE_COMMANDS.some(
		(command) => command.name === name,
	);
	if (replOnly) {
		return `"/${name}" is an interactive-only command. Run \`tedix\` and use /${name} there. It was NOT sent to Home as a message.`;
	}
	return `Unknown command "/${name}". Run \`tedix --help\` for available commands, or drop the leading "/" to send it to Home as a message.`;
}

export async function runDirectCode(
	client: Pick<TedixHomeClient, "runCode" | "runCodeWithDestructiveApproval">,
	source: string,
	destructiveApprovalReason?: string,
	target?: { workspace?: string; organization?: string; url?: string },
): Promise<unknown> {
	try {
		return destructiveApprovalReason
			? await client.runCodeWithDestructiveApproval(
					source,
					destructiveApprovalReason,
				)
			: await client.runCode(source);
	} catch (error) {
		const [{ codeDiscoveryErrorMessage }, { errorText }] = await Promise.all([
			import("./code-result"),
			import("./format"),
		]);
		throw new Error(codeDiscoveryErrorMessage(errorText(error), target), {
			cause: error,
		});
	}
}

/** Commands dispatched before gateway option parsing; they take only their own flags. */
export const LOCAL_COMMANDS = ["setup", "dev", "hooks", "supervise", "learn"];

/** Local commands accept the workspace selector used by shared agent wrappers. */
export function localCommandArgs(argv: string[]): string[] {
	let commandIndex = 0;
	while (commandIndex < argv.length) {
		const arg = argv[commandIndex]!;
		if (arg === "-w" || arg === "--workspace" || arg === "--organization")
			commandIndex += 2;
		else if (
			arg.startsWith("--workspace=") ||
			arg.startsWith("--organization=")
		)
			commandIndex++;
		else break;
	}
	if (!LOCAL_COMMANDS.includes(argv[commandIndex] ?? "")) return argv;
	const contextAction = argv.slice(commandIndex, commandIndex + 4);
	const appliesWorkspace =
		(contextAction[0] === "learn" && contextAction[1] === "import-memory") ||
		(contextAction[0] === "setup" &&
			contextAction[1] === "agents" &&
			contextAction[2] === "context" &&
			["bind", "connect", "set-default-organization"].includes(
				contextAction[3] ?? "",
			));
	const args: string[] = [];
	let workspace: string | undefined;
	let positionalOnly = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (
			!positionalOnly &&
			argv[commandIndex] === "supervise" &&
			(arg === "--organization" || arg.startsWith("--organization="))
		) {
			const value =
				arg === "--organization"
					? argv[++i]
					: arg.slice("--organization=".length);
			if (!value || value.startsWith("-"))
				throw new Error("--organization requires an organization name");
		} else if (!positionalOnly && (arg === "-w" || arg === "--workspace")) {
			if (!argv[i + 1] || argv[i + 1]!.startsWith("-"))
				throw new Error(`${arg} requires a workspace name`);
			workspace = argv[++i];
		} else if (!positionalOnly && arg.startsWith("--workspace=")) {
			if (!arg.slice("--workspace=".length))
				throw new Error("--workspace requires a workspace name");
			workspace = arg.slice("--workspace=".length);
		} else {
			args.push(arg);
			if (arg === "--") positionalOnly = true;
		}
	}
	if (appliesWorkspace && workspace) args.push("--workspace", workspace);
	return args;
}

function withoutJsonFlag(args: string[]): string[] {
	const separator = args.indexOf("--");
	return args.filter(
		(arg, index) => arg !== "--json" || (separator >= 0 && index > separator),
	);
}

export async function rejectUnsupportedJson(
	command: string,
	json: boolean,
	humanOnly = false,
): Promise<boolean> {
	if (!json) return false;
	const { findTopLevelCommand } = await import("./command-registry");
	const spec = findTopLevelCommand(command);
	if (!spec || (!humanOnly && spec.output.some((format) => format !== "human")))
		return false;
	console.error(
		JSON.stringify({ error: `--json is not supported by tedix ${spec.name}` }),
	);
	process.exitCode = 2;
	return true;
}

function improveCliErrorMessage(message: string): string {
	if (message.includes("tenant_mismatch")) {
		return `${message}\n\nAuth tenant mismatch: run \`tedix auth status --json\` to inspect the selected organization and credential. Select the matching workspace profile with \`-w <workspace>\`, or run \`tedix login\` to authorize the intended organization.`;
	}
	return message;
}

async function main() {
	let commandIndex = 2;
	while (
		["-w", "--workspace", "--organization"].includes(
			process.argv[commandIndex] ?? "",
		)
	)
		commandIndex += 2;
	const laneIndex = process.argv[commandIndex] === "lane" ? commandIndex : -1;
	if (laneIndex >= 0) {
		const { runLane } = await import("./lane");
		const laneArgs = [
			...process.argv.slice(2, laneIndex),
			...process.argv.slice(laneIndex + 1),
		];
		const separator = laneArgs.indexOf("--");
		const flags = separator < 0 ? laneArgs : laneArgs.slice(0, separator);
		process.exitCode = await runLane(withoutJsonFlag(laneArgs), {
			json: flags.includes("--json"),
		});
		return;
	}
	if (process.argv[commandIndex] === "commit-handoff") {
		const { runCommitHandoff } = await import("./commit-handoff");
		process.exitCode = await runCommitHandoff([
			...process.argv.slice(commandIndex + 1),
			...process.argv.slice(2, commandIndex),
		]);
		return;
	}
	// Installation lifecycle commands are local and never resolve gateway auth.
	const argv = localCommandArgs(process.argv.slice(2));
	const localCommand = argv[0];
	const separator = argv.indexOf("--");
	const flags = separator < 0 ? argv : argv.slice(0, separator);
	if (
		await rejectUnsupportedJson(
			localCommand ?? "",
			flags.includes("--json"),
			localCommand === "setup" &&
				!(argv[1] === "agents" && argv[2] === "context"),
		)
	)
		return;
	if (localCommand === "setup" || localCommand === "dev") {
		const { runLocalInstallation } = await import("./local-installation");
		process.exitCode = await runLocalInstallation(localCommand, argv.slice(1));
		return;
	}
	// Agent-host hooks write one JSON line to stdout and must stay silent otherwise.
	if (localCommand === "hooks") {
		const { runHooksCommand } = await import("./hooks/command");
		process.exitCode = await runHooksCommand(withoutJsonFlag(argv.slice(1)));
		return;
	}
	if (localCommand === "supervise") {
		const { runSuperviseCommand } = await import("./supervise");
		process.exitCode = await runSuperviseCommand(argv.slice(1));
		return;
	}
	// Local extraction; each organization call runs as its own `tedix code` child.
	if (localCommand === "learn") {
		const learnArgs = withoutJsonFlag(argv.slice(1));
		if (
			flags.includes("--json") &&
			(!learnArgs[0] || ["--help", "-h", "help"].includes(learnArgs[0]))
		) {
			const { machineHelp } = await import("./command-registry");
			console.log(JSON.stringify(machineHelp("learn")));
			return;
		}
		const { runLearnCommand } = await import("./learn-import");
		process.exitCode = await runLearnCommand(argv.slice(1));
		return;
	}
	const { main: runGatewayCommand } = await import("./cli-main");
	await runGatewayCommand();
}

if (import.meta.main) {
	// Parsing can fail before options exist; literal arguments cannot choose output.
	const argv = process.argv.slice(2);
	const separator = argv.indexOf("--");
	const flags = separator < 0 ? argv : argv.slice(0, separator);
	const jsonMode = flags.includes("--json") || flags.includes("--json=true");
	main().catch(async (error) => {
		const { errorText } = await import("./format");
		const message = improveCliErrorMessage(errorText(error));
		if (jsonMode) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(message);
		}
		process.exit(1);
	});
}
