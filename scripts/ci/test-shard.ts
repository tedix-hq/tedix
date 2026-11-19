/** Workspace-wide checks run on shard 1 and on unsharded invocations. */
export function isPrimaryTestShard(argv: readonly string[]) {
	const flag = argv.findIndex(
		(arg) => arg === "--shard" || arg.startsWith("--shard="),
	);
	if (flag < 0) return true;
	const value = argv[flag]!.includes("=")
		? argv[flag]!.split("=")[1]
		: argv[flag + 1];
	return value?.split("/")[0] === "1";
}
