import { describe, expect, it } from "vite-plus/test";
import { resolveProvider } from "@cloudflare/codemode";
import { buildUiProvider } from "./codemode-ui";
import type { ServerContext } from "./server-context";

const context = {
	appId: "app-example",
	appSlug: "example",
	app: { name: "Example", logoUrl: "https://example.com/logo.png" },
} as ServerContext;

const tools = resolveProvider(buildUiProvider(context)).fns;

describe("Code Mode UI provider", () => {
	it("keeps catalog selection ordered, deduplicated and limited to known components", async () => {
		const catalog = (await tools.get_catalog!({
			components: ["Text", "Text", "Unknown", "Stack"],
		})) as {
			componentDefinitions: string[];
			components: string[];
			actions: string[];
		};
		expect(
			catalog.componentDefinitions.map((line) => line.split(":")[0]),
		).toEqual(["- Text", "- Stack"]);
		expect(catalog.components).toContain("DataTable");
		expect(catalog.actions.length).toBeGreaterThan(0);
	});

	it("preserves rows, metadata and caller app identity in an inferred view", async () => {
		const rows = [
			{ name: "First", count: 2 },
			{ name: "Second", count: 4 },
		];
		const view = (await tools.create_view!({
			title: "Counts",
			visualKind: "table",
			data: { rows, _meta: { receipt: "kept" } },
		})) as Record<string, unknown>;
		expect(view.rows).toEqual(rows);
		expect(view.app).toEqual({
			id: "app-example",
			slug: "example",
			name: "Example",
			logoUrl: "https://example.com/logo.png",
		});
		expect(view._meta).toMatchObject({
			receipt: "kept",
			ui: { resourceUri: "ui://widgets/mcp-app/example/r/counts.html" },
		});
		expect(view.layoutSpec).toMatchSnapshot();
	});

	it.each([
		"auto",
		"table",
		"summary",
		"comparison",
		"timeline",
		"stats",
		"details",
		"chart",
		"timeSeries",
		"categoricalCounts",
		"rankedMetrics",
	])("produces a valid %s layout for record arrays", async (visualKind) => {
		const rows = [
			{
				name: "First",
				date: "2026-01-01",
				count: 2,
				status: "ok",
				price: 10,
				currency: "EUR",
			},
			{
				name: "Second",
				date: "2026-01-02",
				count: 4,
				status: "warning",
				price: 20,
				currency: "EUR",
			},
		];
		const view = (await tools.create_view!({
			title: "Records",
			visualKind,
			data: rows,
		})) as Record<string, unknown>;
		expect(view.rows).toEqual(rows);
		expect(
			await tools.validate_layout!({ layoutSpec: view.layoutSpec }),
		).toMatchObject({ valid: true, issues: [] });
	});

	it("preserves explicit layouts and falls back from invalid layouts", async () => {
		const layoutSpec = {
			root: "text",
			elements: {
				text: { type: "Text", props: { text: "Explicit" }, children: [] },
			},
		};
		const explicit = (await tools.create_view!({
			data: { value: 1 },
			layoutSpec,
		})) as Record<string, unknown>;
		expect(explicit.layoutSpec).toEqual(layoutSpec);
		const fallback = (await tools.create_view!({
			data: { value: 1 },
			layoutSpec: {},
		})) as Record<string, unknown>;
		expect(
			await tools.validate_layout!({ layoutSpec: fallback.layoutSpec }),
		).toMatchObject({ valid: true });
		expect(await tools.validate_layout!({ layoutSpec: null })).toEqual({
			valid: false,
			issues: ["layoutSpec must be a non-empty json-render object."],
		});
	});

	it("normalizes health statuses, latency and summary counts", async () => {
		const view = (await tools.create_health_sweep!({
			checks: [
				{ provider: "one", status: "healthy", latencyMs: 2.9 },
				{ namespace: "two", status: "forbidden", latencyMs: -1 },
				{ app: "three", status: "partial" },
			],
		})) as Record<string, unknown>;
		expect(view.summary).toBe("3 checks: 1 OK, 2 need attention.");
		expect(view.checks).toEqual([
			{
				namespace: "one",
				label: "one",
				status: "ok",
				latencyMs: 2,
				tone: "success",
			},
			{
				namespace: "two",
				label: "two",
				status: "blocked",
				latencyMs: 0,
				tone: "danger",
			},
			{
				namespace: "three",
				label: "three",
				status: "warning",
				tone: "warning",
			},
		]);
		expect(
			await tools.validate_layout!({ layoutSpec: view.layoutSpec }),
		).toMatchObject({ valid: true });
	});

	it("keeps transient HTML, summary fallback and widget routing", async () => {
		expect(
			await tools.create_mcp_app!({
				title: " Custom ",
				summary: " Summary ",
				html: " <p>Hi</p> ",
				data: { value: 1 },
			}),
		).toMatchObject({
			title: "Custom",
			summary: "Summary",
			value: 1,
			generatedMcpApp: { html: "<p>Hi</p>", renderMode: "sandboxed-html-css" },
			_meta: {
				ui: {
					resourceUri: "ui://widgets/mcp-app/example/r/generated-app.html",
				},
			},
		});
		await expect(
			tools.create_mcp_app!({
				title: "Custom",
				summary: "Summary",
				html: "x".repeat(4001),
			}),
		).rejects.toThrow("transient limit");
		await expect(
			tools.create_mcp_app!({ title: "Custom", html: "<p>Hi</p>" }),
		).rejects.toThrow("summary fallback");
	});

	it("rejects scalar view data and empty health sweeps", async () => {
		await expect(tools.create_view!({ data: 1 })).rejects.toThrow(
			"JSON object or an array of records",
		);
		await expect(tools.create_health_sweep!({ checks: [] })).rejects.toThrow(
			"at least one check row",
		);
	});
});
