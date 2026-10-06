import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AppTool } from "@tedix/api-contract/schemas/app";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useParams: () => ({ appId: "app-1" }),
	Link: ({
		to,
		params: _params,
		children,
		...rest
	}: {
		to: string;
		params?: unknown;
		children?: React.ReactNode;
	}) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
}));
vi.mock("@/lib/app-permissions", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/app-permissions")>()),
	useCanManageApps: () => true,
}));
// The sibling-owned live host bridge. Mocked to a marker element so these
// tests pin the props contract without mounting the real MCP Apps renderer.
vi.mock("@/components/widget-frame", () => ({
	WidgetFrame: (props: {
		appSlug: string;
		resourceUri: string;
		toolInput?: unknown;
		toolResult?: unknown;
		title?: string;
	}) => (
		<div
			data-widget-frame
			data-app-slug={props.appSlug}
			data-resource-uri={props.resourceUri}
			data-title={props.title}
		/>
	),
}));

import {
	APP_OVERVIEW_TOOL_PREVIEW_LIMIT,
	AppOverviewSummary,
	AppToolRow,
	appOverviewToolPreview,
	appConnectionRows,
	buildWidgetPreviewUrl,
	clampWidgetFrameHeight,
	DEFAULT_WIDGET_ORIGIN,
	getToolLayoutId,
	getToolLayoutSpec,
	isWidgetTool,
	MAX_EMBEDDABLE_SPEC_CHARS,
	mcpEndpointHost,
	mcpEndpointUrl,
	sortTools,
	ToolChip,
	toolAnnotationChips,
	toolChips,
	WidgetFrameBoundary,
	WidgetHostOnlyPanel,
	WidgetPreviewFrame,
	widgetResourceUri,
} from "./app-detail";
import { AppLifecyclePanel, AppOverviewPage } from "./app-detail";
import { appDetailQueryOptions } from "@/lib/os-query-options";

const detailApp = {
	id: "installed-initech",
	slug: "initech-globex",
	name: "Initech",
	metadata: { mcpConfig: { aggregateApps: [{ slug: "initech" }] } },
};

function renderOverview(detail?: unknown) {
	const client = new QueryClient({
		defaultOptions: { queries: { enabled: false, retry: false } },
	});
	if (detail)
		client.setQueryData(
			appDetailQueryOptions("app-1").queryKey,
			detail as never,
		);
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<AppOverviewPage />
			</QueryClientProvider>,
		),
		"text/html",
	);
}

describe("app overview summary", () => {
	it("renders linked semantic facts without metric cards", () => {
		const html = renderToStaticMarkup(
			<AppOverviewSummary
				appId="app-1"
				tools={{ enabled: 3, total: 4 }}
				adapters={{ enabled: 1, total: 2 }}
				contentSources={5}
				sessions={21}
				successRate={95}
			/>,
		);

		expect(html).toContain('aria-label="App overview"');
		expect(html).toContain('data-slot="metric-grid"');
		expect(html.match(/data-slot="metric-item"/g)).toHaveLength(4);
		expect(html).toContain("3/4");
		expect(html).toContain("95% success");
		expect(html).toContain("/apps/app-1/analytics");
		expect(html).not.toContain('data-slot="card"');
	});
});

describe("app overview tool preview", () => {
	it("keeps the overview bounded and delegates the full inventory", () => {
		const tools = Array.from(
			{ length: APP_OVERVIEW_TOOL_PREVIEW_LIMIT + 3 },
			(_, index) =>
				makeTool({
					id: `row-${index}`,
					toolId: `tool_${String(index).padStart(2, "0")}`,
					sortOrder: APP_OVERVIEW_TOOL_PREVIEW_LIMIT + 3 - index,
				}),
		);

		const preview = appOverviewToolPreview(sortTools(tools));

		expect(preview).toHaveLength(APP_OVERVIEW_TOOL_PREVIEW_LIMIT);
		expect(preview.map((tool) => tool.sortOrder)).toEqual([1, 2, 3, 4, 5]);
		expect(tools[0]?.sortOrder).toBe(APP_OVERVIEW_TOOL_PREVIEW_LIMIT + 3);
		const doc = renderOverview({ app: detailApp, tools });
		const viewAll = [...doc.querySelectorAll("a")].find(
			(link) => link.textContent?.trim() === "View all tools",
		);
		expect(viewAll?.getAttribute("href")).toBe("/apps/$appId/tools");
	});
});

