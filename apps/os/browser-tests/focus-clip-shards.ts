export const focusClipConfigs = [
	{ width: 1280, height: 900 },
	{ width: 390, height: 844 },
].flatMap((viewport) =>
	(["light", "dark"] as const).map((theme) => ({ viewport, theme })),
);

export function focusClipShard(value = "1/1") {
	const [shard, count] = value.split("/").map(Number);
	if (
		!/^\d+\/\d+$/.test(value) ||
		!Number.isInteger(shard) ||
		!Number.isInteger(count) ||
		shard! < 1 ||
		shard! > count! ||
		(count! > 4 && count! % 4 !== 0)
	)
		throw new Error(`Invalid focus-clip shard ${value}`);
	const partitions = Math.max(1, count! / 4);
	return {
		configs: focusClipConfigs.filter(
			(_, index) => index % Math.min(count!, 4) === (shard! - 1) % 4,
		),
		partition: Math.floor((shard! - 1) / 4),
		partitions,
	};
}
