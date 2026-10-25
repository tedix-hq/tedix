import { describe, expect, test } from "bun:test";
import {
	parseWorkerTypesArgs,
	selectWorkspaces,
} from "./generate-worker-types";

describe("worker types arguments", () => {
	test("rejects unknown options", () => {
		expect(() => parseWorkerTypesArgs(["--chek"])).toThrow(
			"--chek: unknown option",
		);
	});

	test("parses check, concurrency, and workspace selectors", () => {
		const parsed = parseWorkerTypesArgs([
			"--check",
			"--concurrency=2",
			"api",
			"apps/tedi-runtime",
		]);

		expect(parsed).toEqual({
			checkOnly: true,
			concurrency: 2,
			requested: ["api", "apps/tedi-runtime"],
		});
		expect(
			selectWorkspaces(
				["apps/api", "apps/mcp", "apps/tedi-runtime"],
				parsed.requested,
			),
		).toEqual(["apps/api", "apps/tedi-runtime"]);
	});

	test("keeps generation defaults", () => {
		expect(parseWorkerTypesArgs([])).toEqual({
			checkOnly: false,
			concurrency: 4,
			requested: [],
		});
	});
});