describe("app lifecycle", () => {
	it("attributes a catalog source connection to its installed tenant proxy", () => {
		const rows = [
			{
				provider: { appId: "initech-api-key" },
				references: [
					{ appId: "catalog-initech", appSlug: "initech", source: "app" },
				],
			},
		];
		const app = {
			id: "installed-initech",
			slug: "initech-globex",
			metadata: { mcpConfig: { aggregateApps: [{ slug: "initech" }] } },
		};

		expect(appConnectionRows(app as never, rows as never)).toEqual(rows);
	});

	it("keeps lifecycle states separate and exposes bounded actions", () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		act(() =>
			root.render(
				<QueryClientProvider
					client={
						new QueryClient({
							defaultOptions: { queries: { enabled: false, retry: false } },
						})
					}
				>
					<AppLifecyclePanel app={detailApp as never} />
				</QueryClientProvider>,
			),
		);
		const text = container.textContent ?? "";
		for (const label of [
			"Installation",
			"Account",
			"Unified gateway",
			"Governance",
			"MCP health",
			"Available tools",
			"Test connection",
		])
			expect(text).toContain(label);
		const section = container.querySelector(
			'[aria-labelledby="app-lifecycle-title"]',
		);
		expect(section?.querySelector("#app-lifecycle-title")?.textContent).toBe(
			"App lifecycle",
		);
		const states = container.querySelector(
			'[aria-label="App lifecycle states"]',
		);
		expect(states?.tagName).toBe("DL");
		for (const dd of states?.querySelectorAll("dd") ?? [])
			expect(dd.className).not.toContain("border");
		expect(
			container.querySelector('a[href="/admin/connections"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[aria-label="App lifecycle actions"]'),
		).not.toBeNull();

		// Bounded secondary actions live in an end-aligned overflow menu; removal
		// routes to the settings danger zone.
		const more = container.querySelector<HTMLElement>(
			'[aria-label="More app lifecycle actions"]',
		)!;
		act(() => {
			more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			more.click();
		});
		const items = [...document.body.querySelectorAll('[role="menuitem"]')];
		const remove = items.find((item) =>
			item.textContent?.includes("Remove app"),
		);
		expect(
			remove?.getAttribute("href") ??
				remove?.querySelector("a")?.getAttribute("href"),
		).toContain("settings#app-danger-zone");
		expect(
			items.some((item) => item.textContent?.includes("Manage scopes")),
		).toBe(true);
		act(() => root.unmount());
		container.remove();
	});
});

function makeTool(overrides: Partial<AppTool>): AppTool {
	return {
		id: "row-1",
		toolId: "list_invoices",
		toolTypeId: "mcp",
		title: "List invoices",
		description: "Lists invoices for the org.",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		adapterScope: null,
		resultStrategy: null,
		outputTemplate: null,
		widgetKey: null,
		widgetRoute: null,
		widgetAccessible: null,
		authRequired: false,
		visibility: null,
		icons: null,
		executionTaskSupport: null,
		annotations: null,
		meta: null,
		invocationStatus: null,
		fileParams: null,
		widgetDescription: null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		config: null,
		schemaDialect: null,
		schemaSource: null,
		schemaSourceRef: null,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: null,
		enabled: true,
		createdAt: null,
		updatedAt: null,
		...overrides,
	};
}

const SPEC = { root: "card", elements: { card: { type: "Card" } } };

describe("mcpEndpointHost", () => {
	it("builds {slug}.mcp.tedix.dev by default", () => {
		expect(
			mcpEndpointHost(
				{ slug: "acme", customMcpDomain: null },
				"acme.os.tedix.dev",
			),
		).toBe("acme.mcp.tedix.dev");
	});

	it("offers a complete local MCP URL, without changing Cloud or custom domains", () => {
		const app = { slug: "acme-unified", customMcpDomain: null };
		for (const hostname of ["localhost", "acme.localhost", "127.0.0.1"]) {
			expect(mcpEndpointUrl(app, hostname)).toBe(
				"http://acme-unified.localhost:3000/mcp",
			);
		}
		expect(mcpEndpointUrl(app, "acme.os.tedix.dev")).toBe(
			"https://acme-unified.mcp.tedix.dev/mcp",
		);
		expect(mcpEndpointUrl(app, "localhost.attacker.example")).toBe(
			"https://acme-unified.mcp.tedix.dev/mcp",
		);
		expect(
			mcpEndpointUrl(
				{ ...app, customMcpDomain: "agents.example.com" },
				"localhost",
			),
		).toBe("https://agents.example.com/mcp");
	});

	it("honors the customMcpDomain override", () => {
		expect(
			mcpEndpointHost({ slug: "acme", customMcpDomain: "mcp.acme.example" }),
		).toBe("mcp.acme.example");
	});
});

