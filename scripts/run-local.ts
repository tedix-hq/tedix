#!/usr/bin/env bun

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LOCAL_OS_BUILD_SENTINELS } from "../apps/os/dev/build-config";

export const LOCAL_API_URL = "http://localhost:8790";
export const LOCAL_OS_URL = "http://localhost:3030";
const READY_TIMEOUT_MS = 120_000;

export const RUN_LOCAL_HELP = `Usage: bun run-local [options]

Start Tedix OS with isolated, persistent local data and a local owner identity.
No Tedix account or cloud credentials are required for the default offline mode.
Requires Bun and genuine Node.js 22+ on PATH for Wrangler.

  --inference                       Enable paid Workers AI using your Wrangler login
  --workers-ai-account=<account-id>  Explicit 32-character Cloudflare billing account
  --inference=workers-ai            Explicit spelling of --inference
  --demo                            Seed optional demo data in a separate directory
  --smoke                           Run bounded validation with temporary state
  --restart-smoke                   Validate persistence across two offline boots
  --ai-gateway=<id>                 Use a named gateway instead of Cloudflare's default
  --no-install                      Skip installing locked dependencies
  --help                            Print this help without starting anything

For AI: bunx wrangler login, then bunx wrangler whoami to find your account ID.
Example: bun run-local --inference --workers-ai-account=<account-id>
Only model calls are remote and billable; application data stays local.
Normal state: .wrangler/run-local; demo state: .wrangler/run-local-demo.
`;

export type LocalInferenceBackend = "workers-ai";

export function assertSupportedNodeRuntime(runtime: unknown): void {
	if (
		typeof runtime !== "object" ||
		runtime === null ||
		!("node" in runtime) ||
		typeof runtime.node !== "string" ||
		!("bun" in runtime) ||
		runtime.bun !== null ||
		!/^\d+\.\d+\.\d+/.test(runtime.node) ||
		Number(runtime.node.split(".")[0]) < 22
	) {
		throw new Error(
			"Local Tedix requires genuine Node.js 22+ on PATH for Wrangler. Install Node.js 22 or newer and ensure node resolves to it, not a Bun shim; then rerun the command.",
		);
	}
}

function assertNodeAvailable(): void {
	const result = spawnSync(
		"node",
		[
			"-p",
			"JSON.stringify({ node: process.versions.node, bun: process.versions.bun ?? null })",
		],
		{
			encoding: "utf8",
			timeout: 5000,
		},
	);
	let runtime: unknown = null;
	if (!result.error && result.status === 0) {
		try {
			runtime = JSON.parse(result.stdout);
		} catch {
			/* Invalid runtime output fails the same prerequisite check. */
		}
	}
	assertSupportedNodeRuntime(runtime);
}

export interface RunLocalOptions {
	install: boolean;
	smoke: boolean;
	inference: LocalInferenceBackend | null;
	workersAiAccountId: string | null;
	aiGatewayId: string | null;
	restartSmoke: boolean;
	demo: boolean;
}

