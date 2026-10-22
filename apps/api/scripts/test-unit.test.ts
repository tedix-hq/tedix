import { describe, expect, it } from "vite-plus/test";
import { lazyCheckShard } from "./test-unit";

describe("lazyCheckShard", () => {
	it("runs the boundary check in shard 1 and unsharded runs only", () => {
		expect(lazyCheckShard([])).toBe(true);
		expect(lazyCheckShard(["src/x.test.ts"])).toBe(true);
		expect(lazyCheckShard(["--shard", "1/4"])).toBe(true);
		expect(lazyCheckShard(["--shard=1/4"])).toBe(true);
		for (const shard of ["2/4", "3/4", "4/4", "2/2"])
			expect(lazyCheckShard(["--shard", shard])).toBe(false);
		expect(lazyCheckShard(["--shard=3/4"])).toBe(false);
	});
});
