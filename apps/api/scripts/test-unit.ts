/**
 * The `test:unit` script: the Vitest suite, then the lazy-import boundary
 * check. CI shards the suite as `--shard N/M` (`tedixCi.testScriptShards` in
 * package.json); the check runs once, in shard 1 only, instead of repeating
 * the esbuild scan in every shard. An unsharded run covers both.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** Whether this invocation also runs the lazy-import check: shard 1, or no shard. */
export function lazyCheckShard(argv = process.argv.slice(2)) {
	const flag = argv.findIndex(
		(arg) => arg === "--shard" || arg.startsWith("--shard="),
	);
	if (flag < 0) return true;
	const value = argv[flag]!.includes("=")
		? argv[flag]!.split("=")[1]
		: argv[flag + 1];
	return value?.split("/")[0] === "1";
}

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
		status !== 0 || !lazyCheckShard()
			? status
			: run(["bun", "scripts/check-lazy-imports.ts"]),
	);
}
