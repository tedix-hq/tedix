import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { CLI_VERSION } from "./shared";
import {
	acquireLocalSource,
	findSourceRoot,
	localInstallationDirectory,
	localPrerequisites,
	readLocalInstallation,
	saveLocalInstallation,
} from "./local-source";
import { createInterface } from "node:readline/promises";
import { runAgentHostSetup } from "./agent-host-setup";
import { runAgentContext } from "./agent-context";

export function localInstallationUsage(): string {
	return `Tedix local installation

Usage:
  tedix setup                              Install or resume local onboarding
  tedix setup agents                       Install Tedix for Codex and Claude Code
  tedix setup agents context --help        Bind local repository session context
  tedix setup --yes                        Set up offline without prompts
  tedix setup --directory <path>           Use a checkout or clone into a new path
  tedix dev                                Resume local installation or checkout
  tedix dev --inference --account-id <id>   Use your Cloudflare Workers AI
             [--ai-gateway <gateway-id>]    Optionally route through your AI Gateway

Bare setup runs from any directory with Bun and Node.js 22+ on PATH.
It acquires matching source from tedix-hq/tedix using Git. Agent setup only
needs the installed Tedix CLI and Codex or Claude Code on PATH.
An existing Tedix source checkout takes precedence over the saved installation.
No Tedix Cloud login or secret provider is needed. State persists locally;
Ctrl-C stops the local stack.
For inference, first run bunx wrangler login. Workers AI calls are billed to
the explicit Cloudflare account. No cloud deployment is performed.
Setup remembers the installation and selected mode; dev resumes it from anywhere.
Explicit dev options override the saved mode; setup --yes selects offline mode.
For noninteractive use, choose one of the explicit dev commands above.
`;
}

export function parseLocalDevArguments(args: string[]): string[] {
	let inference = false;
	let accountId: string | undefined;
	let aiGatewayId: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--inference" && !inference) inference = true;
		else if (arg === "--account-id" && accountId === undefined) {
			accountId = args[++index];
			if (!accountId || !/^[a-f\d]{32}$/i.test(accountId)) {
				throw new Error(
					"--account-id requires a 32-character Cloudflare account ID",
				);
			}
		} else if (arg === "--ai-gateway" && aiGatewayId === undefined) {
			aiGatewayId = args[++index];
			if (!aiGatewayId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(aiGatewayId))
				throw new Error(
					"--ai-gateway requires a gateway ID of 1–64 lowercase letters, digits or hyphens",
				);
		} else throw new Error(`Unknown or duplicate local option: ${arg}`);
	}
	if (
		inference !== Boolean(accountId) ||
		(aiGatewayId !== undefined && !inference)
	) {
		throw new Error(
			"Use --inference and --account-id <id> together, or omit both for offline mode",
		);
	}
	return accountId
		? [
				"--inference=workers-ai",
				`--workers-ai-account=${accountId}`,
				...(aiGatewayId ? [`--ai-gateway=${aiGatewayId}`] : []),
			]
		: [];
}

export function parseSetupArguments(args: string[]): {
	yes: boolean;
	directory?: string;
} {
	let yes = false;
	let directory: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--yes" && !yes) yes = true;
		else if (args[i] === "--directory" && directory === undefined) {
			const value = args[++i];
			if (!value || value.startsWith("--"))
				throw new Error("--directory requires a path");
			directory = resolve(value);
		} else throw new Error(`Unknown or duplicate setup option: ${args[i]}`);
	}
	return { yes, directory };
}

export function localRepeatCommand(runnerArgs: string[]): string {
	const account = runnerArgs
		.find((arg) => arg.startsWith("--workers-ai-account="))
		?.split("=")[1];
	const gateway = runnerArgs
		.find((arg) => arg.startsWith("--ai-gateway="))
		?.slice("--ai-gateway=".length);
	return account
		? `tedix dev --inference --account-id ${account}${gateway ? ` --ai-gateway ${gateway}` : ""}`
		: "tedix dev";
}

