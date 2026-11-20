/** Consume leading warmup options and return the paths for this shard. */
export function takeBrowserWarmup(args, shard) {
	let fallback;
	let selected;
	for (;;) {
		const option = /^--warm=(?:(\d+\/\d+):)?(\/[a-z\d/.,?=%-]+)$/i.exec(
			args[0] ?? "",
		);
		if (!option) return selected ?? fallback;
		args.shift();
		const [, target, paths] = option;
		if (!target) fallback = paths;
		else if (target === shard) selected = paths;
	}
}
