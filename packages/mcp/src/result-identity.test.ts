import { describe, expect, it } from "vite-plus/test";
import {
	findMcpAppRenderProjections,
	parseMcpAppRenderResourceUri,
	structuredResultIdentity,
	structuredUiResultProjection,
} from "./result-identity";

describe("structuredResultIdentity", () => {
	it("keeps workflow join keys while omitting arbitrary result data", () => {
		expect(
			structuredResultIdentity({
				status: {
					id: "workflow-run-1",
					status: "completed",
					tediId: "tedi-cto",
				},
				inspection: {
					run: { id: "workflow-run-1", status: "completed" },
					revision: { revision: 8, skillSlug: "kernel-goal-loop" },
				},
				padding: "x".repeat(20_000),
			}),
		).toEqual({
			status: {
				id: "workflow-run-1",
				status: "completed",
				tediId: "tedi-cto",
			},
			inspection: {
				run: { id: "workflow-run-1", status: "completed" },
				revision: { revision: 8, skillSlug: "kernel-goal-loop" },
			},
		});
	});

	it("keeps bounded MCP UI state and strips credentials", () => {
		const resourceUri = "ui://widgets/mcp-app/acme/r/comparison.html";
		expect(
			structuredUiResultProjection({
				items: [{ name: "Alpha", price: 42 }],
				secret: "do-not-copy",
				_meta: { ui: { resourceUri } },
			}),
		).toEqual({
			items: [{ name: "Alpha", price: 42 }],
			_meta: { ui: { resourceUri } },
		});
		expect(
			structuredUiResultProjection({
				_meta: { ui: { resourceUri: "https://example.com/not-an-mcp-app" } },
			}),
		).toBeNull();
	});

	it("finds a bounded MCP UI result nested in a compact Code Mode return", () => {
		const resourceUri = "ui://widgets/mcp-app/acme/r/comparison.html";
		expect(
			structuredUiResultProjection({
				sourceCount: 10,
				items: [{ name: "Summary row" }],
				view: {
					items: [{ name: "Alpha", price: 42 }],
					credential: "do-not-copy",
					_meta: { ui: { resourceUri } },
				},
			}),
		).toEqual({
			items: [{ name: "Alpha", price: 42 }],
			_meta: { ui: { resourceUri } },
		});
	});
});

describe("MCP App render projection", () => {
	it("recognizes json-render and free-form generated app results", () => {
		const jsonResource = "ui://widgets/mcp-app/acme/r/comparison.html";
		expect(
			findMcpAppRenderProjections({
				layoutSpec: { root: "comparison", elements: {} },
				rows: [{ name: "Alpha" }],
				_meta: { ui: { resourceUri: jsonResource } },
			}),
		).toMatchObject([
			{
				appSlug: "acme",
				layoutId: "comparison",
				resourceUri: jsonResource,
				layoutSpec: { root: "comparison", elements: {} },
			},
		]);

		const generatedResource = "ui://widgets/mcp-app/acme/r/generated-app.html";
		expect(
			findMcpAppRenderProjections({
				generatedMcpApp: {
					html: "<main>Safe inner document</main>",
					renderMode: "sandboxed-html-css",
				},
				_meta: { ui: { resourceUri: generatedResource } },
			}),
		).toMatchObject([
			{
				appSlug: "acme",
				layoutId: "generated-app",
				resourceUri: generatedResource,
			},
		]);
	});

	it("restores the bounded tool result from durable transcript metadata", () => {
		const resourceUri = "ui://widgets/mcp-app/acme/r/summary.html";
		expect(
			findMcpAppRenderProjections({
				delegatedResult: {
					widgets: [
						{
							resourceUri,
							toolInput: { query: "status" },
							toolResult: {
								layoutSpec: { root: "summary", elements: {} },
								rows: [{ status: "ready" }],
							},
						},
					],
				},
			}),
		).toEqual([
			{
				appSlug: "acme",
				layoutId: "summary",
				layoutSpec: { root: "summary", elements: {} },
				resourceUri,
				toolInput: { query: "status" },
				toolResult: {
					layoutSpec: { root: "summary", elements: {} },
					rows: [{ status: "ready" }],
				},
			},
		]);
	});

	it("bounds one assistant turn to three distinct render projections", () => {
		const projections = findMcpAppRenderProjections({
			widgets: Array.from({ length: 5 }, (_, index) => ({
				resourceUri: `ui://widgets/mcp-app/app-${index}/r/view.html`,
				toolResult: { index },
			})),
		});
		expect(projections).toHaveLength(3);
		expect(projections.map(({ appSlug }) => appSlug)).toEqual([
			"app-0",
			"app-1",
			"app-2",
		]);
	});

	it("rejects non-render resources and untrusted URLs", () => {
		expect(
			parseMcpAppRenderResourceUri("https://example.com/widget.html"),
		).toBeNull();
		expect(
			parseMcpAppRenderResourceUri("ui://widgets/mcp-app/acme/assets/logo.svg"),
		).toBeNull();
	});
});
