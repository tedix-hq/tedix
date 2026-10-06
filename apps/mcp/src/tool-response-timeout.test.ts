import { describe, expect, it } from "vite-plus/test";
import { toolResponseTimeoutMs } from "./tool-response-timeout";

describe("trusted tool response budgets", () => {
	it("matches exact materialized tool names and leaves unconfigured calls alone", () => {
		const tools = [
			{ toolId: "cms_site_import_resume", config: { timeout: 150_000 } },
		];
		expect(toolResponseTimeoutMs("cms_site_import_resume", tools)).toBe(
			150_000,
		);
		expect(toolResponseTimeoutMs("site_import_resume", tools)).toBeUndefined();
		expect(toolResponseTimeoutMs("other", tools)).toBeUndefined();
	});
	it("uses the registered Code Mode name and its existing execution budget", () => {
		expect(toolResponseTimeoutMs("code", [], { codeMode: true })).toBe(330_000);
		expect(
			toolResponseTimeoutMs("code", [], {
				codeMode: true,
				codeModeTimeout: 90_000,
			}),
		).toBe(90_000);
		expect(
			toolResponseTimeoutMs("code", [], { codeMode: false }),
		).toBeUndefined();
		expect(
			toolResponseTimeoutMs("tedix_mcp_code", [], { codeMode: true }),
		).toBeUndefined();
	});
	it.each([0, -1, Infinity, NaN, "150000"])(
		"ignores invalid configured budget %s",
		(timeout) => {
			expect(
				toolResponseTimeoutMs("tool", [
					{ toolId: "tool", config: { timeout } },
				]),
			).toBeUndefined();
		},
	);
});

it("honors the projected durable transport budget without changing ordinary calls", () => {
	expect(
		toolResponseTimeoutMs("run_tedi_durable_code", [
			{ toolId: "run_tedi_durable_code", config: { timeout: 315000 } },
		]),
	).toBe(315000);
	expect(
		toolResponseTimeoutMs("get_tedi_code_execution", [
			{ toolId: "get_tedi_code_execution", config: {} },
		]),
	).toBeUndefined();
});