export function parseRunLocalOptions(arguments_: string[]): RunLocalOptions {
	const exactOptions = new Set([
		"--no-install",
		"--smoke",
		"--inference",
		"--restart-smoke",
		"--demo",
	]);
	const unknown = arguments_.filter(
		(argument) =>
			!exactOptions.has(argument) &&
			!argument.startsWith("--inference=") &&
			!argument.startsWith("--workers-ai-account=") &&
			!argument.startsWith("--ai-gateway="),
	);
	if (unknown.length > 0) {
		throw new Error(`Unknown option: ${unknown.join(", ")}`);
	}
	const inferenceArguments = arguments_.filter(
		(argument) =>
			argument === "--inference" || argument.startsWith("--inference="),
	);
	if (inferenceArguments.length > 1) {
		throw new Error("Choose exactly one inference backend");
	}
	const inferenceArgument = inferenceArguments[0];
	const inferenceValue =
		inferenceArgument === "--inference"
			? "workers-ai"
			: inferenceArgument?.slice("--inference=".length);
	if (inferenceValue !== undefined && inferenceValue !== "workers-ai") {
		throw new Error(
			`Unknown inference backend: ${inferenceValue || "(empty)"}. Choose workers-ai`,
		);
	}
	const accountArguments = arguments_.filter((argument) =>
		argument.startsWith("--workers-ai-account="),
	);
	if (accountArguments.length > 1) {
		throw new Error("Specify --workers-ai-account exactly once");
	}
	const workersAiAccountId =
		accountArguments[0]?.slice("--workers-ai-account=".length) ?? null;
	if (inferenceValue === "workers-ai") {
		if (!workersAiAccountId || !/^[a-f\d]{32}$/i.test(workersAiAccountId)) {
			throw new Error(
				"--inference requires --workers-ai-account=<32-character Cloudflare account id>. Run bunx wrangler login and bunx wrangler whoami first",
			);
		}
	} else if (workersAiAccountId !== null) {
		throw new Error(
			"--workers-ai-account is valid only with --inference=workers-ai",
		);
	}
	const gatewayArguments = arguments_.filter((arg) =>
		arg.startsWith("--ai-gateway="),
	);
	const aiGatewayId =
		gatewayArguments[0]?.slice("--ai-gateway=".length) ?? null;
	if (
		gatewayArguments.length > 1 ||
		(aiGatewayId !== null &&
			(inferenceValue !== "workers-ai" ||
				!/^[a-z0-9][a-z0-9-]{0,63}$/.test(aiGatewayId)))
	) {
		throw new Error(
			"--ai-gateway requires Workers AI inference and a gateway ID of 1–64 lowercase letters, digits or hyphens",
		);
	}
	const options = {
		install: !arguments_.includes("--no-install"),
		smoke: arguments_.includes("--smoke"),
		inference: (inferenceValue ?? null) as LocalInferenceBackend | null,
		workersAiAccountId,
		aiGatewayId,
		restartSmoke: arguments_.includes("--restart-smoke"),
		demo: arguments_.includes("--demo"),
	};
	if (
		options.restartSmoke &&
		(options.smoke || options.inference !== null || options.demo)
	) {
		throw new Error(
			"--restart-smoke runs its own two boots; do not combine it with --smoke, --inference, or --demo",
		);
	}
	return options;
}

export function localInferenceEnvironment(
	options: Pick<
		RunLocalOptions,
		"inference" | "workersAiAccountId" | "aiGatewayId"
	>,
): Record<string, string> {
	return {
		TEDIX_LOCAL_INFERENCE_ENABLED: options.inference ? "true" : "false",
		TEDIX_LOCAL_INFERENCE_BACKEND: options.inference ?? "",
		TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID: options.workersAiAccountId ?? "",
		TEDIX_LOCAL_AI_GATEWAY_ID: options.aiGatewayId ?? "",
	};
}

export function defaultLocalRunState(
	demo: boolean,
	cwd = process.cwd(),
): string {
	return resolve(
		cwd,
		demo ? ".wrangler/run-local-demo" : ".wrangler/run-local",
	);
}

function run(
	command: string,
	arguments_: string[],
	inheritOutput = false,
	environment: Record<string, string> = {},
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, arguments_, {
			stdio: inheritOutput ? "inherit" : ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...environment },
		});
		let output = "";
		const capture = (chunk: Buffer) => {
			output = `${output}${chunk.toString()}`.slice(-64_000);
		};
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`${command} exited with ${code ?? signal ?? "unknown"}${output ? `\n${output.trim()}` : ""}`,
					),
				);
		});
	});
}

async function isApiReady(signal: AbortSignal): Promise<boolean> {
	try {
		const response = await fetch(`${LOCAL_API_URL}/health`, { signal });
		if (!response.ok) return false;
		const body = (await response.json()) as Record<string, unknown>;
		return body.status === "ok" && body.service === "api";
	} catch {
		return false;
	}
}