describe("widget predicate (mirrors apps/mcp render-widget.ts)", () => {
	it("detects widgetKey render without a spec", () => {
		const tool = makeTool({ widgetKey: "render" });
		expect(isWidgetTool(tool)).toBe(true);
		expect(getToolLayoutSpec(tool)).toBeNull();
	});

	it("detects an object layoutSpec in config", () => {
		const tool = makeTool({ config: { layoutSpec: SPEC } });
		expect(isWidgetTool(tool)).toBe(true);
		expect(getToolLayoutSpec(tool)).toEqual(SPEC);
	});

	it("parses a JSON-string layoutSpec", () => {
		const tool = makeTool({ config: { layoutSpec: JSON.stringify(SPEC) } });
		expect(getToolLayoutSpec(tool)).toEqual(SPEC);
	});

	it("treats malformed spec strings and plain tools as non-widgets", () => {
		expect(isWidgetTool(makeTool({ config: { layoutSpec: "{oops" } }))).toBe(
			false,
		);
		expect(isWidgetTool(makeTool({}))).toBe(false);
	});

	it("resolves layoutId with toolId fallback", () => {
		expect(
			getToolLayoutId(makeTool({ config: { layoutId: "invoice-card" } })),
		).toBe("invoice-card");
		expect(getToolLayoutId(makeTool({ config: { layoutId: "  " } }))).toBe(
			"list_invoices",
		);
		expect(getToolLayoutId(makeTool({}))).toBe("list_invoices");
	});

	it("builds the ui:// mcp-app resource identifier", () => {
		expect(
			widgetResourceUri(
				"acme",
				makeTool({ config: { layoutId: "invoice-card" } }),
			),
		).toBe("ui://widgets/mcp-app/acme/r/invoice-card.html");
	});
});

describe("buildWidgetPreviewUrl", () => {
	it("uses the exact apps/mcp preview encode recipe", () => {
		const tool = makeTool({ config: { layoutSpec: SPEC } });
		const url = buildWidgetPreviewUrl(DEFAULT_WIDGET_ORIGIN, "acme", tool);
		expect(url).toBe(
			`https://mcp-ui.tedix.dev/acme/r/preview?spec=${encodeURIComponent(
				btoa(JSON.stringify(SPEC)),
			)}`,
		);
	});

	it("returns null when there is no client-readable spec", () => {
		expect(
			buildWidgetPreviewUrl(
				DEFAULT_WIDGET_ORIGIN,
				"acme",
				makeTool({ widgetKey: "render" }),
			),
		).toBeNull();
	});

	it("returns null when the spec is too large for URL embedding", () => {
		const tool = makeTool({
			config: {
				layoutSpec: { pad: "x".repeat(MAX_EMBEDDABLE_SPEC_CHARS + 1) },
			},
		});
		expect(
			buildWidgetPreviewUrl(DEFAULT_WIDGET_ORIGIN, "acme", tool),
		).toBeNull();
	});

	it("round-trips Unicode preview specs as UTF-8", () => {
		const spec = { text: "Cotización — 🦊 日本語 e\u0301" };
		const tool = makeTool({ config: { layoutSpec: spec } });
		const url = buildWidgetPreviewUrl(DEFAULT_WIDGET_ORIGIN, "acme", tool);
		expect(url).not.toBeNull();
		const encoded = new URL(url!).searchParams.get("spec")!;
		const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
		expect(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
		).toEqual(spec);
	});
});

describe("clampWidgetFrameHeight", () => {
	it("clamps to the 160-900 host contract range", () => {
		expect(clampWidgetFrameHeight(420)).toBe(420);
		expect(clampWidgetFrameHeight(50)).toBe(160);
		expect(clampWidgetFrameHeight(5000)).toBe(900);
	});
});