export function runLocalProcess(
	command: string,
	args: string[],
	cwd: string,
	openBrowser = false,
): Promise<number> {
	return new Promise((resolveExit, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: "inherit",
			env: {
				...process.env,
				TEDIX_LOCAL_OPEN_BROWSER: openBrowser ? "1" : "0",
				// Local onboarding must not wait on Wrangler telemetry or update-check sockets.
				WRANGLER_SEND_METRICS: "false",
				WRANGLER_HIDE_BANNER: "true",
			},
		});
		let interrupted: NodeJS.Signals | undefined;
		const interrupt = (signal: NodeJS.Signals) => {
			interrupted = signal;
			child.kill(signal);
		};
		const onInterrupt = () => interrupt("SIGINT");
		const onTerminate = () => interrupt("SIGTERM");
		const cleanup = () => {
			process.off("SIGINT", onInterrupt);
			process.off("SIGTERM", onTerminate);
		};
		process.on("SIGINT", onInterrupt);
		process.on("SIGTERM", onTerminate);
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("exit", (code, signal) => {
			cleanup();
			const termination = interrupted ?? signal;
			resolveExit(
				termination === "SIGINT"
					? 130
					: termination === "SIGTERM"
						? 143
						: (code ?? 1),
			);
		});
	});
}

export async function runLocalInstallation(
	command: "setup" | "dev",
	args: string[],
): Promise<number> {
	if (command === "setup" && args[0] === "agents" && args[1] === "context")
		return runAgentContext(args.slice(2));
	if (command === "setup" && args[0] === "agents")
		return runAgentHostSetup(args.slice(1));
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		console.log(localInstallationUsage());
		return 0;
	}
	const setup = command === "setup" ? parseSetupArguments(args) : undefined;
	let runnerArgs = command === "dev" ? parseLocalDevArguments(args) : [];
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	if (setup && !setup.yes && !interactive)
		throw new Error(
			"Interactive setup requires a terminal. Use tedix setup --yes for offline onboarding. Use tedix dev for an existing installation.",
		);
	const checkout = findSourceRoot(setup?.directory ?? process.cwd());
	if (setup?.directory && checkout && checkout !== setup.directory)
		throw new Error(
			"--directory must name the checkout root or a new destination, not a checkout subtree",
		);
	const saved =
		!checkout && !setup?.directory ? readLocalInstallation() : undefined;
	let root = checkout ?? saved?.root;
	if (!root && command === "dev")
		throw new Error(
			"No local Tedix installation found. Run tedix setup (or tedix setup --yes for offline onboarding). Existing source checkout: cd <checkout> and run tedix dev.",
		);
	localPrerequisites();
	const bun = Bun.which("bun")!;
	if (!root) {
		if (!Bun.which("git"))
			throw new Error(
				"Git is required to download Tedix. Install Git, then rerun tedix setup.",
			);
		console.log(
			"Local setup downloads the public Tedix source release from GitHub (github.com/tedix-hq/tedix).",
		);
		root = await acquireLocalSource({
			version: CLI_VERSION,
			destination:
				setup?.directory ??
				join(localInstallationDirectory(), "installations", "local"),
		});
	}
	if (command === "dev" && args.length === 0 && saved)
		runnerArgs = saved.runnerArgs;
	if (command === "setup" && !setup?.yes) {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		const abort = new AbortController();
		const cancel = () => abort.abort();
		rl.on("SIGINT", cancel);
		process.on("SIGINT", cancel);
		try {
			console.log(
				"No Tedix Cloud account is required. Offline mode makes no AI calls; Workers AI uses your Wrangler login and bills your Cloudflare account.",
			);
			const mode = (
				await rl.question("Choose offline [1, default] or Workers AI [2]: ", {
					signal: abort.signal,
				})
			).trim();
			if (mode === "2") {
				const account = (
					await rl.question(
						"Cloudflare account ID (run bunx wrangler whoami to find it): ",
						{ signal: abort.signal },
					)
				).trim();
				const gateway = (
					await rl.question(
						"AI Gateway ID (optional, Enter for direct Workers AI): ",
						{ signal: abort.signal },
					)
				).trim();
				runnerArgs = parseLocalDevArguments([
					"--inference",
					"--account-id",
					account,
					...(gateway ? ["--ai-gateway", gateway] : []),
				]);
			} else if (mode !== "" && mode !== "1")
				throw new Error(
					"Choose 1 or 2. Run tedix setup again, or use tedix dev --help.",
				);
		} catch (error) {
			if (abort.signal.aborted) return 130;
			throw error;
		} finally {
			process.off("SIGINT", cancel);
			rl.close();
		}
	}
	if (command === "setup") saveLocalInstallation(root, runnerArgs);
	console.log(`Local installation: ${root}`);
	console.log(`Run again with: ${localRepeatCommand(runnerArgs)}`);
	return runLocalProcess(
		bun,
		[join(root, "scripts/run-local.ts"), ...runnerArgs],
		root,
		command === "setup" && interactive && !setup?.yes,
	);
}
