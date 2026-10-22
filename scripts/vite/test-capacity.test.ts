import { describe, expect, test } from "bun:test";
import api from "../../apps/api/vitest.config";
import db from "../../packages/db/vitest.config";

describe("shared-machine test capacity", () => {
	for (const [name, config] of Object.entries({ api, db })) {
		test(`${name} keeps one slot from fanning out into competing workers`, () => {
			expect(config.test?.maxWorkers).toBe(1);
			expect(config.test?.testTimeout).toBe(20_000);
			expect(config.test?.hookTimeout).toBe(30_000);
		});
	}
});
