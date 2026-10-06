import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = fileURLToPath(
	new URL("../../../node_modules/jiti/lib/jiti-cli.mjs", import.meta.url),
);

describe("migration checker executable entrypoints", () => {
	for (const runtime of ["node", "bun"])
		for (const script of ["check-migrations.ts", "check-live-drift.ts"])
			it(`${runtime} executes ${script} without reading production for help`, () => {
				const args = [
					...(runtime === "node" ? [jiti] : []),
					`scripts/${script}`,
					"--help",
				];
				const result = spawnSync(runtime, args, {
					cwd: packageRoot,
					encoding: "utf8",
					timeout: 30_000,
				});
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toContain(`Usage: ${script}`);
			});
	it("the Node/jiti safety command actually replays the migration graph", () => {
		const result = spawnSync("node", [jiti, "scripts/check-migrations.ts"], {
			cwd: packageRoot,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(
			/D1 migration safety check passed \(\d+ migration\(s\); cascade graph replayed\)/,
		);
	});
	it("importing safety and live drift helpers does not execute either checker", () => {
		const result = spawnSync(
			"node",
			[
				"--input-type=module",
				"-e",
				`import {createJiti} from 'jiti';const j=createJiti(import.meta.url);await j.import('./scripts/check-migrations.ts');await j.import('./scripts/check-live-drift.ts');console.log('imports-only');`,
			],
			{ cwd: packageRoot, encoding: "utf8", timeout: 30_000 },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("imports-only");
	});
});