describe("annotation chips", () => {
	it("maps readOnlyHint true to a read chip", () => {
		expect(toolAnnotationChips({ readOnlyHint: true })).toEqual([
			{ label: "read", tone: "read" },
		]);
	});

	it("maps explicit write and destructive hints", () => {
		expect(
			toolAnnotationChips({ readOnlyHint: false, destructiveHint: false }),
		).toEqual([{ label: "write", tone: "write" }]);
		expect(
			toolAnnotationChips({ readOnlyHint: false, destructiveHint: true }),
		).toEqual([{ label: "destructive", tone: "destructive" }]);
	});

	it("renders nothing for absent annotations instead of guessing", () => {
		expect(toolAnnotationChips(null)).toEqual([]);
		expect(toolAnnotationChips({})).toEqual([]);
	});

	it("adds idempotent and open world chips when hinted", () => {
		expect(
			toolAnnotationChips({
				readOnlyHint: true,
				idempotentHint: true,
				openWorldHint: true,
			}),
		).toEqual([
			{ label: "read", tone: "read" },
			{ label: "idempotent", tone: "neutral" },
			{ label: "open world", tone: "neutral" },
		]);
	});

	it("adds auth, widget, and disabled row chips", () => {
		const chips = toolChips(
			makeTool({
				authRequired: true,
				enabled: false,
				config: { layoutSpec: SPEC },
			}),
		);
		expect(chips.map((chip) => chip.label)).toEqual([
			"auth",
			"widget",
			"disabled",
		]);
	});
});

describe("sortTools", () => {
	it("orders by sortOrder then toolId, nulls last", () => {
		const sorted = sortTools([
			makeTool({ id: "a", toolId: "z_tool", sortOrder: null }),
			makeTool({ id: "b", toolId: "b_tool", sortOrder: 2 }),
			makeTool({ id: "c", toolId: "a_tool", sortOrder: null }),
			makeTool({ id: "d", toolId: "d_tool", sortOrder: 1 }),
		]);
		expect(sorted.map((tool) => tool.toolId)).toEqual([
			"d_tool",
			"b_tool",
			"a_tool",
			"z_tool",
		]);
	});
});

describe("ToolChip", () => {
	it("renders a Kumo Badge with the annotation tone stamped", () => {
		const html = renderToStaticMarkup(
			<ToolChip chip={{ label: "destructive", tone: "destructive" }} />,
		);
		expect(html).toContain('data-slot="badge"');
		expect(html).toContain('data-tone="destructive"');
		expect(html).toContain("Destructive");
	});
});

describe("WidgetPreviewFrame", () => {
	it("mounts an opaque-origin sandboxed iframe at the preview URL", () => {
		const html = renderToStaticMarkup(
			<WidgetPreviewFrame
				url="https://mcp-ui.tedix.dev/acme/r/preview?spec=abc"
				title="list_invoices widget preview"
			/>,
		);
		expect(html).toContain('sandbox="allow-scripts"');
		expect(html).not.toContain("allow-same-origin");
		expect(html).toContain(
			'src="https://mcp-ui.tedix.dev/acme/r/preview?spec=abc"',
		);
		expect(html).toContain('referrerPolicy="no-referrer"');
		expect(html).toContain("height:420px");
	});

	it("wraps the iframe in the card container without touching its sandbox", () => {
		const html = renderToStaticMarkup(
			<WidgetPreviewFrame
				url="https://mcp-ui.tedix.dev/acme/r/preview?spec=abc"
				title="list_invoices widget preview"
			/>,
		);
		expect(html).toContain('data-slot="card"');
		expect(html).toContain('sandbox="allow-scripts"');
		// The card root carries the 12px bounded-surface tier, not the 8px
		// control tier. See docs/product/design.md ("Radii").
		expect(html).toContain("rounded-xl");
		expect(html).not.toContain("rounded-lg");
	});

	it("clamps a requested height into the contract range", () => {
		const html = renderToStaticMarkup(
			<WidgetPreviewFrame
				url="https://mcp-ui.tedix.dev/x/r/preview"
				title="t"
				height={5000}
			/>,
		);
		expect(html).toContain("height:900px");
	});
});

describe("WidgetHostOnlyPanel", () => {
	it("names the ui:// resource honestly instead of a blank loader shell", () => {
		const html = renderToStaticMarkup(
			<WidgetHostOnlyPanel resourceUri="ui://widgets/mcp-app/acme/r/invoice-card.html" />,
		);
		expect(html).toContain("Live widget rendering is unavailable");
		expect(html).toContain("ui://widgets/mcp-app/acme/r/invoice-card.html");
		expect(html).toContain('data-slot="card"');
		expect(html).toContain('data-slot="card-content"');
		expect(html).toContain("border-dashed");
		// 12px card boundary; the 8px icon chip inside it stays on the control
		// tier. See docs/product/design.md ("Radii").
		expect(html).toContain("rounded-xl");
		expect(html).toContain("rounded-lg");
	});
});

