import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function runCheck(command: string, args: string[]): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: packageRoot,
			stdio: "inherit",
		});
		child.on("error", (error) => {
			console.error(error);
			resolve(1);
		});
		child.on("close", (code) => resolve(code ?? 1));
	});
}

export async function checkMigrationSuite(run = runCheck): Promise<number> {
	// These checks only read the migration tree and use separate SQLite stores.
	// history-check runs the same Drizzle collision check with JSON validation.
	const checks: [string, string, string[]][] = [
		["schema", "bun", ["run", "db:schema:check"]],
		["history and collisions", "bun", ["run", "db:migrate:history-check"]],
		[
			"cascade safety",
			"node",
			[
				"../../node_modules/jiti/lib/jiti-cli.mjs",
				"scripts/check-migrations.ts",
			],
		],
		["D1 chain", "bun", ["run", "db:migrate:chain-check"]],
	];
	const results = await Promise.allSettled(
		checks.map(async ([name, command, args]) => {
			const started = performance.now();
			try {
				const code = await run(command, args);
				console.log(
					`[migration check] ${name}: ${((performance.now() - started) / 1000).toFixed(2)}s, exit ${code}`,
				);
				return code;
			} catch (error) {
				console.error(`[migration check] ${name}:`, error);
				throw error;
			}
		}),
	);
	// Wait for every child even on failure; no checker may outlive its caller.
	return results.every(
		(result) => result.status === "fulfilled" && result.value === 0,
	)
		? 0
		: 1;
}

if (import.meta.main) process.exitCode = await checkMigrationSuite();
