import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DB_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

export class WranglerCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WranglerCommandError";
	}
}

export function wranglerRuntimeExecutable(
	env: NodeJS.ProcessEnv = process.env,
	currentExecutable = process.execPath,
): string {
	const configuredBun = env.TEDIX_BUN_EXEC_PATH?.trim();
	if (configuredBun) return configuredBun;
	const executableName = path.basename(currentExecutable).toLowerCase();
	return executableName === "bun" || executableName === "bun.exe"
		? currentExecutable
		: "bun";
}

export function runWrangler(
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
	const result = spawnSync(
		wranglerRuntimeExecutable(),
		["run", "--silent", "wrangler", "--", ...args],
		{
			cwd: options.cwd ?? DB_ROOT,
			encoding: "utf8",
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 20 * 1024 * 1024,
		},
	);
	if (result.error) {
		throw new WranglerCommandError(
			`Unable to run project-installed Wrangler: ${result.error.message}`,
		);
	}
	if (result.status !== 0) {
		const details = [result.stdout, result.stderr]
			.map((value) => value?.trim())
			.filter(Boolean)
			.join("\n")
			.slice(-6000);
		throw new WranglerCommandError(
			`Wrangler exited ${String(result.status)} for ${args.join(" ")}${details ? `:\n${details}` : ""}`,
		);
	}
	return result.stdout?.trim() ?? "";
}

export function parseWranglerJson(stdout: string, context: string): unknown {
	if (!stdout) throw new WranglerCommandError(`${context} returned empty JSON`);
	try {
		return JSON.parse(stdout);
	} catch (error) {
		throw new WranglerCommandError(
			`${context} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
