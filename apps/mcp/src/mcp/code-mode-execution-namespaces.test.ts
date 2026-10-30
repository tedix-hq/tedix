import { describe, expect, it } from "vite-plus/test";
import {
	extractCodeModeExecutionNamespacesFromCode,
	extractCodeModeProviderNamespacesFromCode,
} from "./code-mode-namespaces";

describe("Code Mode execution bindings", () => {
	it("keeps unfiltered discovery's full catalog without binding its executable tools", () => {
		const code =
			'async () => { const result = await discover.search({ query: "work", includeParameters: true }); return result; }';
		expect(extractCodeModeProviderNamespacesFromCode(code)).toBeNull();
		expect(extractCodeModeExecutionNamespacesFromCode(code)).toEqual(new Set());
	});
	it("keeps direct calls beside discovery", () => {
		expect(
			extractCodeModeExecutionNamespacesFromCode(
				"async () => { await discover.list_namespaces(); return acme.list_items({limit: 1}); }",
			),
		).toEqual(new Set(["acme"]));
	});
	it.each([
		'async () => globalThis["acme"].list_items({})',
		'async () => { const result = await discover.search({query:"work"}); return globalThis[result.namespace].list_items({}); }',
		"async () => { const api = acme; return api.list_items({}); }",
		"async () => acme[method]({})",
		'async () => flow.status({runId:"run"})',
		"async () => `result ${acme[method]({})}`",
	])("retains all bindings for indirect execution: %s", (code) => {
		expect(extractCodeModeExecutionNamespacesFromCode(code)).toBeNull();
	});
});
