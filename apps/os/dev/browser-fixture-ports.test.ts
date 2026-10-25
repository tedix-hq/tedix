// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const dir = new URL("../browser-tests/", import.meta.url);

// Parallel hourly jobs share runners; a spec that starts its fixture server on
// a fixed port collides with another job (ECONNREFUSED, socket hang-ups).
describe("browser fixture ports", () => {
	it("never starts an owned fixture server on a fixed port", () => {
		const fixed = readdirSync(dir)
			.filter((name) => name.endsWith(".ts"))
			.filter((name) => {
				const source = readFileSync(new URL(name, dir), "utf8");
				return (
					/"--port",\s*"\d+"/.test(source) ||
					/TEDIX_BROWSER_TEST_PORT\s*(\|\||\?\?)\s*["'`]?\d/.test(source)
				);
			});
		expect(fixed).toEqual([]);
	});
});
