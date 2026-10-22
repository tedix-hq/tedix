/**
 * `--shard i/n` on a `run-specs.ts` command selects every n-th spec so one
 * suite runs as n CI jobs; without the flag every listed spec runs, as before.
 */
export function parseSpecShard(value: string) {
	const match = /^(\d+)\/(\d+)$/.exec(value);
	const shard = Number(match?.[1]);
	const count = Number(match?.[2]);
	if (!match || shard < 1 || shard > count)
		throw new Error(`Invalid spec shard ${value}`);
	return { shard, count };
}

export function shardSpecs<T>(specs: readonly T[], value = "1/1"): T[] {
	const { shard, count } = parseSpecShard(value);
	return specs.filter((_, index) => index % count === shard - 1);
}