async function isOsReady(signal: AbortSignal): Promise<boolean> {
	try {
		const response = await fetch(LOCAL_OS_URL, { signal });
		return (
			response.ok && (await response.text()).includes("<title>Tedix OS</title>")
		);
	} catch {
		return false;
	}
}

function isPortInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "localhost", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

async function assertLauncherPortsAvailable(): Promise<void> {
	const ports: Array<readonly [string, string]> = [
		["Tedix API", LOCAL_API_URL],
		["Tedix OS", LOCAL_OS_URL],
	];
	for (const [label, url] of ports) {
		const port = Number(new URL(url).port);
		if (await isPortInUse(port)) {
			throw new Error(
				`${label} port ${port} is already in use. If another Tedix terminal is running, stop it with Ctrl+C, then rerun this command. To find the listener: lsof -nP -iTCP:${port} -sTCP:LISTEN.`,
			);
		}
	}
}

export async function waitForLocalDemo(
	timeoutMs = READY_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const signal = AbortSignal.timeout(
			Math.max(1, Math.min(5000, deadline - Date.now())),
		);
		if ((await isApiReady(signal)) && (await isOsReady(signal))) {
			return;
		}
		await Bun.sleep(Math.max(0, Math.min(500, deadline - Date.now())));
	}
	throw new Error(`Local Tedix did not become ready within ${timeoutMs}ms`);
}

