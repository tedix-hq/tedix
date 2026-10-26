import { describe, expect, it } from "vite-plus/test";
import { splitTestArgs } from "./run-tests";

describe("tedi test:run argument split", () => {
	it("runs both halves in full when no file is named", () => {
		expect(splitTestArgs([])).toEqual({
			unit: [],
			workerd: ["--config", "vitest.workerd.config.ts"],
		});
	});

	it("sends a unit file only to the unit half", () => {
		expect(
			splitTestArgs(["src/workstation/files.test.ts", "-t", "restores"]),
		).toEqual({
			unit: ["-t", "restores", "src/workstation/files.test.ts"],
			workerd: null,
		});
	});

	it("sends a workerd file only to the workerd half", () => {
		expect(splitTestArgs(["src/relay.workerd.test.ts"])).toEqual({
			unit: null,
			workerd: [
				"--config",
				"vitest.workerd.config.ts",
				"src/relay.workerd.test.ts",
			],
		});
	});
});
