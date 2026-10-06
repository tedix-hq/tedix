import { act, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

interface MockAppBridge {
	constructorArgs: unknown[];
	oncalltool?: (params: unknown) => Promise<unknown>;
	onmessage?: (params: unknown) => Promise<unknown>;
	onopenlink?: (params: unknown) => Promise<unknown>;
	onupdatemodelcontext?: (params: unknown) => Promise<unknown>;
	setHostContext: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
}

const renderer = vi.hoisted(() => ({
	/** Props captured from the most recent AppFrame render. */
	props: null as Record<string, unknown> | null,
	bridges: [] as MockAppBridge[],
}));

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
	AppBridge: class MockAppBridge {
		constructorArgs: unknown[];
		oncalltool?: (params: unknown) => Promise<unknown>;
		onmessage?: (params: unknown) => Promise<unknown>;
		onopenlink?: (params: unknown) => Promise<unknown>;
		onupdatemodelcontext?: (params: unknown) => Promise<unknown>;
		setHostContext = vi.fn();
		close = vi.fn(async () => {});

		constructor(...args: unknown[]) {
			this.constructorArgs = args;
			renderer.bridges.push(this);
		}
	},
}));

vi.mock("./widget-app-frame", () => ({
	WidgetAppFrame: (props: Record<string, unknown>) => {
		useMemo(
			() =>
				(props.createBridge as (context: unknown) => unknown)(
					props.hostContext,
				),
			[props.createBridge],
		);
		renderer.props = props;
		return <div data-app-renderer />;
	},
}));

import { setThemePreference } from "@/lib/theme";
import {
	embedWidgetToolData,
	extractWidgetResource,
	WidgetFrame,
	WIDGET_SANDBOX_PERMISSIONS,
	widgetResourceUrl,
} from "./widget-frame";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const APP_SLUG = "metabase";
const RESOURCE_URI = "ui://widgets/mcp-app/metabase/dashboard.html";
const WIDGET_HTML = "<html><body>chart</body></html>";
const WIDGET_CSP = {
	connectDomains: ["https://api.tedix.dev"],
	resourceDomains: ["https://cdn.tedix.dev"],
};
const WIDGET_PERMISSIONS = {
	camera: {},
	clipboardWrite: {},
};

function resourcePayload(permissions?: unknown) {
	return {
		contents: [
			{
				uri: RESOURCE_URI,
				mimeType: "text/html;profile=mcp-app",
				text: WIDGET_HTML,
				_meta: { ui: { csp: WIDGET_CSP, permissions } },
			},
		],
	};
}

function jsonResponse(body: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response;
}

const fetchMock = vi.fn<typeof fetch>();

let container: HTMLDivElement;
let root: Root;

/** This happy-dom build exposes no localStorage; the theme store needs one. */
const localStorageStub = (() => {
	const store = new Map<string, string>();
	return {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	};
})();

beforeEach(() => {
	renderer.props = null;
	renderer.bridges.length = 0;
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubGlobal("localStorage", localStorageStub);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	setThemePreference("system");
	vi.unstubAllGlobals();
});