function stopProcessGroup(child: ChildProcess): void {
	if (!child.pid || child.exitCode !== null) return;
	const processGroup = -child.pid;
	try {
		process.kill(processGroup, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	setTimeout(() => {
		if (child.exitCode !== null) return;
		try {
			process.kill(processGroup, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, 2_000);
}

async function main(): Promise<void> {
	if (process.argv.slice(2).includes("--help")) {
		console.log(RUN_LOCAL_HELP);
		return;
	}
	const options = parseRunLocalOptions(process.argv.slice(2));
	assertNodeAvailable();
	// CLI selection is authoritative. These explicit disabled/empty values mask
	// stale ambient exports for every child, including the restart smoke.
	const inferenceEnvironment = localInferenceEnvironment(options);

	console.log(
		options.demo
			? "\n  Tedix local seeded demo\n"
			: "\n  Start your local Tedix OS\n",
	);
	await assertLauncherPortsAvailable();
	if (options.install) {
		console.log("→ Installing exact dependencies");
		await run(
			"bun",
			["install", "--frozen-lockfile"],
			false,
			inferenceEnvironment,
		);
	}
	if (options.restartSmoke) {
		await run(
			"bun",
			["scripts/local-restart-smoke.ts"],
			true,
			inferenceEnvironment,
		);
		return;
	}
	const explicitState = process.env.TEDIX_LOCAL_PERSIST_TO?.trim();
	const temporarySmokeState =
		options.smoke && !explicitState
			? mkdtempSync(join(tmpdir(), "tedix-run-local-smoke-"))
			: null;
	const statePath =
		explicitState ?? temporarySmokeState ?? defaultLocalRunState(options.demo);
	const localEnvironment = {
		...inferenceEnvironment,
		TEDIX_LOCAL_PERSIST_TO: statePath,
		TEDIX_LOCAL_RUN_MODE: options.demo ? "demo" : "start",
	};
	if (options.inference === "workers-ai") {
		console.warn(
			`⚠ Paid remote Workers AI enabled for Cloudflare account ${options.workersAiAccountId}; Wrangler login authorizes model calls, while API and D1 remain local.`,
		);
	}
	console.log("→ Applying isolated local database migrations");
	await run("bun", ["run", "dev:local:seed"], false, localEnvironment);
	if (options.demo) {
		console.log("→ Seeding the optional deterministic demo workspace and tedi");
		await run("bun", ["run", "dev:local:demo-seed"], false, localEnvironment);
	} else {
		console.log("→ Keeping product state blank for first-run onboarding");
	}
	console.log("→ Building the Tedix OS Worker and assets");
	// build:local selects the isolated bindings; the default build is production.
	await run(
		"bunx",
		["vp", "run", "--filter", "@tedix/os", "build:local"],
		false,
		{
			...inferenceEnvironment,
			CI: "1",
			TEDIX_BUILD_API_URL: `${LOCAL_OS_URL}/api`,
			TEDIX_BUILD_DESCOPE_PROJECT_ID:
				LOCAL_OS_BUILD_SENTINELS.DESCOPE_PROJECT_ID,
			TEDIX_BUILD_DESCOPE_BASE_URL: LOCAL_OS_BUILD_SENTINELS.DESCOPE_BASE_URL,
			TEDIX_BUILD_LOCAL_DEMO_ENABLED: "true",
			TEDIX_BUILD_LOCAL_FIRST_RUN_ENABLED: options.demo ? "false" : "true",
			TEDIX_BUILD_LOCAL_INFERENCE_ENABLED: options.inference ? "true" : "false",
		},
	);
	await assertLauncherPortsAvailable();
	console.log("→ Starting the API, MCP gateway and Tedix OS");

	const stack = spawn("bun", ["run", "dev:local:demo-stack"], {
		stdio: options.smoke
			? ["ignore", "pipe", "pipe"]
			: ["ignore", "inherit", "inherit"],
		detached: true,
		env: {
			...process.env,
			...localEnvironment,
		},
	});
	let capturedOutput = "";
	const capture = (chunk: Buffer) => {
		capturedOutput = `${capturedOutput}${chunk.toString()}`.slice(-64_000);
	};
	stack.stdout?.on("data", capture);
	stack.stderr?.on("data", capture);
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		stopProcessGroup(stack);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);

	try {
		const startup = await Promise.race([
			waitForLocalDemo().then(() => ({ ready: true as const })),
			new Promise<{ ready: false; detail: string }>((resolve) => {
				stack.once("error", (error) =>
					resolve({ ready: false, detail: error.message }),
				);
				stack.once("exit", (code, signal) =>
					resolve({
						ready: false,
						detail: `stack exited with ${code ?? signal ?? "unknown"}`,
					}),
				);
			}),
		]);
		if (!startup.ready) throw new Error(startup.detail);
		console.log(`\n✓ Tedix OS: ${LOCAL_OS_URL}`);
		console.log(`✓ API health: ${LOCAL_API_URL}/health`);
		console.log(
			options.inference
				? `  Data stays in ${statePath}; model turns use opt-in Workers AI inference.\n`
				: `  Data stays in ${statePath} and no cloud account is used.\n`,
		);

		if (!options.smoke && process.env.TEDIX_LOCAL_OPEN_BROWSER === "1") {
			const browserCommand =
				process.platform === "darwin"
					? "open"
					: process.platform === "win32"
						? "cmd"
						: "xdg-open";
			const browserArgs =
				process.platform === "win32"
					? ["/c", "start", "", LOCAL_OS_URL]
					: [LOCAL_OS_URL];
			const browser = spawnSync(browserCommand, browserArgs, {
				stdio: "ignore",
				timeout: 5000,
			});
			if (browser.error || browser.status !== 0)
				console.log(`Open ${LOCAL_OS_URL} to finish onboarding.`);
		}

		if (options.smoke) {
			await run(
				"bun",
				["run", "dev:local:demo-acceptance"],
				true,
				localEnvironment,
			);
			stop();
		} else {
			await new Promise<void>((resolve, reject) => {
				stack.once("error", reject);
				stack.once("exit", (code, signal) => {
					if (stopping || code === 0 || signal === "SIGTERM") resolve();
					else
						reject(
							new Error(
								`Local stack exited with ${code ?? signal ?? "unknown"}`,
							),
						);
				});
			});
		}
	} catch (error) {
		if (capturedOutput) console.error(`\n${capturedOutput.trim()}\n`);
		throw error;
	} finally {
		stop();
	}
}

if (import.meta.main) {
	await main();
}
