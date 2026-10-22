import { expect, test } from "bun:test";
import {
	focusClipConfigs,
	focusClipShard,
	focusClipRoutes,
} from "../../apps/os/browser-tests/focus-clip-shards";

test("focus-clip route partitions cover every route and theme/viewport exactly once", () => {
	for (const count of [1, 2, 4, 8]) {
		const coverage: string[] = [];
		const text: string[] = [];
		for (let shard = 1; shard <= count; shard++) {
			const plan = focusClipShard(`${shard}/${count}`);
			const routes = Array.from(
				{ length: 90 },
				(_, index) => [`/route-${index}`, `/route-${index}`] as const,
			);
			if (shard % 2) routes.reverse();
			for (const { viewport, theme } of plan.configs) {
				const config = `${viewport.width}-${theme}`;
				if (plan.partition === 0) text.push(config);
				for (const route of focusClipRoutes(
					new Map(routes),
					plan.partition,
					plan.partitions,
				))
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
test("route assignment depends only on normalized pattern, never fixture IDs or other routes", () => {
	const routes = new Map([
		["/work/items/:id", "/work/items/first"],
		["/workspace/:id", "/workspace/first"],
	]);
	for (let partition = 0; partition < 2; partition++) {
		const before = focusClipRoutes(routes, partition, 2);
		const changed = new Map([
			["/extra", "/extra"],
			["/workspace/:id", "/workspace/second"],
			["/work/items/:id", "/work/items/second"],
		]);
		expect(
			focusClipRoutes(changed, partition, 2)
				.filter((route) => route !== "/extra")
				.map((route) => route.replace("second", "first")),
		).toEqual(before);
	}
});
test("malformed and uneven shard counts fail rather than silently miss coverage", () => {
	for (const value of ["0/8", "9/8", "1/5", "1/no", "1/0", "1.5/8"])
		expect(() => focusClipShard(value)).toThrow();
});
