/**
 * The `test:unit` script: the Vitest suite, then the lazy-import boundary
 * check. CI shards the suite as `--shard N/M` (`tedixCi.testScriptShards` in
 * package.json); the check runs once, in shard 1 only, instead of repeating
 * the esbuild scan in every shard. An unsharded run covers both.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { isPrimaryTestShard } from "../../../scripts/ci/test-shard";

if (import.meta.main) {
	const appRoot = join(import.meta.dir, "..");
	const run = (command: string[]) =>
		spawnSync(command[0]!, command.slice(1), {
			cwd: appRoot,
			stdio: "inherit",
		}).status ?? 1;
	const status = run([
		"bun",
		"x",
		"vp",
		"test",
		"run",
		...process.argv.slice(2),
	]);
	process.exit(
		status !== 0 || !isPrimaryTestShard(process.argv.slice(2))
			? status
			: run(["bun", "scripts/check-lazy-imports.ts"]),
	);
}
