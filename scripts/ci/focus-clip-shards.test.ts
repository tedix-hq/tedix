import { expect, test } from "bun:test";
import {
	focusClipConfigs,
	focusClipShard,
} from "../../apps/os/browser-tests/focus-clip-shards";

test("focus-clip route partitions cover every route and theme/viewport exactly once", () => {
	for (const count of [1, 2, 4, 8]) {
		const coverage: string[] = [];
		const text: string[] = [];
		for (let shard = 1; shard <= count; shard++) {
			const plan = focusClipShard(`${shard}/${count}`);
			for (const { viewport, theme } of plan.configs) {
				const config = `${viewport.width}-${theme}`;
				if (plan.partition === 0) text.push(config);
				for (let route = 0; route < 90; route++)
					if (route % plan.partitions === plan.partition)
						coverage.push(`${config}:${route}`);
			}
		}
		expect(coverage.length).toBe(4 * 90);
		expect(new Set(coverage).size).toBe(coverage.length);
		expect(text.sort()).toEqual(
			focusClipConfigs
				.map(({ viewport, theme }) => `${viewport.width}-${theme}`)
				.sort(),
		);
	}
});
test("malformed and uneven shard counts fail rather than silently miss coverage", () => {
	for (const value of ["0/8", "9/8", "1/5", "1/no", "1/0", "1.5/8"])
		expect(() => focusClipShard(value)).toThrow();
});