describe("app overview loading geometry", () => {
	it("uses the shared 8px radius tier", () => {
		const doc = renderOverview();
		const rows = [...doc.querySelectorAll('[aria-hidden="true"] > *')];
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(row.classList.contains("rounded-lg")).toBe(true);
			expect(row.classList.contains("rounded-xl")).toBe(false);
		}
	});
});

describe("WidgetFrameBoundary", () => {
	it("renders its children while the mount is healthy", () => {
		const html = renderToStaticMarkup(
			<WidgetFrameBoundary fallback={<span>degraded</span>}>
				<span>healthy widget</span>
			</WidgetFrameBoundary>,
		);
		expect(html).toContain("healthy widget");
		expect(html).not.toContain("degraded");
	});

	it("flips to the failed state on a renderer error", () => {
		// renderToStaticMarkup rethrows instead of running boundaries, so pin
		// the containment contract at the state-transition level.
		expect(WidgetFrameBoundary.getDerivedStateFromError()).toEqual({
			failed: true,
		});
	});
});

describe("AppToolRow", () => {
	it("renders the verb-first tool id, description, and chips", () => {
		const html = renderToStaticMarkup(
			<AppToolRow
				tool={makeTool({ annotations: { readOnlyHint: true } })}
				appSlug="acme"
			/>,
		);
		expect(html).toContain("list_invoices");
		expect(html).toContain("Lists invoices for the org.");
		expect(html).toContain("hidden tracking-[-0.1px] sm:line-clamp-2");
		expect(html).toContain('data-tone="read"');
		expect(html).not.toContain("Preview");
	});

	it("omits descriptions in bounded overview-style previews", () => {
		const html = renderToStaticMarkup(
			<AppToolRow
				tool={makeTool({ annotations: { readOnlyHint: true } })}
				appSlug="acme"
				showDescription={false}
			/>,
		);
		expect(html).toContain("list_invoices");
		expect(html).toContain("List invoices");
		expect(html).not.toContain("Lists invoices for the org.");
		expect(html).toContain('data-tone="read"');
	});

	it("offers a preview toggle for widget-bearing tools, collapsed by default", () => {
		const html = renderToStaticMarkup(
			<AppToolRow
				tool={makeTool({ config: { layoutSpec: SPEC } })}
				appSlug="acme"
			/>,
		);
		expect(html).toContain("Preview");
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain("<iframe");
		expect(html).not.toContain("data-widget-frame");
	});

	it("renders the LIVE session-gated WidgetFrame for the ui:// resource", () => {
		const html = renderToStaticMarkup(
			<AppToolRow
				tool={makeTool({
					config: { layoutId: "invoice-card", layoutSpec: SPEC },
				})}
				appSlug="acme"
				defaultPreviewOpen
			/>,
		);
		expect(html).toContain("data-widget-frame");
		expect(html).toContain('data-app-slug="acme"');
		expect(html).toContain(
			'data-resource-uri="ui://widgets/mcp-app/acme/r/invoice-card.html"',
		);
		// The live mount replaces the old fallback card for session-gated widgets.
		expect(html).not.toContain("Live widget rendering is unavailable");
	});

	it("keeps the anonymous preview as an explicit secondary link", () => {
		const tool = makeTool({ config: { layoutSpec: SPEC } });
		const html = renderToStaticMarkup(
			<AppToolRow tool={tool} appSlug="acme" defaultPreviewOpen />,
		);
		const previewUrl = buildWidgetPreviewUrl(
			DEFAULT_WIDGET_ORIGIN,
			"acme",
			tool,
		);
		expect(previewUrl).not.toBeNull();
		expect(html).toContain("Open anonymous preview");
		expect(html).toContain(`href="${previewUrl}"`);
		expect(html).toContain('target="_blank"');
	});

	it("renders the live frame without an anonymous link when the spec is not URL-embeddable", () => {
		const html = renderToStaticMarkup(
			<AppToolRow
				tool={makeTool({ widgetKey: "render" })}
				appSlug="acme"
				defaultPreviewOpen
			/>,
		);
		expect(html).toContain("data-widget-frame");
		expect(html).toContain(
			'data-resource-uri="ui://widgets/mcp-app/acme/r/list_invoices.html"',
		);
		expect(html).not.toContain("Open anonymous preview");
	});

	it("keeps non-widget rows free of any preview affordance", () => {
		const html = renderToStaticMarkup(
			<AppToolRow tool={makeTool({})} appSlug="acme" defaultPreviewOpen />,
		);
		expect(html).not.toContain("Preview");
		expect(html).not.toContain("data-widget-frame");
		expect(html).not.toContain("Open anonymous preview");
	});
});