async function renderFrame(
	props: Partial<Parameters<typeof WidgetFrame>[0]> = {},
) {
	await act(async () => {
		root.render(
			<WidgetFrame appSlug={APP_SLUG} resourceUri={RESOURCE_URI} {...props} />,
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("widgetResourceUrl", () => {
	it("builds the governed proxy URL with an encoded resource URI", () => {
		const url = widgetResourceUrl(APP_SLUG, RESOURCE_URI);
		expect(url).toBe(
			`/widgets/resource?app=${APP_SLUG}&uri=${encodeURIComponent(RESOURCE_URI)}`,
		);
	});
});

describe("embedWidgetToolData", () => {
	it("embeds structured results in the Tedix OS hydration seam", () => {
		const spec = JSON.stringify({
			root: "table",
			elements: {
				table: {
					type: "DataTable",
					props: { data: { $state: "/" } },
					children: [],
				},
			},
		});
		const html = `<!doctype html><html><head><title>Widget</title></head><body><script id="tedix-layout-spec" type="application/json">${spec}</script></body></html>`;
		const embedded = embedWidgetToolData(html, { rows: [{ name: "Oil" }] });
		expect(embedded).toContain(
			'<head><script id="tedix-tool-data" type="application/json">{"rows":[{"name":"Oil"}]}</script><title>',
		);
		expect(embedded).toContain('"$state":"/rows"');
	});

	it("unwraps the MCP result envelope to its structuredContent", () => {
		const html = "<main>Widget</main>";
		const embedded = embedWidgetToolData(html, {
			content: [{ type: "text", text: "{}" }],
			structuredContent: { ledger: { bookmark: "548f9ec8e" } },
			_meta: { "tedix/execution": { id: "x" } },
		});
		expect(embedded).toContain(
			'<script id="tedix-tool-data" type="application/json">{"ledger":{"bookmark":"548f9ec8e"}}</script>',
		);
		expect(embedded).not.toContain("tedix/execution");
	});

	it.each([[1, 2], "hello", 0, false, null].map((value) => [value]))(
		"embeds JSON structuredContent %j without its envelope",
		(value) => {
			const html = embedWidgetToolData("<main/>", {
				content: [],
				structuredContent: value,
			});
			const tag = document.createElement("div");
			tag.innerHTML = html;
			expect(
				JSON.parse(tag.querySelector("#tedix-tool-data")!.textContent!),
			).toEqual(value);
		},
	);

	it("replaces the generic resource placeholder with a transient runtime layout", () => {
		const placeholder = {
			root: "placeholder",
			elements: {
				placeholder: {
					type: "Text",
					props: { text: "Loading widget..." },
					children: [],
				},
			},
		};
		const layoutSpec = {
			root: "title",
			elements: {
				title: {
					type: "Text",
					props: { text: "Visual parity live" },
					children: [],
				},
			},
		};
		const html = `<script id="tedix-layout-spec" type="application/json">${JSON.stringify(placeholder)}</script>`;
		const embedded = embedWidgetToolData(html, {
			items: [{ capability: "JSON render" }],
			layoutSpec,
		});

		expect(embedded).toContain(JSON.stringify(layoutSpec));
		expect(embedded).not.toContain("Loading widget...");
		expect(embedded).toContain('id="tedix-tool-data"');
	});

	it("inserts a transient runtime layout when resources/read omitted the spec", () => {
		const layoutSpec = {
			root: "title",
			elements: {
				title: {
					type: "Text",
					props: { text: "Visual parity live" },
					children: [],
				},
			},
		};
		const embedded = embedWidgetToolData(
			"<!doctype html><html><head><title>Widget</title></head><body></body></html>",
			{ items: [{ capability: "JSON render" }], layoutSpec },
		);

		expect(embedded).toContain(
			`<head><script id="tedix-tool-data" type="application/json">`,
		);
		expect(embedded).toContain(
			`<script id="tedix-layout-spec" type="application/json">${JSON.stringify(layoutSpec)}</script>`,
		);
		expect(embedded).not.toContain("Loading widget...");
	});

	it("preserves named and ambiguous collection bindings", () => {
		const html =
			'<script id="tedix-layout-spec" type="application/json">{"root":"table","elements":{"table":{"type":"DataTable","props":{"data":{"$state":"/items"}},"children":[]}}}</script>';
		expect(embedWidgetToolData(html, { items: [], other: [] })).toContain(
			'"$state":"/items"',
		);
	});

	it("escapes markup-significant JSON and ignores non-record results", () => {
		const html = "<main>Widget</main>";
		const embedded = embedWidgetToolData(html, {
			value: "</script><img src=x>&\u2028",
		});
		expect(embedded).not.toContain("</script><img");
		expect(embedded).toContain(
			"\\u003c/script\\u003e\\u003cimg src=x\\u003e\\u0026\\u2028",
		);
		expect(embedWidgetToolData(html, ["not", "a", "record"])).toBe(html);
	});
});

describe("extractWidgetResource", () => {
	it("extracts html, CSP, and closed MCP Apps permissions from _meta.ui", () => {
		const { html, csp, permissions } = extractWidgetResource(
			resourcePayload(WIDGET_PERMISSIONS),
		);
		expect(html).toBe(WIDGET_HTML);
		expect(csp).toEqual(WIDGET_CSP);
		expect(permissions).toEqual(WIDGET_PERMISSIONS);
	});

	it("fails closed on malformed or unknown permission metadata", () => {
		expect(
			extractWidgetResource(
				resourcePayload({ camera: {}, unknownCapability: {} }),
			).permissions,
		).toBeUndefined();
		expect(
			extractWidgetResource(resourcePayload({ camera: { deviceId: "any" } }))
				.permissions,
		).toBeUndefined();
	});

	it("refuses non-HTML content", () => {
		expect(() =>
			extractWidgetResource({
				contents: [{ mimeType: "application/json", text: "{}" }],
			}),
		).toThrow(/unsupported MIME type/);
	});
});

describe("WidgetFrame", () => {
	it("wraps projected Code Mode data in the SDK tool-result envelope", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(resourcePayload()));
		const data = {
			items: [{ title: "Bun" }],
			layoutSpec: { root: "comparison" },
		};
		await renderFrame({ toolResult: data });
		expect(renderer.props?.toolResult).toEqual({
			content: [],
			structuredContent: data,
		});
	});

	it("preserves an existing MCP tool-result envelope", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(resourcePayload()));
		const result = {
			content: [{ type: "text", text: "Bun" }],
			structuredContent: { items: [] },
		};
		await renderFrame({ toolResult: result });
		expect(renderer.props?.toolResult).toBe(result);
	});

	it("handles advertised external links and rejects unsafe destinations", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(resourcePayload()));
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		try {
			await renderFrame();
			const handler = renderer.bridges.at(-1)!.onopenlink!;
			await expect(handler({ url: "https://bun.sh" })).resolves.toEqual({});
			expect(open).toHaveBeenCalledExactlyOnceWith(
				"https://bun.sh/",
				"_blank",
				"noopener,noreferrer",
			);
			for (const url of [
				"javascript:alert(1)",
				"data:text/html,hello",
				"https://user:secret@example.com",
				"bad URL",
			])
				await expect(handler({ url })).resolves.toEqual({ isError: true });
			expect(open).toHaveBeenCalledTimes(1);
		} finally {
			open.mockRestore();
		}
	});

	it("fetches the resource through the governed proxy with credentials", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(resourcePayload()));
		await renderFrame();
		expect(fetchMock).toHaveBeenCalledWith(
			`/widgets/resource?app=${APP_SLUG}&uri=${encodeURIComponent(RESOURCE_URI)}`,
			expect.objectContaining({ credentials: "include" }),
		);
	});

	it("mounts AppRenderer with the fetched html, csp, and sandbox proxy URL", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse(resourcePayload(WIDGET_PERMISSIONS)),
		);
		await renderFrame();
		expect(container.querySelector("[data-app-renderer]")).not.toBeNull();
		expect(
			container.querySelector('[data-slot="mcp-widget-frame"]'),
		).not.toBeNull();
		const props = renderer.props;
		expect(props?.html).toBe(WIDGET_HTML);
		const sandbox = props?.sandbox as {
			url: URL;
			csp?: unknown;
			permissions?: string;
		};
		expect(sandbox.url.pathname).toBe("/sandbox_proxy.html");
		expect(sandbox.url.origin).toBe(window.location.origin);
		expect(
			JSON.parse(sandbox.url.searchParams.get("permissions") ?? "null"),
		).toEqual(WIDGET_PERMISSIONS);
		expect(sandbox.permissions).toBe(WIDGET_SANDBOX_PERMISSIONS);
		expect(sandbox.csp).toEqual(WIDGET_CSP);
		const bridge = renderer.bridges.at(-1);
		expect(bridge?.constructorArgs[2]).toMatchObject({
			sandbox: { permissions: WIDGET_PERMISSIONS },
		});
	});

	it("shows the unavailable fallback with the resource URI on a 401", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ error: { message: "unauthorized" } }, 401),
		);
		await renderFrame({ title: "Sales dashboard" });
		expect(container.querySelector("[data-app-renderer]")).toBeNull();
		expect(container.textContent).toContain("Sales dashboard is unavailable");
		expect(container.textContent).toContain("(401)");
		expect(container.textContent).toContain(RESOURCE_URI);
	});

	it("advertises and delegates no permissions when the resource requests none", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(resourcePayload()));
		await renderFrame();
		const sandbox = renderer.props?.sandbox as { url: URL };
		expect(sandbox.url.searchParams.has("permissions")).toBe(false);
		expect(renderer.bridges.at(-1)?.constructorArgs[2]).not.toHaveProperty(
			"sandbox",
		);
	});

	it("relays onCallTool through POST /widgets/mcp with the allowlisted method", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(resourcePayload()));
		await renderFrame();
		const onCallTool = renderer.bridges.at(-1)?.oncalltool as (
			params: unknown,
			extra: unknown,
		) => Promise<unknown>;
		const toolResult = { content: [{ type: "text", text: "ok" }] };
		fetchMock.mockResolvedValueOnce(jsonResponse(toolResult));
		const result = await onCallTool(
			{
				name: "list_skills",
				arguments: { limit: 5 },
			},
			{ mcpReq: { signal: undefined } },
		);
		expect(result).toEqual(toolResult);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"/widgets/mcp",
			expect.objectContaining({
				method: "POST",
				credentials: "include",
				body: JSON.stringify({
					app: APP_SLUG,
					method: "tools/call",
					params: { name: "list_skills", arguments: { limit: 5 } },
				}),
			}),
		);
	});

	it("acknowledges widget state writes (ui/update-model-context) instead of -32601", async () => {
		// Without a registered handler, the guest
		// setWidgetState got a method-not-found and silently no-opped in the
		// canvas gadget preview. The host must answer every update.
		fetchMock.mockResolvedValue(jsonResponse(resourcePayload()));
		const observed: unknown[] = [];
		await renderFrame({
			onModelContextUpdate: (params) => observed.push(params),
		});
		const bridge = renderer.bridges.at(-1);
		expect(bridge?.constructorArgs[2]).toMatchObject({
			updateModelContext: { text: {} },
		});
		const onUpdate = bridge?.onupdatemodelcontext;
		expect(onUpdate).toBeTypeOf("function");
		const params = {
			structuredContent: { selected: "row-3" },
			content: [{ type: "text", text: '{"selected":"row-3"}' }],
		};
		await expect(onUpdate?.(params)).resolves.toEqual({});
		expect(observed).toEqual([params]);
	});

	it("acknowledges widget state writes with no listener wired", async () => {
		fetchMock.mockResolvedValue(jsonResponse(resourcePayload()));
		await renderFrame();
		const onUpdate = renderer.bridges.at(-1)?.onupdatemodelcontext;
		await expect(onUpdate?.({ structuredContent: { a: 1 } })).resolves.toEqual(
			{},
		);
	});

	it("relays only supported protocol follow-ups and ignores legacy global messages", async () => {
		fetchMock.mockResolvedValue(jsonResponse(resourcePayload()));
		const onFollowUp = vi.fn();
		await renderFrame({ onFollowUp });
		const handler = renderer.bridges.at(-1)?.onmessage;
		expect(handler).toBeTypeOf("function");
		await expect(
			handler?.({
				role: "user",
				content: [{ type: "text", text: "Record this decision." }],
			}),
		).resolves.toEqual({});
		expect(onFollowUp).toHaveBeenCalledWith("Record this decision.");
		await expect(
			handler?.({
				role: "assistant",
				content: [{ type: "text", text: "Spoof" }],
			}),
		).resolves.toEqual({ isError: true });
		await expect(
			handler?.({
				role: "user",
				content: [{ type: "text", text: "x".repeat(20001) }],
			}),
		).resolves.toEqual({ isError: true });
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						source: "tedix-widget",
						type: "request-follow-up",
						resourceUri: RESOURCE_URI,
						message: "Spoof",
					},
				}),
			);
		});
		expect(onFollowUp).toHaveBeenCalledTimes(1);
	});

	it("surfaces a failed tool relay as a thrown error", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(resourcePayload()));
		await renderFrame();
		const onCallTool = renderer.bridges.at(-1)?.oncalltool as (
			params: unknown,
			extra: unknown,
		) => Promise<unknown>;
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 403));
		await expect(
			onCallTool({ name: "list_skills" }, { mcpReq: { signal: undefined } }),
		).rejects.toThrow(/403/);
	});
});
